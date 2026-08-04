import { RelayClient } from './relay/client.ts';
import { DkgClient } from './dkg/client.ts';
import { Registry } from './registry/store.ts';
import { classify, type Trigger } from './triggers/detect.ts';
import {
  deterministicDistiller,
  kaNameForDigest,
  snapshotSourceSet,
  type Distiller,
} from './distill/deterministic.ts';
import { answerGrounded } from './ask/grounded.ts';
import {
  answerMessage,
  parseReceiptDigest,
  parseReceiptKaName,
  refusalMessage,
  swmReceipt,
  vmReceipt,
} from './receipts/compose.ts';
import { logger } from './log.ts';
import type { DaemonConfig, NostrEvent, OpRecord } from './types.ts';

const CATCHUP_OVERLAP_S = 60;
const CURSOR_SKEW_S = 300;
const DEVNET_CHAIN = 'evm:31337';
const MAINNET_CHAIN = 'base:8453';
/** Per-pubkey `@dkg ask` ceiling — defence-in-depth against one member fanning
 * out expensive scoped SPARQL. Generous for humans; caps a runaway loop. */
const ASK_RATE_LIMIT_PER_MIN = 12;

export class Daemon {
  readonly config: DaemonConfig;
  readonly registry: Registry;
  readonly relay: RelayClient;
  readonly dkg: DkgClient;
  readonly distiller: Distiller;
  #queue: Promise<void> = Promise.resolve();
  #chainId: string | undefined;
  #pollTimer: ReturnType<typeof setInterval> | undefined;
  #pollInFlight = false;

  constructor(
    config: DaemonConfig,
    deps?: { relay?: RelayClient; dkg?: DkgClient; distiller?: Distiller },
  ) {
    this.config = config;
    this.registry = new Registry(config.dbPath);
    this.registry.loadBindings(config.bindings);
    this.relay =
      deps?.relay ??
      new RelayClient({
        httpUrl: config.relayHttpUrl,
        wsUrl: config.relayWsUrl,
        secretKeyHex: config.serviceSecretKeyHex,
        onEvent: (e) => this.enqueue(e),
        onReconnect: () =>
          void this.resync().catch((err) => logger.error('resync failed', { err: String(err) })),
      });
    this.dkg = deps?.dkg ?? new DkgClient({ baseUrl: config.dkgApiUrl, token: config.dkgToken });
    this.distiller = deps?.distiller ?? deterministicDistiller;
  }

  /** Serialize event handling — ordering and dedup stay deterministic. */
  enqueue(event: NostrEvent): void {
    this.#queue = this.#queue
      .then(() => this.handleEvent(event))
      .catch((err) =>
        logger.error('event handling failed', { eventId: event.id, err: String(err) }),
      );
  }

  /** Wait for all queued events to be processed (tests + shutdown). */
  drain(): Promise<void> {
    return this.#queue;
  }

  async start(): Promise<void> {
    const st = await this.dkg.status();
    this.#chainId = st.chain?.chainId;
    logger.info('dkg node', {
      version: st.version,
      chainId: this.#chainId,
      publishMode: this.config.publishMode,
    });
    if (this.config.publishMode === 'devnet' && this.#chainId !== DEVNET_CHAIN) {
      throw new Error(
        `publishMode=devnet requires chain ${DEVNET_CHAIN}, node reports '${this.#chainId}' — refusing to start`,
      );
    }
    if (this.config.publishMode === 'mainnet' && this.#chainId !== MAINNET_CHAIN) {
      throw new Error(
        `publishMode=mainnet requires chain ${MAINNET_CHAIN}, node reports '${this.#chainId}' — refusing to start`,
      );
    }
    // Verify every bound context graph exists before serving (§7.2 fail early).
    // Narrow per-CG probe — the broad list route 500s on scan budget for
    // large production nodes (observed live in Gate D2 preflight).
    for (const b of this.config.bindings) {
      // Fail closed: a probe FAILURE and a definitive "absent" both block
      // startup, but with distinct messages so the operator isn't sent after the
      // wrong problem. (Proceeding on a probe error would defeat the fail-early
      // binding check entirely — review R3.)
      let ex: { exists: boolean };
      try {
        ex = await this.dkg.contextGraphExists(b.contextGraphId);
      } catch (err) {
        throw new Error(
          `could not verify bound context graph '${b.contextGraphId}' on the DKG node ` +
            `(presence probe errored: ${String(err).slice(0, 160)}) — refusing to start`,
        );
      }
      if (!ex.exists) {
        throw new Error(`bound context graph '${b.contextGraphId}' not present on the DKG node`);
      }
    }
    await this.recover();
    // Startup catch-up is an optimization, not a hard requirement: a transient
    // relay hiccup (rate-limit / replay-check / reconnect) must not abort start,
    // since the live WS subscription and reconnect-time replay backfill the gap.
    try {
      await this.catchUp();
    } catch (err) {
      logger.warn('startup catch-up failed; continuing on live subscription', {
        err: String(err),
      });
    }
    this.subscribe();
    this.relay.connect();
    // Safety net for relay deployments whose live WS fan-out fails to deliver
    // to HTTP-bridge-authenticated subscribers (observed against buzz-relay
    // 63496cc: `relay ws connected`, zero events ever pushed): poll the stored
    // history through the HTTP catch-up path. Dedup makes replay free, so a
    // missed live event is delayed by at most one interval instead of waiting
    // for an operator restart. Disabled by default (0) — live fan-out plus
    // reconnect replay is the primary path.
    if (this.config.pollIntervalS > 0) {
      this.#pollTimer = setInterval(() => {
        if (this.#pollInFlight) return;
        this.#pollInFlight = true;
        void this.catchUp()
          .catch((err) => logger.warn('poll catch-up failed', { err: String(err) }))
          .finally(() => (this.#pollInFlight = false));
      }, this.config.pollIntervalS * 1000);
      this.#pollTimer.unref?.();
    }
    logger.info('daemon started', {
      servicePubkey: this.relay.pubkey,
      channels: this.config.bindings.length,
      pollIntervalS: this.config.pollIntervalS,
    });
  }

  subscribe(): void {
    const channels = this.config.bindings.map((b) => b.channelId);
    const since = Math.max(0, this.registry.cursor - CATCHUP_OVERLAP_S);
    this.relay.subscribe('bdi-msgs', [{ kinds: [9, 40002, 40004], '#h': channels, since }]);
    // Reactions carry no h tag as signed, but the relay derives their channel
    // from the target and its #h filter matching falls back to that stored
    // channel (buzz-core filter.rs) — AND live fan-out only consults
    // channel-scoped subscription indexes, so a kinds-only sub never sees
    // reactions (observed live in the Gate C acceptance run). #h is required.
    this.relay.subscribe('bdi-reactions', [{ kinds: [7], '#h': channels, since }]);
  }

  /**
   * On reconnect: retry parked CAPTURE ops in-process (a transient relay 503
   * otherwise leaves a pin with no receipt until an operator restarts — review
   * #19), then replay missed events. Deliberately does NOT touch publish-stage
   * ops ('publishing'/'published'): those spend real money and are resolved only
   * by boot recovery or a fresh human ✅, never on this concurrent path.
   */
  async resync(): Promise<void> {
    await this.drain(); // serialize behind any in-flight handler
    const captureStates = new Set(['distilled', 'wm_written', 'finalized', 'shared']);
    for (const op of this.registry.pendingOps()) {
      if (!captureStates.has(op.state)) continue;
      logger.info('reconnect: retrying parked capture', { opId: op.id, state: op.state });
      await this.executeOp(op).catch((err) =>
        logger.error('reconnect capture retry failed', { opId: op.id, err: String(err) }),
      );
    }
    await this.catchUp();
  }

  /** Replays stored events missed while offline; dedup makes replay safe. */
  async catchUp(): Promise<void> {
    const since = Math.max(0, this.registry.cursor - CATCHUP_OVERLAP_S);
    const channels = this.config.bindings.map((b) => b.channelId);
    const stored = await this.relay.query([
      { kinds: [9, 40002, 40004], '#h': channels, since },
      { kinds: [7], '#h': channels, since },
    ]);
    stored.sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
    logger.info('catch-up', { since, events: stored.length });
    for (const e of stored) this.enqueue(e);
    await this.drain();
  }

  /** Resume pending operations and asks after a crash/restart. */
  async recover(): Promise<void> {
    for (const op of this.registry.pendingOps()) {
      logger.info('recovering op', { opId: op.id, kaName: op.kaName, state: op.state });
      await this.executeOp(op).catch((err) =>
        logger.error('op recovery failed', { opId: op.id, err: String(err) }),
      );
    }
    for (const ask of this.registry.pendingAsks()) {
      logger.info('recovering ask', { askEventId: ask.askEventId });
      const events = await this.relay.query([{ ids: [ask.askEventId] }]);
      const event = events[0];
      if (event) {
        const trigger = classify(event, {
          servicePubkey: this.relay.pubkey,
          mentionHandle: this.config.mentionHandle,
        });
        if (trigger?.type === 'ask')
          await this.executeAsk(trigger.event, trigger.channelId, trigger.question, true).catch(
            (err) =>
              logger.error('ask recovery failed', { askEventId: ask.askEventId, err: String(err) }),
          );
      }
    }
  }

  async handleEvent(event: NostrEvent): Promise<void> {
    const trigger = classify(event, {
      servicePubkey: this.relay.pubkey,
      mentionHandle: this.config.mentionHandle,
    });
    // `created_at` is client-set; a single event dated far in the future would
    // otherwise pin the MAX-cursor forever, so every subsequent `since` filters
    // in the future and silently matches nothing. Clamp to a small skew window.
    const nowS = Math.floor(Date.now() / 1000);
    this.registry.advanceCursor(Math.min(event.created_at, nowS + CURSOR_SKEW_S));
    if (!trigger) return;
    switch (trigger.type) {
      case 'pin':
      case 'distill':
        return this.handleCapture(trigger);
      case 'approval':
        return this.handleApproval(trigger);
      case 'ask':
        return this.executeAsk(trigger.event, trigger.channelId, trigger.question, false);
    }
  }

  // ── capture: trigger → snapshot → distill → WM → SWM → receipt ─────────────

  async handleCapture(
    trigger: Extract<Trigger, { type: 'pin' | 'distill' }> & object,
  ): Promise<void> {
    const { event, channelId, targetEventId } = trigger;
    const contextGraphId = this.registry.contextGraphFor(channelId);
    if (!contextGraphId) {
      logger.warn('capture in unmapped channel rejected', { channelId, eventId: event.id });
      return;
    }
    const existing = this.registry.opByTrigger(event.id);
    if (existing) {
      logger.info('trigger dedup', { triggerEventId: event.id, opId: existing.id });
      return;
    }
    const thread = await this.relay.fetchThread(channelId, targetEventId);
    const events = snapshotSourceSet(thread, event, this.relay.pubkey);
    if (!events.length) {
      logger.warn('empty source snapshot; ignoring trigger', { triggerEventId: event.id });
      return;
    }
    const { rootUri, digest, title } = this.distiller.distill({
      channelId,
      events,
      servicePubkey: this.relay.pubkey,
    });
    const op = this.registry.claimTrigger({
      triggerEventId: event.id,
      triggerKind: event.kind,
      channelId,
      contextGraphId,
      rootEventId: targetEventId,
      digest,
      kaName: kaNameForDigest(digest),
      rootUri,
      title,
    });
    if (!op) {
      logger.info('trigger raced; already claimed', { triggerEventId: event.id });
      return;
    }
    await this.executeOp(op, events);
  }

  /**
   * Forward-only executor with read-back recovery. Steps are safe to resume:
   * quads are fully deterministic (identical triples are set-idempotent in the
   * store), finalize/share are skipped when the descriptor already shows
   * 'promoted', and receipts are searched for on the relay before re-posting.
   */
  async executeOp(op: OpRecord, snapshot?: NostrEvent[]): Promise<void> {
    // A crash left this op reserved-but-not-resolved around the on-chain call.
    // We cannot know whether the tx confirmed (the descriptor can't tell us), and
    // must NOT re-publish without a fresh human ✅ (that bypasses every §6 gate).
    // Record it honestly and leave retrying to a new capture (review R1 + R2).
    if (op.state === 'publishing') {
      return this.markUnconfirmed(op, 'the process restarted while a publish was in flight');
    }
    // Publish confirmed but the VM receipt never posted (crash in between) —
    // safe to resume: re-post the receipt (read-back guards against a double).
    if (op.state === 'published') {
      return this.postVmReceipt(op.id, await this.approverPubkeyFor(op));
    }
    let events = snapshot;
    const ensureSnapshot = async (): Promise<NostrEvent[]> => {
      if (events) return events;
      const triggerEvents = await this.relay.query([{ ids: [op.triggerEventId] }]);
      const trigger = triggerEvents[0];
      if (!trigger) throw new Error(`trigger event ${op.triggerEventId} no longer readable`);
      const thread = await this.relay.fetchThread(op.channelId, op.rootEventId);
      events = snapshotSourceSet(thread, trigger, this.relay.pubkey);
      return events;
    };

    try {
      if (op.state === 'distilled') {
        const { digest, quads } = this.distiller.distill({
          channelId: op.channelId,
          events: await ensureSnapshot(),
          servicePubkey: this.relay.pubkey,
        });
        if (digest !== op.digest) {
          // Source events were deleted/hidden since the trigger (Buzz is not
          // append-only). Fail closed rather than distill something unapproved.
          this.registry.transition(op.id, 'failed', { error: 'source set changed since trigger' });
          return;
        }
        // wm/write auto-creates the KA lifecycle record when absent (verified
        // in routes/knowledge-assets.ts) — no separate create step to recover.
        await this.dkg.write(op.kaName, op.contextGraphId, quads);
        this.registry.transition(op.id, 'wm_written');
        op = this.registry.opByTrigger(op.triggerEventId)!;
      }

      if (op.state === 'wm_written' || op.state === 'finalized') {
        const desc = await this.dkg.descriptor(op.kaName, op.contextGraphId).catch(() => null);
        if (desc && desc.state === 'promoted') {
          // Read-back: a previous run already finalized+shared.
          this.registry.transition(op.id, 'shared', { assertion_uri: desc.assertionGraph ?? null });
        } else {
          if (op.state === 'wm_written') {
            const fin = await this.dkg.finalize(op.kaName, op.contextGraphId);
            this.registry.transition(op.id, 'finalized', { assertion_uri: fin.assertionUri });
          }
          await this.dkg.share(op.kaName, op.contextGraphId);
          this.registry.transition(op.id, 'shared');
        }
        op = this.registry.opByTrigger(op.triggerEventId)!;
      }

      if (op.state === 'shared') {
        // Scoped read-back proof before receipting (§4.6). Subject-scoped
        // SELECT with client-side digest match: a constant
        // buzz#sourceSetDigest predicate in the SWM view tripped a node-side
        // "fetch failed" 500 on production (observed live). Read-only, so a
        // bounded retry is safe — the store can transiently 500 under
        // durable-sync load.
        let rows: any[] = [];
        for (let attempt = 1; ; attempt++) {
          try {
            const q = await this.dkg.query({
              sparql: `SELECT ?p ?o WHERE { <${op.rootUri}> ?p ?o }`,
              contextGraphId: op.contextGraphId,
              view: 'shared-working-memory',
            });
            rows = q.result?.bindings ?? [];
            break;
          } catch (err) {
            if (attempt >= 4) throw err;
            logger.warn('SWM read-back query flaked; retrying', {
              opId: op.id,
              attempt,
              err: String(err).slice(0, 120),
            });
            await new Promise((r) => setTimeout(r, attempt * 3000));
          }
        }
        const val = (x: any): string => String(typeof x === 'string' ? x : (x?.value ?? ''));
        const ok = rows.some(
          (r: any) => val(r.p).includes('sourceSetDigest') && val(r.o).includes(op.digest),
        );
        if (!ok) throw new Error('SWM read-back did not confirm the shared digest');

        const receiptId =
          (await this.findExistingReceipt(op)) ??
          (
            await this.relay.sendMessage(
              op.channelId,
              swmReceipt(
                { ...op, assertionUri: op.assertionUri },
                this.explorerUrlFor(op.channelId),
              ),
              {
                replyTo: op.rootEventId,
              },
            )
          ).eventId;
        this.registry.transition(op.id, 'receipted', { receipt_event_id: receiptId });
        logger.info('SWM receipt posted', { opId: op.id, receiptId, kaName: op.kaName });
      }
    } catch (err) {
      logger.error('op execution failed; will retry on next recovery', {
        opId: op.id,
        err: String(err),
      });
      throw err;
    }
  }

  /** Per-binding explorer link base, falling back to the global config value. */
  explorerUrlFor(channelId: string): string | undefined {
    return (
      this.config.bindings.find((b) => b.channelId === channelId)?.explorerUrl ??
      this.config.explorerUrl
    );
  }

  /** Read-back before retry (§9): find a receipt we may have posted pre-crash. */
  async findExistingReceipt(op: OpRecord): Promise<string | null> {
    const mine = await this.relay.query([
      { kinds: [9], '#h': [op.channelId], '#e': [op.rootEventId], authors: [this.relay.pubkey] },
    ]);
    const hit = mine.find((m) => m.content.includes(`trigger: ${op.triggerEventId}`));
    return hit?.id ?? null;
  }

  // ── approval: §6 invariants in code, then (devnet-only) publish ────────────

  async handleApproval(trigger: Extract<Trigger, { type: 'approval' }> & object): Promise<void> {
    const { event, targetEventId, emoji } = trigger;
    if (emoji !== this.config.approvalEmoji) return;
    const op = this.registry.opByReceipt(targetEventId);
    if (!op) return; // reaction to something that is not our receipt (§6.2)

    if (this.registry.approvalOutcome(event.id)) {
      logger.info('approval dedup', { approvalEventId: event.id });
      return;
    }

    // A promoter reacts ✅ and otherwise cannot tell "accepted" from "not
    // authorised"/"budget exhausted"/"relay blip". Post the reason to the room.
    // Transient reasons (a momentary unreadable receipt/descriptor) do NOT write
    // a permanent 'rejected' row, so a retry — the same reaction re-delivered on
    // reconnect, or a fresh ✅ — can still succeed once the blip clears.
    const reject = async (
      reason: string,
      opts: { transient?: boolean; postToRoom?: boolean } = {},
    ): Promise<void> => {
      const { transient = false, postToRoom = true } = opts;
      if (!transient) this.registry.recordApproval(event.id, op.id, 'rejected', reason);
      logger.warn('approval rejected', {
        approvalEventId: event.id,
        opId: op.id,
        reason,
        transient,
      });
      if (postToRoom) {
        await this.relay
          .sendMessage(
            op.channelId,
            transient
              ? `Couldn't process that ✅ right now (${reason}). Re-add the reaction to retry.`
              : `Can't publish that: ${reason}.`,
            { replyTo: op.receiptEventId ?? op.rootEventId },
          )
          .catch((err) =>
            logger.warn('reject notice post failed', { opId: op.id, err: String(err) }),
          );
      }
    };

    // §6.1 reactor authorized for that channel — stay silent in-room so an
    // unauthorized reactor can't make the bot chatter (no info leak either).
    if (!this.registry.promotersFor(op.channelId).includes(event.pubkey)) {
      return reject('reactor is not an authorized promoter for this channel', {
        postToRoom: false,
      });
    }
    // §6.4 channel still maps to the same context graph
    if (this.registry.contextGraphFor(op.channelId) !== op.contextGraphId) {
      return reject('channel↔context-graph mapping changed since capture');
    }
    // §6.3 the receipt identifies the pending KA and digest
    const receiptEvents = await this.relay.query([{ ids: [targetEventId] }]).catch(() => []);
    const receipt = receiptEvents[0];
    if (!receipt) return reject('receipt event no longer readable', { transient: true });
    if (
      parseReceiptDigest(receipt.content) !== op.digest ||
      parseReceiptKaName(receipt.content) !== op.kaName
    ) {
      return reject('receipt content does not match recorded KA/digest');
    }
    // §6.5 finalized SWM KA matches the approved digest. Descriptor state is
    // necessary but NOT sufficient — re-read the shared graph and compare its
    // sourceSetDigest to the approved digest, so approval anchors to the exact
    // content, not just "some promoted SWM KA of this name".
    const desc = await this.dkg.descriptor(op.kaName, op.contextGraphId).catch(() => null);
    if (!desc) return reject('KA descriptor unreadable', { transient: true });
    if (desc.state !== 'promoted' || desc.memoryLayer !== 'SWM') {
      return reject(`KA is not in finalized+shared SWM state (state=${desc.state})`);
    }
    let digestMatches: boolean;
    try {
      digestMatches = await this.swmShareMatchesDigest(op);
    } catch {
      return reject('could not verify the shared KA digest', { transient: true });
    }
    if (!digestMatches) {
      return reject('shared SWM content does not match the approved source-set digest');
    }
    // §6.7 not already published
    if (op.state !== 'receipted' || op.ual)
      return reject('KA already published or in publish flow');
    // §6.8 environment permits publication: mode ↔ chain must agree.
    if (this.config.publishMode === 'disabled') {
      return reject(`publication disabled (publishMode=disabled)`);
    }
    const requiredChain = this.config.publishMode === 'mainnet' ? MAINNET_CHAIN : DEVNET_CHAIN;
    if (this.#chainId !== requiredChain) {
      return reject(
        `connected chain '${this.#chainId}' does not match publishMode=${this.config.publishMode} (requires ${requiredChain})`,
      );
    }
    // Mainnet guardrail: rolling 24 h publication budget (operator-set).
    if (this.config.publishMode === 'mainnet') {
      const recent = this.registry.countRecentPublishes(24 * 60 * 60 * 1000);
      if (recent >= this.config.maxPublishesPerDay) {
        return reject(
          `mainnet publish budget exhausted (${recent}/${this.config.maxPublishesPerDay} in 24h)`,
        );
      }
    }
    // §6.9 stage authorization is the publishMode gate: 'mainnet' exists only
    // because the operator granted standing authority post-D3 (2026-07-27).

    // §6.6 consume exactly once — the INSERT is the atomic claim.
    if (!this.registry.recordApproval(event.id, op.id, 'consumed')) {
      logger.info('approval already consumed', { approvalEventId: event.id });
      return;
    }

    // Reserve the spend BEFORE the on-chain call: persist a 'publishing' intent
    // (counted toward the 24h budget, included in pendingOps) so a crash between
    // publish() and persist can't strand a paid publish outside all accounting.
    this.registry.transition(op.id, 'publishing', { consumed_approval_id: event.id });
    await this.performPublish(op.id, event.pubkey);
  }

  /**
   * Re-read the shared graph and confirm its sourceSetDigest matches the op's
   * approved digest (§6.5). Uses the same subject-scoped SELECT shape as the
   * capture read-back so the anchor is content, not just KA name + state.
   */
  async swmShareMatchesDigest(op: OpRecord): Promise<boolean> {
    const q = await this.dkg.query({
      sparql: `SELECT ?p ?o WHERE { <${op.rootUri}> ?p ?o }`,
      contextGraphId: op.contextGraphId,
      view: 'shared-working-memory',
    });
    const val = (x: any): string => String(typeof x === 'string' ? x : (x?.value ?? ''));
    return (q.result?.bindings ?? []).some(
      (r: any) => val(r.p).includes('sourceSetDigest') && val(r.o).includes(op.digest),
    );
  }

  /**
   * Call vm/publish for a reserved ('publishing') op and announce the UAL — but
   * ONLY on a confirmed publish() response (one that carries a txHash).
   *
   * Critically it does NOT read the descriptor back to decide success: the node
   * stamps state='published' (and a reservedUal) for a TENTATIVE tx too, with no
   * confirmed/tentative discriminator, so a descriptor read would announce an
   * unconfirmed publish as anchored (review R1). Anything that isn't a confirmed
   * response — a 502 tentative, any error, or a response with no txHash — is
   * terminal 'publish_unconfirmed' via markUnconfirmed(): honest note, counted
   * toward the budget (gas may already have been spent), never auto-re-published.
   *
   * Only ever called from handleApproval, i.e. AFTER a human ✅ cleared every §6
   * invariant — never from the boot/recovery path, which must not re-publish
   * without re-attestation (review R2).
   */
  async performPublish(opId: number, approverPubkeyHint?: string): Promise<void> {
    const op = this.registry.opById(opId);
    if (!op || op.state !== 'publishing') return;

    let pub: { ual: string; txHash: string } | undefined;
    try {
      pub = await this.dkg.publish(op.kaName, op.contextGraphId);
    } catch (err) {
      const status = (err as { status?: number }).status;
      return this.markUnconfirmed(
        op,
        status === 502
          ? 'node reported the transaction as tentative'
          : `publish call failed (${String(err).slice(0, 120)})`,
      );
    }
    // A 200 with no confirmed txHash is not a confirmation — never announce it.
    if (!pub?.txHash) {
      return this.markUnconfirmed(op, 'publish response carried no confirmed transaction hash');
    }

    this.registry.transition(op.id, 'published', { ual: pub.ual, tx_hash: pub.txHash });
    const approverPubkey = approverPubkeyHint ?? (await this.approverPubkeyFor(op));
    await this.postVmReceipt(op.id, approverPubkey);
    logger.info('VM publish complete', { opId: op.id, ual: pub.ual, txHash: pub.txHash });
  }

  /**
   * Terminal, honest handling of a publish whose confirmation is unknown. No
   * UAL is announced, the op is counted toward the budget (a tx may have cost
   * real gas), and it is NEVER re-published automatically — retrying requires a
   * fresh human capture + approval, so the message says exactly that (the old
   * "re-add ✅" text pointed at a route the state machine forbids — review's
   * dead-end finding).
   */
  async markUnconfirmed(op: OpRecord, reason: string): Promise<void> {
    this.registry.transition(op.id, 'publish_unconfirmed', {
      error: `vm publish unconfirmed: ${reason}`,
    });
    await this.relay
      .sendMessage(
        op.channelId,
        `VM publish did not return a confirmed result (${reason}); no UAL is being recorded and a transaction may already have been submitted — verify on-chain before relying on it. To retry, re-capture the thread (a new pin or @dkg distill).`,
        { replyTo: op.receiptEventId ?? op.rootEventId },
      )
      .catch(() => {});
    logger.error('vm publish unconfirmed; not announced', { opId: op.id, reason });
  }

  /** Post the VM receipt for a published op and mark it vm_receipted (idempotent on the relay). */
  async postVmReceipt(opId: number, approverPubkey: string): Promise<void> {
    const op = this.registry.opById(opId);
    if (!op || op.state !== 'published') return;
    const existing = await this.findExistingVmReceipt(op);
    const vmReceiptId =
      existing ??
      (
        await this.relay.sendMessage(
          op.channelId,
          vmReceipt(
            op,
            op.consumedApprovalId ?? '',
            approverPubkey,
            this.explorerUrlFor(op.channelId),
          ),
          { replyTo: op.rootEventId },
        )
      ).eventId;
    this.registry.transition(op.id, 'vm_receipted', { vm_receipt_event_id: vmReceiptId });
  }

  /** Read-back before re-posting a VM receipt (§9): find one we may have posted pre-crash. */
  async findExistingVmReceipt(op: OpRecord): Promise<string | null> {
    if (!op.ual) return null;
    const mine = await this.relay
      .query([
        { kinds: [9], '#h': [op.channelId], '#e': [op.rootEventId], authors: [this.relay.pubkey] },
      ])
      .catch(() => []);
    return mine.find((m) => m.content.includes(`UAL: ${op.ual}`))?.id ?? null;
  }

  /** Best-effort approver pubkey for a receipt on recovery (from the stored approval event). */
  async approverPubkeyFor(op: OpRecord): Promise<string> {
    if (!op.consumedApprovalId) return '';
    const ev = await this.relay.query([{ ids: [op.consumedApprovalId] }]).catch(() => []);
    return ev[0]?.pubkey ?? '';
  }

  // ── ask: §7 grounded answering ─────────────────────────────────────────────

  async executeAsk(
    event: NostrEvent,
    channelId: string,
    question: string,
    isRecovery: boolean,
  ): Promise<void> {
    if (!isRecovery && !this.registry.claimAsk(event.id, channelId, event.pubkey)) {
      logger.info('ask dedup', { askEventId: event.id });
      return;
    }
    // `claimAsk` persists a 'pending' row BEFORE any work, and `recover()` runs
    // (before catchUp/subscribe) at every boot — so an unhandled throw here
    // leaves the row pending, gets re-fetched, and re-throws on the next start,
    // bricking the daemon. Resolve the ask on any failure so it never replays.
    try {
      // Per-pubkey rate limit (defence-in-depth). The claim above already
      // counted this ask, so the check is inclusive.
      if (
        !isRecovery &&
        this.registry.recentAskCountByPubkey(event.pubkey, 60_000) > ASK_RATE_LIMIT_PER_MIN
      ) {
        const { eventId } = await this.relay.sendMessage(
          channelId,
          'Too many questions in a short window — please wait a moment before asking again.',
          { replyTo: event.id },
        );
        this.registry.resolveAsk(event.id, 'refused', eventId);
        logger.warn('ask rate-limited', { askEventId: event.id, pubkey: event.pubkey });
        return;
      }
      const contextGraphId = this.registry.contextGraphFor(channelId);
      if (!contextGraphId) {
        const { eventId } = await this.relay.sendMessage(
          channelId,
          'This channel has no designated context graph; I cannot answer here.',
          { replyTo: event.id },
        );
        this.registry.resolveAsk(event.id, 'refused', eventId);
        return;
      }
      const result = await answerGrounded(this.dkg, contextGraphId, question);
      if (result.kind === 'refusal') {
        const { eventId } = await this.relay.sendMessage(
          channelId,
          refusalMessage(question, contextGraphId),
          {
            replyTo: event.id,
          },
        );
        this.registry.resolveAsk(event.id, 'refused', eventId);
        logger.info('ask refused (no supporting evidence)', { askEventId: event.id });
        return;
      }
      const { eventId } = await this.relay.sendMessage(
        channelId,
        answerMessage(question, result.text, result.evidence),
        { replyTo: event.id },
      );
      this.registry.resolveAsk(event.id, 'answered', eventId);
      logger.info('ask answered', { askEventId: event.id, citations: result.evidence.length });
    } catch (err) {
      // Resolve (not re-throw) so the pending row is cleared and never replayed.
      this.registry.resolveAsk(event.id, 'refused');
      logger.error('ask failed; resolved as refused to prevent replay', {
        askEventId: event.id,
        err: String(err),
      });
    }
  }

  async stop(): Promise<void> {
    if (this.#pollTimer) clearInterval(this.#pollTimer);
    this.relay.close();
    await this.drain();
    this.registry.close();
  }
}
