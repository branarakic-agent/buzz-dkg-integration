import { describe, expect, it } from 'vitest';
import { nip19 } from 'nostr-tools';
import { loadConfig, normalizePubkey, parseBindings } from '../src/config.ts';
import { classify } from '../src/triggers/detect.ts';
import { questionTerms, MAX_TERMS } from '../src/ask/grounded.ts';
import { kaNameForDigest } from '../src/distill/deterministic.ts';
import { Daemon } from '../src/daemon.ts';
import type { DaemonConfig, NostrEvent } from '../src/types.ts';
import { MockDkg, MockRelay, hexId, makeEvent } from './helpers.ts';
import { thread } from './helpers.ts';
import { sourceSetDigest, snapshotSourceSet } from '../src/distill/deterministic.ts';

const servicePubkey = hexId('service-pubkey');
const promoter = hexId('promoter');

// ── config: budget + promoter validation (review #12, #22) ───────────────────

describe('config hardening', () => {
  it('rejects a non-numeric publish budget (fails closed, not open)', () => {
    expect(() =>
      loadConfig({ BDI_DKG_TOKEN: 'x', BDI_MAX_PUBLISHES_PER_DAY: 'unlimited' } as never),
    ).toThrow(/BDI_MAX_PUBLISHES_PER_DAY/);
  });

  it('rejects a non-numeric poll interval (fails closed, not open)', () => {
    expect(() => loadConfig({ BDI_DKG_TOKEN: 'x', BDI_POLL_INTERVAL_S: 'often' } as never)).toThrow(
      /BDI_POLL_INTERVAL_S/,
    );
  });

  it('rejects a positive poll interval below the five-second safety floor', () => {
    expect(() => loadConfig({ BDI_DKG_TOKEN: 'x', BDI_POLL_INTERVAL_S: '0.001' } as never)).toThrow(
      /at least 5 seconds/,
    );
  });

  it('normalizes a hex promoter pubkey and decodes an npub', () => {
    const hex = 'ab'.repeat(32);
    expect(normalizePubkey(hex.toUpperCase(), 'x')).toBe(hex);
    expect(normalizePubkey(nip19.npubEncode(hex), 'x')).toBe(hex);
  });

  it('fails fast on a promoter that is neither hex nor npub', () => {
    const raw = JSON.stringify([{ channelId: 'c', contextGraphId: 'g', promoters: ['not-a-key'] }]);
    expect(() => parseBindings(raw)).toThrow(/not a 64-hex pubkey or npub/);
  });
});

// ── triggers: question cap + bare-distill guard (review #6, nit) ──────────────

describe('trigger classification hardening', () => {
  const opts = { servicePubkey, mentionHandle: 'dkg' };

  it('drops an over-length ask instead of building a giant SPARQL filter', () => {
    const huge = makeEvent({
      kind: 9,
      content: `@dkg ask ${'word '.repeat(400)}`,
      tags: [
        ['h', 'chan'],
        ['p', servicePubkey],
      ],
    });
    expect(classify(huge, opts)).toBeNull();
  });

  it('ignores a bare "@dkg distill" with no referenced thread', () => {
    const bare = makeEvent({
      kind: 9,
      content: '@dkg distill',
      tags: [
        ['h', 'chan'],
        ['p', servicePubkey],
      ],
    });
    expect(classify(bare, opts)).toBeNull();
  });
});

describe('grounded retrieval bounds', () => {
  it('caps the term set that drives O(n^2) pair building', () => {
    const q = Array.from({ length: 40 }, (_, i) => `term${i}`).join(' ');
    expect(questionTerms(q)).toHaveLength(MAX_TERMS);
  });
});

// ── daemon: §6.5 digest recheck, ask replay-safety, publish recovery ─────────

function setup(overrides: Partial<DaemonConfig> = {}) {
  const relay = new MockRelay(servicePubkey);
  const dkg = new MockDkg();
  const config: DaemonConfig = {
    relayHttpUrl: 'http://mock',
    relayWsUrl: 'ws://mock',
    serviceSecretKeyHex: '11'.repeat(32),
    mentionHandle: 'dkg',
    dkgApiUrl: 'http://mock',
    dkgToken: 'mock',
    approvalEmoji: '✅',
    publishMode: 'devnet',
    maxPublishesPerDay: 5,
    pollIntervalS: 0,
    dbPath: ':memory:',
    bindings: [{ channelId: 'chan', contextGraphId: 'devnet-test', promoters: [promoter] }],
    ...overrides,
  };
  const daemon = new Daemon(config, { relay: relay.asRelay(), dkg: dkg.asDkg() });
  return { daemon, relay, dkg };
}

function pinnedThread(relay: MockRelay) {
  const events = thread('chan', ['Q: store backend?', 'DECISION: oxigraph-server']);
  const pin = makeEvent({
    kind: 40004,
    tags: [
      ['h', 'chan'],
      ['e', events[0]!.id],
    ],
  });
  relay.ingest(...events, pin);
  const digest = sourceSetDigest(snapshotSourceSet([...events], pin, servicePubkey));
  return { pin, digest };
}

async function run(daemon: Daemon, ...events: NostrEvent[]) {
  for (const e of events) daemon.enqueue(e);
  await daemon.drain();
}

describe('daemon approval hardening (review #14)', () => {
  it('§6.5 rejects when the shared SWM digest no longer matches the approved digest', async () => {
    const { daemon, relay, dkg } = setup();
    const { pin, digest } = pinnedThread(relay);
    await daemon.start();
    await run(daemon, pin);
    const receiptId = relay.sent[0]!.eventId;
    const kaName = kaNameForDigest(digest);

    // Tamper the shared graph's stored digest AFTER the receipt — descriptor
    // state stays 'promoted'/SWM, so only the content re-check can catch it.
    const q = dkg.kas.get(kaName)!.quads.find((x) => x.predicate.includes('sourceSetDigest'))!;
    q.object = JSON.stringify('deadbeef'.repeat(8));

    const approval = makeEvent({
      kind: 7,
      pubkey: promoter,
      content: '✅',
      tags: [['e', receiptId]],
    });
    relay.ingest(approval);
    await run(daemon, approval);

    expect(dkg.kas.get(kaName)!.publishes).toBe(0);
    expect(daemon.registry.approvalOutcome(approval.id)?.outcome).toBe('rejected');
    expect(daemon.registry.approvalOutcome(approval.id)).toBeTruthy();
  });
});

describe('daemon ask replay-safety (review #6)', () => {
  it('an ask that throws is resolved (not left pending) so it never replays on boot', async () => {
    const { daemon, relay, dkg } = setup();
    await daemon.start();
    const ask = makeEvent({
      kind: 9,
      content: '@dkg ask what did we decide?',
      tags: [
        ['h', 'chan'],
        ['p', servicePubkey],
      ],
    });
    relay.ingest(ask);
    // Force the retrieval path to throw.
    dkg.query = (async () => {
      throw new Error('node 500 (simulated)');
    }) as never;
    await run(daemon, ask);
    // No pending ask remains → recover() will not replay it.
    expect(daemon.registry.pendingAsks()).toHaveLength(0);
  });
});

describe('daemon publish-path regressions (review R1/R2)', () => {
  it('recovery of an in-flight "publishing" op never re-publishes and never announces a UAL', async () => {
    const { daemon, relay, dkg } = setup();
    const { pin, digest } = pinnedThread(relay);
    await daemon.start();
    await run(daemon, pin);
    const receiptId = relay.sent[0]!.eventId;
    const kaName = kaNameForDigest(digest);
    const op = daemon.registry.opByReceipt(receiptId)!;

    // Crash left the op reserved. The node even stamped state='published' — as
    // it does for a TENTATIVE tx too — so a descriptor read would falsely
    // "confirm" it (R1), and re-publishing would bypass every §6 gate (R2).
    const approval = makeEvent({
      kind: 7,
      pubkey: promoter,
      content: '✅',
      tags: [['e', receiptId]],
    });
    relay.ingest(approval);
    daemon.registry.transition(op.id, 'publishing', { consumed_approval_id: approval.id });
    dkg.kas.get(kaName)!.state = 'published';

    const sentBefore = relay.sent.length;
    await daemon.recover();

    expect(dkg.kas.get(kaName)!.publishes).toBe(0); // R2: never re-published on boot
    const fresh = daemon.registry.opByTrigger(pin.id)!;
    expect(fresh.state).toBe('publish_unconfirmed'); // R1: not announced from descriptor
    expect(fresh.ual).toBeNull();
    expect(relay.sent.length).toBe(sentBefore + 1);
    expect(relay.sent.at(-1)!.content).not.toContain('UAL:');
  });

  it('a tentative (HTTP 502) publish is never announced, has no dead-end instruction, counts to budget', async () => {
    const { daemon, relay, dkg } = setup({ publishMode: 'mainnet', maxPublishesPerDay: 5 });
    dkg.chainId = 'base:8453';
    const { pin } = pinnedThread(relay);
    await daemon.start();
    await run(daemon, pin);
    const receiptId = relay.sent[0]!.eventId;
    // Node maps a tentative publish to HTTP 502 to avoid a silent downgrade.
    dkg.publish = (async () => {
      const e = new Error('tentative') as Error & { status?: number };
      e.status = 502;
      throw e;
    }) as never;
    const approval = makeEvent({
      kind: 7,
      pubkey: promoter,
      content: '✅',
      tags: [['e', receiptId]],
    });
    relay.ingest(approval);
    await run(daemon, approval);

    const op = daemon.registry.opByTrigger(pin.id)!;
    expect(op.state).toBe('publish_unconfirmed');
    expect(op.ual).toBeNull();
    expect(relay.sent.at(-1)!.content).not.toContain('UAL:');
    expect(relay.sent.at(-1)!.content).not.toMatch(/re-add/i); // the dead-end instruction is gone
    expect(daemon.registry.countRecentPublishes(24 * 60 * 60 * 1000)).toBe(1); // gas may have been spent
  });

  it('a confirmed publish that failed to receipt is resumed (published -> vm_receipted)', async () => {
    const { daemon, relay } = setup();
    const { pin, digest } = pinnedThread(relay);
    await daemon.start();
    await run(daemon, pin);
    const op = daemon.registry.opByReceipt(relay.sent[0]!.eventId)!;
    // Confirmed publish persisted, but the VM-receipt send crashed.
    daemon.registry.transition(op.id, 'publishing', {});
    daemon.registry.transition(op.id, 'published', {
      ual: `did:dkg:evm:31337/0xmock/${kaNameForDigest(digest)}`,
    });
    const sentBefore = relay.sent.length;
    await daemon.recover();
    expect(daemon.registry.opByTrigger(pin.id)!.state).toBe('vm_receipted');
    expect(relay.sent.length).toBe(sentBefore + 1);
    expect(relay.sent.at(-1)!.content).toContain('UAL:');
  });
});

describe('daemon budget accounting (review #11 + 502 follow-up)', () => {
  it('counts both a reserved (publishing) and an unconfirmed publish toward the ceiling', async () => {
    const { daemon, relay } = setup();
    const { pin } = pinnedThread(relay);
    await daemon.start();
    await run(daemon, pin);
    const op = daemon.registry.opByReceipt(relay.sent[0]!.eventId)!;
    daemon.registry.transition(op.id, 'publishing', {});
    expect(daemon.registry.countRecentPublishes(24 * 60 * 60 * 1000)).toBe(1);
    daemon.registry.transition(op.id, 'publish_unconfirmed', {});
    expect(daemon.registry.countRecentPublishes(24 * 60 * 60 * 1000)).toBe(1);
  });
});

describe('daemon start fail-closed (review R3)', () => {
  it('refuses to start when the CG presence probe errors, not just when the CG is absent', async () => {
    const { daemon, dkg } = setup();
    dkg.contextGraphExists = (async () => {
      throw new Error('503 scan-budget');
    }) as never;
    await expect(daemon.start()).rejects.toThrow(/refusing to start/);
  });
});

describe('daemon §6 invariant coverage (review #13)', () => {
  async function captured() {
    const ctx = setup();
    const { pin, digest } = pinnedThread(ctx.relay);
    await ctx.daemon.start();
    await run(ctx.daemon, pin);
    return { ...ctx, pin, digest, receiptId: ctx.relay.sent[0]!.eventId };
  }
  const approve = (receiptId: string) =>
    makeEvent({ kind: 7, pubkey: promoter, content: '✅', tags: [['e', receiptId]] });

  it('§6.3 rejects when the receipt content no longer matches the recorded KA/digest', async () => {
    const { daemon, relay, dkg, receiptId } = await captured();
    const receiptEv = relay.events.find((e) => e.id === receiptId)!;
    receiptEv.content = receiptEv.content.replace(
      /source-digest: sha256:[0-9a-f]{64}/,
      `source-digest: sha256:${'0'.repeat(64)}`,
    );
    const a = approve(receiptId);
    relay.ingest(a);
    await run(daemon, a);
    expect([...dkg.kas.values()].every((k) => k.publishes === 0)).toBe(true);
    expect(daemon.registry.approvalOutcome(a.id)?.outcome).toBe('rejected');
  });

  it('§6.4 rejects when the channel is re-bound to a different context graph', async () => {
    const { daemon, relay, dkg, receiptId } = await captured();
    daemon.registry.loadBindings([
      { channelId: 'chan', contextGraphId: 'different-cg', promoters: [promoter] },
    ]);
    const a = approve(receiptId);
    relay.ingest(a);
    await run(daemon, a);
    expect([...dkg.kas.values()].every((k) => k.publishes === 0)).toBe(true);
    expect(daemon.registry.approvalOutcome(a.id)?.outcome).toBe('rejected');
  });

  it('§6.5 rejects when the descriptor is not in finalized+shared SWM state', async () => {
    const { daemon, relay, dkg, receiptId, digest } = await captured();
    dkg.kas.get(kaNameForDigest(digest))!.state = 'created';
    const a = approve(receiptId);
    relay.ingest(a);
    await run(daemon, a);
    expect([...dkg.kas.values()].every((k) => k.publishes === 0)).toBe(true);
    expect(daemon.registry.approvalOutcome(a.id)?.outcome).toBe('rejected');
  });

  it('§6.7 rejects a ✅ once the op is already past receipted (guards the double-publish window)', async () => {
    const { daemon, relay, dkg, receiptId } = await captured();
    const op = daemon.registry.opByReceipt(receiptId)!;
    // Op recorded as published while the mock KA stays 'promoted', so §6.5 passes
    // and §6.7 is the gate that must reject.
    daemon.registry.transition(op.id, 'publishing', {});
    daemon.registry.transition(op.id, 'published', { ual: 'did:dkg:evm:31337/0xmock/x' });
    const a = approve(receiptId);
    relay.ingest(a);
    await run(daemon, a);
    expect([...dkg.kas.values()].every((k) => k.publishes === 0)).toBe(true);
    expect(daemon.registry.approvalOutcome(a.id)?.outcome).toBe('rejected');
  });
});

describe('daemon cursor hardening (review #17)', () => {
  it('clamps a far-future created_at so the catch-up cursor cannot be poisoned', async () => {
    const { daemon, relay } = setup();
    const future = makeEvent({
      kind: 9,
      content: 'just a normal message',
      created_at: Math.floor(Date.now() / 1000) + 86_400,
      tags: [['h', 'chan']],
    });
    relay.ingest(future);
    await run(daemon, future);
    expect(daemon.registry.cursor).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 300);
  });
});

describe('deferred-item follow-ups (#19, ask rate-limit, #20b)', () => {
  it('retries a parked capture on reconnect, without a restart (#19)', async () => {
    const { daemon, relay, dkg } = setup();
    const { pin } = pinnedThread(relay);
    dkg.failWriteOnce = new Error('503 transient'); // parks the op at 'distilled'
    await daemon.start();
    expect(daemon.registry.opByTrigger(pin.id)?.state).toBe('distilled');
    expect(relay.sent).toHaveLength(0);

    await daemon.resync(); // what onReconnect drives
    expect(daemon.registry.opByTrigger(pin.id)?.state).toBe('receipted');
    expect(relay.sent).toHaveLength(1);
  });

  it('resync never re-publishes or resolves a money-sensitive publish op', async () => {
    const { daemon, relay } = setup();
    const { pin } = pinnedThread(relay);
    await daemon.start();
    await run(daemon, pin);
    const op = daemon.registry.opByReceipt(relay.sent[0]!.eventId)!;
    daemon.registry.transition(op.id, 'publishing', {}); // pretend a publish is in flight
    await daemon.resync();
    // resync skips publish-stage ops entirely — left untouched for boot recovery / a fresh ✅
    expect(daemon.registry.opByTrigger(pin.id)!.state).toBe('publishing');
  });

  it('rate-limits a pubkey that floods @dkg ask', async () => {
    const { daemon, relay } = setup();
    await daemon.start();
    const asker = hexId('flooder');
    const asks = Array.from({ length: 13 }, (_, i) =>
      makeEvent({
        kind: 9,
        pubkey: asker,
        content: `@dkg ask question number ${i}?`,
        tags: [
          ['h', 'chan'],
          ['p', servicePubkey],
        ],
      }),
    );
    for (const a of asks) relay.ingest(a);
    await run(daemon, ...asks);
    const last = relay.sent.at(-1)!;
    expect(last.replyTo).toBe(asks[12]!.id);
    expect(last.content).toMatch(/Too many questions/);
  });

  it('receipts carry a human summary line and the VM receipt carries the tx hash (#20b)', async () => {
    const ctx = setup({ publishMode: 'mainnet', maxPublishesPerDay: 5 });
    ctx.dkg.chainId = 'base:8453';
    const { pin } = pinnedThread(ctx.relay);
    await ctx.daemon.start();
    await run(ctx.daemon, pin);
    expect(ctx.relay.sent[0]!.content).toMatch(
      /^🟡 Captured .*Distilled to Shared Working Memory — visible to this channel's members, off-chain\./,
    );

    const approval = makeEvent({
      kind: 7,
      pubkey: promoter,
      content: '✅',
      tags: [['e', ctx.relay.sent[0]!.eventId]],
    });
    ctx.relay.ingest(approval);
    await run(ctx.daemon, approval);
    const vm = ctx.relay.sent[1]!.content;
    expect(vm).toMatch(
      /^🟢 Published .*Published to Verifiable Memory — anchored on-chain, publicly resolvable\./,
    );
    expect(vm).toContain('tx: 0xtx');
    expect(vm).toContain('UAL:');
  });

  it('an answer cites only [1] and lists the rest as "Also matched" (#20b)', async () => {
    const { daemon, relay, dkg } = setup();
    const { pin } = pinnedThread(relay);
    await daemon.start();
    await run(daemon, pin);
    const ask = makeEvent({
      kind: 9,
      content: '@dkg ask store backend oxigraph decision?',
      tags: [
        ['h', 'chan'],
        ['p', servicePubkey],
      ],
    });
    relay.ingest(ask);
    dkg.evidence = [
      {
        rootUri: 'urn:buzz-dkg:decision:a',
        name: 'A',
        description: 'DECISION: oxigraph-server is the store backend',
        digest: 'aa'.repeat(32),
      },
      {
        rootUri: 'urn:buzz-dkg:decision:b',
        name: 'B',
        description: 'oxigraph store backend benchmark notes',
        digest: 'bb'.repeat(32),
      },
    ];
    await run(daemon, ask);
    const ans = relay.sent.find((s) => s.replyTo === ask.id)!.content;
    expect(ans).toContain('[1]');
    expect(ans).toContain('Also matched:');
    expect(ans).not.toContain('[2]');
    expect(ans).toContain('sha256:'); // citations are cross-referenceable to the receipt
  });
});
