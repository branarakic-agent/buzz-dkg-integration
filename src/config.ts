import { readFileSync } from 'node:fs';
import { nip19 } from 'nostr-tools';
import type { ChannelBinding, DaemonConfig, PublishMode } from './types.ts';

function required(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const v = env[name];
  if (!v) throw new Error(`missing required env ${name}`);
  return v;
}

/**
 * Promoter identities are stored and compared as 64-char lowercase hex pubkeys
 * (that is the shape signed events carry). Buzz surfaces identities as `npub1…`,
 * so we accept and decode that form too — a wrong-format promoter would
 * otherwise start the daemon cleanly and silently ignore every approval (a
 * `logger.warn` at best). Fail fast instead.
 */
export function normalizePubkey(raw: string, ctx: string): string {
  const v = String(raw).trim();
  if (/^[0-9a-f]{64}$/i.test(v)) return v.toLowerCase();
  if (v.startsWith('npub1')) {
    try {
      const dec = nip19.decode(v);
      if (dec.type === 'npub' && typeof dec.data === 'string') return dec.data.toLowerCase();
    } catch {
      /* fall through to the throw below */
    }
  }
  throw new Error(`${ctx}: '${v.slice(0, 16)}…' is not a 64-hex pubkey or npub1… identity`);
}

/** Last non-comment line — DKG auth.token files carry a comment header. */
export function parseTokenFile(raw: string): string {
  const line = raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .pop();
  if (!line) throw new Error('token file contains no token');
  return line;
}

export function normalizeExplorerUrl(raw: string, ctx: string): string {
  const value = String(raw).trim();
  if (!value || /[\s()<>{}\[\]]/u.test(value)) {
    throw new Error(`${ctx} must be a markdown-safe http(s) URL`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${ctx} must be a valid URL`);
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error(`${ctx} must be an http(s) URL without credentials`);
  }
  if (url.search || url.hash) throw new Error(`${ctx} must not contain a query or fragment`);
  return value.replace(/\/$/, '');
}

/**
 * Channel bindings come from a JSON file (BDI_BINDINGS_PATH):
 *   [{ "channelId": "<uuid>", "contextGraphId": "<cg>", "promoters": ["<hex-pubkey>", ...] }]
 * One Buzz channel ↔ one Context Graph (SPEC §4.3). The daemon never invents
 * mappings; an unmapped channel is rejected everywhere.
 */
export function parseBindings(raw: string): ChannelBinding[] {
  const arr = JSON.parse(raw);
  if (!Array.isArray(arr)) throw new Error('bindings file must be a JSON array');
  const seen = new Set<string>();
  return arr.map((b: any, i: number) => {
    if (!b.channelId || !b.contextGraphId) {
      throw new Error(`bindings[${i}]: channelId and contextGraphId are required`);
    }
    if (seen.has(b.channelId)) throw new Error(`bindings[${i}]: duplicate channelId`);
    seen.add(b.channelId);
    return {
      channelId: String(b.channelId),
      contextGraphId: String(b.contextGraphId),
      promoters: Array.isArray(b.promoters)
        ? b.promoters.map((p: unknown, j: number) =>
            normalizePubkey(String(p), `bindings[${i}].promoters[${j}]`),
          )
        : [],
      ...(b.explorerUrl
        ? { explorerUrl: normalizeExplorerUrl(String(b.explorerUrl), `bindings[${i}].explorerUrl`) }
        : {}),
    };
  });
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DaemonConfig {
  const publishMode = (env.BDI_PUBLISH_MODE ?? 'disabled') as PublishMode;
  if (!['disabled', 'devnet', 'mainnet'].includes(publishMode)) {
    throw new Error(
      `BDI_PUBLISH_MODE must be 'disabled', 'devnet' or 'mainnet', got '${publishMode}'`,
    );
  }
  const dkgToken =
    env.BDI_DKG_TOKEN ?? parseTokenFile(readFileSync(required('BDI_DKG_TOKEN_PATH', env), 'utf8'));
  // The publication budget is the only ceiling on real ETH spend. A bare
  // Number('unlimited') is NaN, and `recent >= NaN` is always false — which
  // would silently remove the ceiling. Fail closed, like publishMode does.
  const maxPublishesPerDay = Number(env.BDI_MAX_PUBLISHES_PER_DAY ?? 5);
  if (!Number.isFinite(maxPublishesPerDay) || maxPublishesPerDay < 0) {
    throw new Error(
      `BDI_MAX_PUBLISHES_PER_DAY must be a non-negative number, got '${env.BDI_MAX_PUBLISHES_PER_DAY}'`,
    );
  }
  const pollIntervalS = Number(env.BDI_POLL_INTERVAL_S ?? 0);
  if (
    !Number.isFinite(pollIntervalS) ||
    pollIntervalS < 0 ||
    (pollIntervalS > 0 && pollIntervalS < 5)
  ) {
    throw new Error(
      `BDI_POLL_INTERVAL_S must be 0 (disabled) or at least 5 seconds, got '${env.BDI_POLL_INTERVAL_S}'`,
    );
  }
  return {
    relayHttpUrl: (env.BDI_BUZZ_HTTP ?? 'http://127.0.0.1:9440').replace(/\/$/, ''),
    relayWsUrl:
      env.BDI_BUZZ_WS ?? (env.BDI_BUZZ_HTTP ?? 'ws://127.0.0.1:9440').replace(/^http/, 'ws'),
    serviceSecretKeyHex: required('BDI_SERVICE_KEY', env),
    mentionHandle: env.BDI_MENTION_HANDLE ?? 'dkg',
    dkgApiUrl: (env.BDI_DKG_API ?? 'http://127.0.0.1:9200').replace(/\/$/, ''),
    dkgToken,
    approvalEmoji: env.BDI_APPROVAL_EMOJI ?? '✅',
    publishMode,
    maxPublishesPerDay,
    pollIntervalS,
    dbPath: env.BDI_DB_PATH ?? './data/daemon.db',
    bindings: parseBindings(readFileSync(required('BDI_BINDINGS_PATH', env), 'utf8')),
    ...(env.BDI_EXPLORER_URL
      ? { explorerUrl: normalizeExplorerUrl(env.BDI_EXPLORER_URL, 'BDI_EXPLORER_URL') }
      : {}),
  };
}
