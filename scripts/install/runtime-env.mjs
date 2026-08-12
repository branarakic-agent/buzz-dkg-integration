import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const RUNTIME_ENV_ORDER = [
  'BUZZ_DKG_APP_DIR',
  'BUZZ_DKG_STATE_DIR',
  'BUZZ_DKG_RUNTIME_UID',
  'BUZZ_DKG_RUNTIME_GID',
  'BDI_BUZZ_HTTP',
  'BDI_BUZZ_WS',
  'BDI_BUZZ_PROBE_HTTP',
  'BDI_DKG_API',
  'BDI_DKG_TOKEN_PATH',
  'BDI_DKG_ROLE',
  'BDI_DKG_NETWORK',
  'BDI_SERVICE_KEY',
  'BDI_BUZZ_OWNER_KEY',
  'BDI_CHANNEL_NAME',
  'BDI_PUBLISH_MODE',
  'BDI_MAX_PUBLISHES_PER_DAY',
  'BDI_AUTO_PROVISION_CHANNELS',
  'BDI_CONTEXT_GRAPH_ACCESS_POLICY',
  'BDI_QUERY_GATEWAY_ENABLED',
  'BDI_QUERY_GATEWAY_BIND',
  'BDI_QUERY_GATEWAY_PORT',
  'BDI_QUERY_GATEWAY_TOKEN',
  'BDI_QUERY_GATEWAY_MAX_BODY_BYTES',
  'BDI_QUERY_GATEWAY_TIMEOUT_MS',
  'BDI_QUERY_GATEWAY_MAX_DKG_CONCURRENT',
  'BDI_QUERY_GATEWAY_MAX_DKG_QUEUE',
  'BDI_QUERY_GATEWAY_CACHE_TTL_MS',
  'BDI_QUERY_GATEWAY_MAX_CACHE_ENTRIES',
  'BUZZ_DKG_RELAY_CONTAINER',
];

export function parseEnvFile(path) {
  if (!existsSync(path)) return {};
  const values = {};
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const at = line.indexOf('=');
    if (at < 1) continue;
    values[line.slice(0, at)] = line.slice(at + 1);
  }
  return values;
}

export function generatedSecrets(prior) {
  return {
    BDI_SERVICE_KEY: prior.BDI_SERVICE_KEY || randomBytes(32).toString('hex'),
    BDI_BUZZ_OWNER_KEY: prior.BDI_BUZZ_OWNER_KEY || randomBytes(32).toString('hex'),
    BDI_QUERY_GATEWAY_TOKEN: prior.BDI_QUERY_GATEWAY_TOKEN || randomBytes(32).toString('hex'),
  };
}

export function serializeRuntimeEnv(values) {
  for (const name of RUNTIME_ENV_ORDER) {
    if (String(values[name] || '').includes('\n')) throw new Error(`${name} contains a newline`);
  }
  return `${RUNTIME_ENV_ORDER.map((name) => `${name}=${values[name]}`).join('\n')}\n`;
}

export function writeRuntimeEnv(context, values) {
  mkdirSync(context.configDir, { recursive: true, mode: 0o700 });
  mkdirSync(context.stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(context.envPath, serializeRuntimeEnv(values), { mode: 0o600 });
  chmodSync(context.envPath, 0o600);
}
