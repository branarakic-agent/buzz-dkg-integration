/** Signed Nostr event as stored/served by the Buzz relay (sig-stripped on reads). */
export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig?: string;
}

/** A quad in the DKG wm/write JSON shape (object = quoted literal or absolute IRI). */
export interface Quad {
  subject: string;
  predicate: string;
  object: string;
  graph?: string;
}

export interface DistillResult {
  rootUri: string;
  activityUri: string;
  digest: string;
  title: string;
  quads: Quad[];
}

/** Operation lifecycle for one trigger → one KA → one receipt. Forward-only. */
export type OpState =
  | 'distilled' // snapshot + quads computed, nothing external yet
  | 'wm_written' // KA created + quads written
  | 'finalized' // sealed
  | 'shared' // full SWM share confirmed
  | 'receipted' // in-thread receipt posted (terminal for SWM flow)
  | 'publishing' // vm/publish intent persisted + budget reserved, BEFORE the call
  | 'published' // VM publish confirmed (devnet only in stage ABC)
  | 'vm_receipted' // VM receipt posted (terminal)
  | 'publish_unconfirmed' // vm/publish outcome not a confirmed response — terminal, counts toward budget (gas may have been spent), never auto-re-published
  | 'failed';

export interface OpRecord {
  id: number;
  triggerEventId: string;
  triggerKind: number;
  channelId: string;
  contextGraphId: string;
  rootEventId: string;
  digest: string;
  kaName: string;
  rootUri: string;
  /** human-readable distilled title, for a leading line on receipts + citations */
  title: string | null;
  assertionUri: string | null;
  state: OpState;
  receiptEventId: string | null;
  ual: string | null;
  txHash: string | null;
  vmReceiptEventId: string | null;
  consumedApprovalId: string | null;
  error: string | null;
}

export interface ChannelBinding {
  channelId: string;
  contextGraphId: string;
  /** npubs (hex) authorized to approve VM publication for this channel (§6.1). */
  promoters: string[];
  /**
   * Optional base URL of a DKG explorer scoped to this channel's Context
   * Graph; when set (or when the global BDI_EXPLORER_URL fallback is),
   * receipts carry a markdown link so clients that render markdown (Buzz
   * desktop) get a click-through into the graph. The anchored machine-readable
   * lines remain unchanged; the lead line and optional trailing link are
   * presentational and are not parsed.
   */
  explorerUrl?: string;
}

export interface EvidenceRecord {
  rootUri: string;
  name: string;
  description: string;
  digest: string | null;
  /** scoped view the record was retrieved from (citations validate in the same view) */
  view?: 'verifiable-memory' | 'shared-working-memory';
}

export type PublishMode = 'disabled' | 'devnet' | 'mainnet';

export interface DaemonConfig {
  relayHttpUrl: string;
  relayWsUrl: string;
  serviceSecretKeyHex: string;
  mentionHandle: string; // e.g. "dkg" — matched as @<handle> in kind-9 content
  dkgApiUrl: string;
  dkgToken: string;
  approvalEmoji: string;
  /**
   * VM publication authority. 'disabled' (default): approvals are recognized,
   * §6 invariants evaluated, but publication is refused. 'devnet': publication
   * only when the node reports the local devnet chain (evm:31337). 'mainnet':
   * publication only when the node reports base:8453, additionally bounded by
   * maxPublishesPerDay — operator-enabled post-D3 (D-gates proved the path;
   * the operator granted standing mainnet authority on 2026-07-27).
   */
  publishMode: PublishMode;
  /** mainnet guardrail: max daemon-initiated publications per rolling 24 h. */
  maxPublishesPerDay: number;
  /**
   * Seconds between HTTP catch-up polls, as a fallback when the relay's live
   * WS fan-out is not delivering. 0 (default) disables polling.
   */
  pollIntervalS: number;
  dbPath: string;
  bindings: ChannelBinding[];
  /** Global explorer base URL fallback for bindings without their own. */
  explorerUrl?: string;
}
