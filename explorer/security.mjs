import { timingSafeEqual } from 'node:crypto';

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
const DEFAULT_DESKTOP_ORIGINS = [
  'http://localhost:1420',
  'http://tauri.localhost',
  'tauri://localhost',
];

function list(raw, fallback = []) {
  return (raw ? raw.split(',') : fallback).map((value) => value.trim()).filter(Boolean);
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function normalizeOrigin(raw) {
  const url = new URL(raw);
  if (!url.host || raw === 'null') throw new Error('opaque origins are not allowed');
  return url.origin === 'null' ? `${url.protocol}//${url.host}` : url.origin;
}

function bearer(req) {
  const value = String(req.headers.authorization || '');
  return value.startsWith('Bearer ') ? value.slice(7) : '';
}

function equalSecret(actual, expected) {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createExplorerSecurity({ bind, port, env = process.env, now = Date.now }) {
  const gateway = !LOOPBACK.has(bind);
  const publicCgs = new Set(list(env.EXPLORER_PUBLIC_CGS));
  const secret = String(env.EXPLORER_GATEWAY_SECRET || '');
  const allowedOrigins = new Set(
    list(env.EXPLORER_ALLOWED_ORIGINS, DEFAULT_DESKTOP_ORIGINS).map((origin) => {
      try {
        return normalizeOrigin(origin);
      } catch {
        throw new Error(`invalid EXPLORER_ALLOWED_ORIGINS entry: ${origin}`);
      }
    }),
  );
  const defaultHosts = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
  const allowedHosts = new Set(
    list(env.EXPLORER_ALLOWED_HOSTS, gateway ? [] : defaultHosts).map((host) => host.toLowerCase()),
  );
  const perMinute = Number(env.EXPLORER_RATE_LIMIT_PER_MINUTE || 120);
  if (!Number.isInteger(perMinute) || perMinute < 1 || perMinute > 10_000) {
    throw new Error('EXPLORER_RATE_LIMIT_PER_MINUTE must be an integer between 1 and 10000');
  }
  if (gateway) {
    if (secret.length < 32) throw new Error('gateway mode requires EXPLORER_GATEWAY_SECRET (32+ characters)');
    if (publicCgs.size === 0) throw new Error('gateway mode requires a non-empty EXPLORER_PUBLIC_CGS allowlist');
    if (allowedHosts.size === 0) throw new Error('gateway mode requires EXPLORER_ALLOWED_HOSTS');
  }

  const buckets = new Map();
  function rateLimit(req) {
    if (!gateway) return;
    const key = req.socket?.remoteAddress || 'unknown';
    const minute = Math.floor(now() / 60_000);
    const current = buckets.get(key);
    const count = current?.minute === minute ? current.count + 1 : 1;
    buckets.set(key, { minute, count });
    if (count > perMinute) throw httpError(429, 'rate limit exceeded');
    if (buckets.size > 2048) {
      for (const [address, bucket] of buckets) if (bucket.minute < minute) buckets.delete(address);
    }
  }

  function cors(req) {
    const origin = req.headers.origin;
    if (!origin) return {};
    let normalized;
    try {
      normalized = normalizeOrigin(origin);
    } catch {
      throw httpError(403, 'origin not allowed');
    }
    if (!allowedOrigins.has(normalized)) throw httpError(403, 'origin not allowed');
    return {
      'access-control-allow-origin': normalized,
      vary: 'Origin',
    };
  }

  function authorize(req, cg, { preflight = false } = {}) {
    const host = String(req.headers.host || '').toLowerCase();
    if (!allowedHosts.has(host)) throw httpError(421, 'host not allowed');
    const headers = cors(req);
    if (preflight) {
      return {
        ...headers,
        'access-control-allow-methods': 'GET, OPTIONS',
        'access-control-allow-headers': 'authorization',
        'access-control-max-age': '600',
      };
    }
    try {
      rateLimit(req);
      if (gateway) {
        if (!publicCgs.has(cg)) throw httpError(404, 'context graph is not served');
        if (!equalSecret(bearer(req), secret)) throw httpError(401, 'gateway authentication required');
      }
    } catch (error) {
      error.headers = headers;
      throw error;
    }
    return headers;
  }

  return { gateway, publicCgs, allowedOrigins, allowedHosts, authorize };
}

export function validateExplorerInput(value, kind) {
  const raw = String(value || '');
  const patterns = {
    cg: /^[A-Za-z0-9._:@/-]{1,256}$/u,
    name: /^[A-Za-z0-9_-]{1,128}$/u,
    pubkey: /^[0-9a-f]{64}$/iu,
    uri: /^[A-Za-z][A-Za-z0-9+.-]*:[^<>"{}|^`\\\s]{1,1000}$/u,
    ual: /^[A-Za-z0-9._:@%+/-]{1,1000}$/u,
  };
  if (!patterns[kind]?.test(raw)) throw httpError(400, `${kind} is invalid`);
  return raw;
}
