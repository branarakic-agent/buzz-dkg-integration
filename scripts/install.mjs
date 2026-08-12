#!/usr/bin/env node

import {
  chmodSync,
  chownSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { getPublicKey } from 'nostr-tools/pure';
import { createInstallContext } from './install/context.mjs';
import { assertManagedDkgPackageLock, DKG_RELEASE_POLICY } from './install/dkg-release.mjs';
import { resolveDkgPlan, SUPPORTED_DKG_NETWORKS } from './install/dkg-plan.mjs';
import {
  probeRelay,
  relayCandidatesFromContainer,
  relayManagementFromContainer,
  relayEndpoints,
} from './install/relay.mjs';
import { generatedSecrets, parseEnvFile, writeRuntimeEnv } from './install/runtime-env.mjs';

export { relayEndpoints };

const installContext = createInstallContext();
const dkgVersion = DKG_RELEASE_POLICY.managedVersion;

function fail(message) {
  throw new Error(message);
}

function executable(command) {
  const result = spawnSync(command, ['--version'], { stdio: 'ignore' });
  return !result.error && result.status === 0;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: options.capture ? 'utf8' : undefined,
    env: options.env || process.env,
    uid: options.uid,
    gid: options.gid,
  });
  if (result.error) fail(`${command}: ${result.error.message}`);
  if (result.status !== 0 && !options.allowFailure) {
    const detail = options.capture ? `: ${(result.stderr || result.stdout || '').trim()}` : '';
    fail(`${command} exited with status ${result.status}${detail}`);
  }
  return result;
}

export function parseArgs(argv) {
  const parsed = { command: argv[0] || 'help' };
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) fail(`${arg} requires a value`);
      i += 1;
      return next;
    };
    if (arg === '--relay') parsed.relay = value();
    else if (arg === '--dkg-api') parsed.dkgApi = value();
    else if (arg === '--dkg-token-path') parsed.dkgTokenPath = value();
    else if (arg === '--dkg-role') parsed.dkgRole = value();
    else if (arg === '--dkg-network') parsed.dkgNetwork = value();
    else if (arg === '--relay-members-enrolled') parsed.relayMembersEnrolled = true;
    else if (arg === '--yes') parsed.yes = true;
    else fail(`unknown argument: ${arg}`);
  }
  if (parsed.dkgRole && !['auto', 'edge', 'core'].includes(parsed.dkgRole)) {
    fail('--dkg-role must be auto, edge, or core');
  }
  if (parsed.dkgNetwork && !SUPPORTED_DKG_NETWORKS.includes(parsed.dkgNetwork)) {
    fail(`--dkg-network must be one of: ${SUPPORTED_DKG_NETWORKS.join(', ')}`);
  }
  return parsed;
}

function dockerRelayCandidates() {
  if (!executable('docker')) return [];
  const ids = run('docker', ['ps', '--format', '{{.ID}}'], { capture: true, allowFailure: true });
  if (ids.status !== 0) return [];
  const candidates = [];
  for (const id of ids.stdout.split(/\s+/).filter((value) => /^[a-f0-9]{12,64}$/i.test(value))) {
    const inspected = run('docker', ['inspect', id], { capture: true, allowFailure: true });
    if (inspected.status !== 0) continue;
    try {
      const container = JSON.parse(inspected.stdout)[0];
      const management = relayManagementFromContainer(container, id);
      candidates.push(
        ...relayCandidatesFromContainer(container).map((candidate) => ({
          ...candidate,
          management,
        })),
      );
    } catch {
      continue;
    }
  }
  const unique = new Map();
  for (const candidate of candidates) {
    const prior = unique.get(candidate.relayUrl);
    if (!prior || prior.probeUrl === prior.relayUrl) {
      unique.set(candidate.relayUrl, candidate);
    }
  }
  return [...unique.values()];
}

async function dkgStatus(api) {
  try {
    const response = await fetch(`${api.replace(/\/$/, '')}/api/status`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return null;
    const status = await response.json();
    if (!['edge', 'core'].includes(status.nodeRole)) return null;
    return status;
  } catch {
    return null;
  }
}

function defaultTokenCandidates(context) {
  const values = [
    context.env.BDI_DKG_TOKEN_PATH,
    join(context.managedDkgHome, 'auth.token'),
    join(context.invokingHome, '.dkg', 'auth.token'),
  ];
  if (context.env.SUDO_USER && context.env.SUDO_USER !== 'root') {
    values.push(join('/home', context.env.SUDO_USER, '.dkg', 'auth.token'));
  }
  return values.filter(Boolean);
}

function npmCommand(context) {
  const bundled = join(context.appDir, 'runtime', 'bin', 'npm');
  if (existsSync(bundled)) return bundled;
  if (executable('npm')) return 'npm';
  fail('npm is unavailable; reinstall buzz-dkg from an official release bundle');
}

function managedDkgEnv(context) {
  const runtimeBin = join(context.appDir, 'runtime', 'bin');
  return {
    ...context.env,
    HOME: context.managedDkgHome,
    // This boundary prevents the managed install from reading or mutating an
    // operator's existing ~/.dkg state.
    DKG_HOME: context.managedDkgHome,
    PATH: `${runtimeBin}:${context.env.PATH || ''}`,
  };
}

function invokingIdentity(context) {
  const currentUid = process.getuid?.() ?? 0;
  const currentGid = process.getgid?.() ?? 0;
  const sudoUid = Number(context.env.SUDO_UID);
  const sudoGid = Number(context.env.SUDO_GID);
  if (Number.isSafeInteger(sudoUid) && sudoUid > 0 && Number.isSafeInteger(sudoGid)) {
    return { uid: sudoUid, gid: sudoGid };
  }
  if (currentUid > 0) return { uid: currentUid, gid: currentGid };
  // Direct root invocation has no calling user. Use the conventional nobody
  // identity rather than executing package lifecycle hooks as uid 0.
  return { uid: 65534, gid: 65534 };
}

function prepareManagedDkg(context, identity) {
  for (const path of [context.stateDir, context.managedDkgRoot, context.managedDkgHome]) {
    mkdirSync(path, { recursive: true, mode: 0o750 });
    chownSync(path, identity.uid, identity.gid);
    chmodSync(path, 0o750);
  }
}

function verifyManagedDkgLock(context) {
  const lock = JSON.parse(readFileSync(join(context.managedDkgRoot, 'package-lock.json'), 'utf8'));
  assertManagedDkgPackageLock(lock);
}

async function waitForDkg(api) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const status = await dkgStatus(api);
    if (status) return status;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  fail(`DKG node did not become ready at ${api}`);
}

async function waitForIntegration(context) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const result = run('docker', composeArgs(context, 'logs', '--no-color', 'daemon'), {
      capture: true,
      allowFailure: true,
    });
    if (result.status === 0 && result.stdout.includes('"message":"daemon started"')) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  fail('integration daemon did not become ready; run sudo buzz-dkg logs');
}

function composeArgs(context, command, ...args) {
  return ['compose', '--env-file', context.envPath, '-f', context.composePath, command, ...args];
}

function composeProfileArgs(context, profile, command, ...args) {
  return [
    'compose',
    '--env-file',
    context.envPath,
    '-f',
    context.composePath,
    '--profile',
    profile,
    command,
    ...args,
  ];
}

function relayComposeArgs(compose, overridePath, includeOverride = true) {
  const configFiles = [...new Set(compose.configFiles.filter((path) => path !== overridePath))];
  const envFiles = [...new Set(compose.envFiles || [])];
  if (!configFiles.length) fail('the adopted relay has no base Compose file to restore');
  return [
    'compose',
    '--project-name',
    compose.project,
    '--project-directory',
    compose.workingDir,
    ...envFiles.flatMap((path) => ['--env-file', path]),
    ...configFiles.flatMap((path) => ['-f', path]),
    ...(includeOverride ? ['-f', overridePath] : []),
    'up',
    '-d',
    '--no-deps',
    compose.service,
  ];
}

function disableManagedRelayDkgProxy(context, management) {
  if (!management?.compose) return false;
  const overridePath = join(context.configDir, 'relay.dkg.override.yml');
  console.log('Disabling the managed DKG proxy and restarting the Buzz Relay...');
  run('docker', relayComposeArgs(management.compose, overridePath, false));
  rmSync(overridePath, { force: true });
  return true;
}

async function configureRelayDkgProxy(context, plan, secrets) {
  const management = plan.relayManagement;
  if (!management?.compose) {
    const localContainer = Boolean(management?.containerName || management?.containerId);
    const port = localContainer ? '9297' : '9296';
    console.log('\nRelay DKG proxy requires three relay environment values:');
    console.log(`  BUZZ_DKG_QUERY_URL=http://127.0.0.1:${port}/v1/query`);
    console.log('  BUZZ_DKG_QUERY_TOKEN=<BDI_QUERY_GATEWAY_TOKEN from protected runtime.env>');
    console.log('  BUZZ_DKG_MEMORY_ENABLED=true');
    console.log(
      '  This relay was not discovered as a local Docker Compose service, so the installer cannot apply and restart it automatically.',
    );
    if (!management) {
      console.log(
        '  The loopback URL is valid only for a relay process on this host; a remote relay requires its own co-located Buzz–DKG integration and token.',
      );
    }
    return false;
  }
  if (!management.containerName) {
    fail('the adopted Compose relay has no stable container name for its private query bridge');
  }
  for (const path of management.compose.configFiles) {
    if (!existsSync(path)) fail(`Buzz Relay Compose file is not readable: ${path}`);
  }
  for (const path of management.compose.envFiles || []) {
    if (!existsSync(path)) fail(`Buzz Relay Compose environment file is not readable: ${path}`);
  }
  const overridePath = join(context.configDir, 'relay.dkg.override.yml');
  const service = management.compose.service;
  const yaml = [
    'services:',
    `  ${service}:`,
    '    environment:',
    '      BUZZ_DKG_QUERY_URL: http://127.0.0.1:9297/v1/query',
    `      BUZZ_DKG_QUERY_TOKEN: ${JSON.stringify(secrets.BDI_QUERY_GATEWAY_TOKEN)}`,
    '      BUZZ_DKG_QUERY_TIMEOUT_MS: "120000"',
    '      BUZZ_DKG_MEMORY_ENABLED: "true"',
    '',
  ].join('\n');
  writeFileSync(overridePath, yaml, { mode: 0o600 });
  chmodSync(overridePath, 0o600);
  console.log('Configuring the authenticated DKG proxy and restarting the Buzz Relay...');
  run('docker', relayComposeArgs(management.compose, overridePath));
  let relayInfo;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      relayInfo = await probeRelay(plan.relayProbeHttp);
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  if (!relayInfo) {
    disableManagedRelayDkgProxy(context, management);
    fail('Buzz Relay did not become ready after DKG proxy configuration');
  }
  if (!relayInfo.supportedExtensions.includes('buzz-dkg-memory-v1')) {
    disableManagedRelayDkgProxy(context, management);
    fail(
      'the restarted Buzz Relay does not advertise buzz-dkg-memory-v1; deploy a Buzz build containing the DKG memory proxy, then rerun the installer',
    );
  }
  return true;
}

function showPlan(context, plan) {
  console.log('\nInstallation plan');
  console.log(`  Buzz Relay: ${plan.relay.ws} (adopt in place; preserve identity and database)`);
  console.log(
    `  DKG node:   ${plan.dkgExisting ? `reuse ${plan.dkgRole} at ${plan.dkgApi}` : `install ${plan.dkgRole} ${dkgVersion} on ${plan.network}`}`,
  );
  console.log('  Integration: install projector/provider sidecar with VM publication disabled');
  if (plan.relayManagement?.compose) {
    console.log(
      '  Agent memory: configure the authenticated proxy and restart the local Compose relay',
    );
  } else {
    console.log(
      '  Agent memory: print the two relay proxy values for operator-managed configuration',
    );
  }
  if (plan.relayManagement?.membershipRequired) {
    console.log(
      plan.relayMembersEnrolled
        ? '  Relay access: operator confirms the managed identities are already enrolled'
        : `  Relay access: enroll two managed identities with Buzz's native admin CLI (${plan.relayManagement.containerName || plan.relayManagement.containerId.slice(0, 12)})`,
    );
  } else if (plan.relayManagement) {
    console.log('  Relay access: no managed membership change required');
  } else {
    console.log(
      plan.relayMembersEnrolled
        ? '  Relay access: operator confirms external relay membership is already enrolled'
        : '  Relay access: external/unknown; no automatic membership change',
    );
  }
  console.log(
    '  Memory:      seed Web of Trust; lazily create one private Context Graph per channel',
  );
  console.log(`  State:       ${context.stateDir}`);
  console.log('  Public ports: none added by the integration');
  console.log('  Network:     sidecar uses the Linux host network to reach loopback Buzz/DKG APIs');
}

async function resolvePlan(context, options, prompt) {
  const prior = parseEnvFile(context.envPath);
  const candidates = dockerRelayCandidates();
  let relayCandidate;
  const configuredRelay = options.relay || prior.BDI_BUZZ_WS;
  if (configuredRelay) {
    let configuredEndpoints;
    try {
      configuredEndpoints = relayEndpoints(configuredRelay);
    } catch {
      configuredEndpoints = null;
    }
    const discovered = configuredEndpoints
      ? candidates.find((candidate) => {
          try {
            return relayEndpoints(candidate.relayUrl).ws === configuredEndpoints.ws;
          } catch {
            return false;
          }
        })
      : null;
    relayCandidate = {
      relayUrl: configuredRelay,
      probeUrl:
        discovered?.probeUrl ||
        (options.relay ? configuredRelay : prior.BDI_BUZZ_PROBE_HTTP || configuredRelay),
      management: discovered?.management || null,
    };
  } else {
    if (candidates.length === 1) {
      relayCandidate = candidates[0];
      console.log(`Found Buzz Relay: ${relayCandidate.relayUrl}`);
    } else if (candidates.length > 1) {
      console.log(`Found ${candidates.length} possible Buzz Relays:`);
      candidates.forEach((candidate, index) =>
        console.log(`  ${index + 1}. ${candidate.relayUrl}`),
      );
      const selected = await prompt.question('Select the relay number: ');
      relayCandidate = candidates[Number(selected) - 1];
      if (!relayCandidate) fail('invalid Buzz Relay selection');
    } else if (options.yes) {
      fail('no Buzz Relay was detected; pass --relay <wss-url>');
    } else {
      const relayUrl = await prompt.question('Buzz Relay URL (wss://...): ');
      relayCandidate = { relayUrl, probeUrl: relayUrl };
    }
  }
  const relay = relayEndpoints(relayCandidate.relayUrl);
  const relayProbe = relayEndpoints(relayCandidate.probeUrl);
  await probeRelay(relayProbe.http);

  const dkgApi = (options.dkgApi || prior.BDI_DKG_API || 'http://127.0.0.1:9200').replace(
    /\/$/,
    '',
  );
  const existingStatus = await dkgStatus(dkgApi);
  const requestedRole = options.dkgRole || prior.BDI_DKG_ROLE || 'auto';
  let dkgPlan;
  try {
    dkgPlan = resolveDkgPlan({
      existingStatus,
      requestedRole,
      requestedNetwork: options.dkgNetwork,
      priorNetwork: prior.BDI_DKG_NETWORK,
      unattended: options.yes === true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(message.replace(/^DKG node is /, `DKG node at ${dkgApi} is `));
  }
  return {
    relay,
    relayProbeHttp: relayProbe.http,
    relayManagement: relayCandidate.management || null,
    relayMembersEnrolled: options.relayMembersEnrolled === true,
    dkgApi,
    ...dkgPlan,
  };
}

function publicKey(secretKeyHex) {
  return getPublicKey(Uint8Array.from(Buffer.from(secretKeyHex, 'hex')));
}

const enrollmentPauseMs = 1_100;

async function ensureRelayEnrollment(plan, secrets) {
  const management = plan.relayManagement;
  if (!management?.membershipRequired) return;
  if (plan.relayMembersEnrolled) {
    console.log('Using operator-confirmed Buzz relay membership.');
    return;
  }

  const available = run(
    'docker',
    ['exec', management.containerId, 'test', '-x', '/usr/local/bin/buzz-admin'],
    { capture: true, allowFailure: true },
  );
  if (available.status !== 0) {
    const ownerPubkey = publicKey(secrets.BDI_BUZZ_OWNER_KEY);
    const servicePubkey = publicKey(secrets.BDI_SERVICE_KEY);
    fail(
      `Buzz relay membership is enforced, but ${management.containerName || management.containerId} does not expose /usr/local/bin/buzz-admin; enroll these public keys as relay members with the relay's supported administration path, then rerun with --relay-members-enrolled:\n  DKG channel owner: ${ownerPubkey}\n  DKG Memory service: ${servicePubkey}`,
    );
  }

  const identities = [
    ['DKG channel owner', publicKey(secrets.BDI_BUZZ_OWNER_KEY)],
    ['DKG Memory service', publicKey(secrets.BDI_SERVICE_KEY)],
  ];
  console.log("Enrolling managed identities with Buzz's native admin CLI...");
  for (let index = 0; index < identities.length; index += 1) {
    const [label, pubkey] = identities[index];
    run('docker', [
      'exec',
      management.containerId,
      '/usr/local/bin/buzz-admin',
      'add-member',
      '--pubkey',
      pubkey,
      '--role',
      'member',
    ]);
    console.log(`  enrolled ${label} (${pubkey.slice(0, 12)}...)`);
    // Buzz's roster is a replaceable event. Keep successive native admin
    // writes out of the same second so the second snapshot cannot dominate or
    // collide with the first one.
    if (index + 1 < identities.length) {
      await new Promise((resolve) => setTimeout(resolve, enrollmentPauseMs));
    }
  }

  const listed = run(
    'docker',
    ['exec', management.containerId, '/usr/local/bin/buzz-admin', 'list-members'],
    { capture: true },
  ).stdout.toLowerCase();
  const missing = identities.filter(([, pubkey]) => !listed.includes(pubkey));
  if (missing.length > 0) {
    fail(
      `Buzz relay membership verification failed for ${missing.map(([label]) => label).join(', ')}`,
    );
  }
}

async function ensureDkg(context, plan, prompt, options) {
  if (plan.dkgExisting) return plan.dkgStatus;
  if (!options.yes) {
    const answer = (
      await prompt.question(`No DKG node found. Install a managed ${plan.dkgRole} node? [Y/n] `)
    )
      .trim()
      .toLowerCase();
    if (answer && answer !== 'y' && answer !== 'yes')
      fail('installation cancelled before DKG setup');
  }
  const identity = invokingIdentity(context);
  prepareManagedDkg(context, identity);
  console.log(`Installing @origintrail-official/dkg@${dkgVersion}...`);
  // The pinned DKG package and better-sqlite3 dependency require lifecycle
  // hooks. Execute them as the managed non-root identity, never as installer
  // root, then verify npm's generated lock against the reviewed integrity.
  run(
    npmCommand(context),
    [
      'install',
      '--save-exact',
      '--prefix',
      context.managedDkgRoot,
      `@origintrail-official/dkg@${dkgVersion}`,
    ],
    {
      env: managedDkgEnv(context),
      uid: identity.uid,
      gid: identity.gid,
    },
  );
  verifyManagedDkgLock(context);
  console.log('Starting the supported DKG setup wizard...');
  run(context.managedDkgBin, ['init', '--role', plan.dkgRole, '--network', plan.network], {
    env: managedDkgEnv(context),
    uid: identity.uid,
    gid: identity.gid,
  });
  run(context.managedDkgBin, ['start'], {
    env: managedDkgEnv(context),
    uid: identity.uid,
    gid: identity.gid,
  });
  return waitForDkg(plan.dkgApi);
}

async function resolveTokenPath(context, options, prompt) {
  if (options.dkgTokenPath) return options.dkgTokenPath;
  const prior = parseEnvFile(context.envPath);
  if (prior.BDI_DKG_TOKEN_PATH && existsSync(prior.BDI_DKG_TOKEN_PATH)) {
    return prior.BDI_DKG_TOKEN_PATH;
  }
  const found = defaultTokenCandidates(context).find((candidate) => existsSync(candidate));
  if (found) return found;
  if (options.yes) fail('DKG auth token was not found; pass --dkg-token-path <path>');
  return prompt.question('DKG auth.token path: ');
}

export async function install(options, prompt, context = installContext) {
  if (process.platform !== 'linux' && context.env.BUZZ_DKG_ALLOW_UNSUPPORTED !== '1') {
    fail('Beta V1 supports Linux only');
  }
  if (process.getuid?.() !== 0 && context.env.BUZZ_DKG_ALLOW_NON_ROOT !== '1') {
    fail('run installation with sudo');
  }
  if (!executable('docker')) fail('Docker with the Compose plugin is required');
  const compose = run('docker', ['compose', 'version'], { capture: true, allowFailure: true });
  if (compose.status !== 0) fail('the Docker Compose plugin is required');

  const plan = await resolvePlan(context, options, prompt);
  showPlan(context, plan);
  if (!options.yes) {
    const answer = (await prompt.question('\nContinue? [Y/n] ')).trim().toLowerCase();
    if (answer && answer !== 'y' && answer !== 'yes') fail('installation cancelled');
  }
  const status = await ensureDkg(context, plan, prompt, options);
  const tokenPath = await resolveTokenPath(context, options, prompt);
  if (!existsSync(tokenPath)) fail(`DKG token does not exist: ${tokenPath}`);
  const tokenOwner = statSync(tokenPath);
  // Match the sidecar uid/gid to the credential it must read, and make only the
  // integration state root writable by that identity. The token remains a
  // read-only bind mount and is never copied.
  mkdirSync(context.stateDir, { recursive: true, mode: 0o750 });
  chownSync(context.stateDir, tokenOwner.uid, tokenOwner.gid);
  chmodSync(context.stateDir, 0o750);
  const prior = parseEnvFile(context.envPath);
  const secrets = generatedSecrets(prior);
  writeRuntimeEnv(context, {
    BUZZ_DKG_APP_DIR: context.appDir,
    BUZZ_DKG_STATE_DIR: context.stateDir,
    BUZZ_DKG_RUNTIME_UID: String(tokenOwner.uid),
    BUZZ_DKG_RUNTIME_GID: String(tokenOwner.gid),
    BDI_BUZZ_HTTP: plan.relay.http,
    BDI_BUZZ_WS: plan.relay.ws,
    BDI_BUZZ_PROBE_HTTP: plan.relayProbeHttp,
    BDI_DKG_API: plan.dkgApi,
    BDI_DKG_TOKEN_PATH: tokenPath,
    BDI_DKG_ROLE: status.nodeRole,
    BDI_DKG_NETWORK: plan.network,
    ...secrets,
    BDI_CHANNEL_NAME: 'Web of Trust',
    BDI_PUBLISH_MODE: 'disabled',
    BDI_MAX_PUBLISHES_PER_DAY: '0',
    BDI_AUTO_PROVISION_CHANNELS: 'true',
    BDI_CONTEXT_GRAPH_ACCESS_POLICY: '1',
    BDI_QUERY_GATEWAY_ENABLED: 'true',
    BDI_QUERY_GATEWAY_BIND: '127.0.0.1',
    BDI_QUERY_GATEWAY_PORT: '9296',
    BDI_QUERY_GATEWAY_MAX_BODY_BYTES: String(256 * 1024),
    BDI_QUERY_GATEWAY_TIMEOUT_MS: '120000',
    BDI_QUERY_GATEWAY_MAX_DKG_CONCURRENT: '1',
    BDI_QUERY_GATEWAY_MAX_DKG_QUEUE: '32',
    BDI_QUERY_GATEWAY_CACHE_TTL_MS: '120000',
    BDI_QUERY_GATEWAY_MAX_CACHE_ENTRIES: '256',
    BUZZ_DKG_RELAY_CONTAINER:
      plan.relayManagement?.containerName || plan.relayManagement?.containerId || '',
  });

  await ensureRelayEnrollment(plan, secrets);
  let relayProxyManaged = false;
  try {
    relayProxyManaged = await configureRelayDkgProxy(context, plan, secrets);
    const relayBridgeAvailable = Boolean(
      plan.relayManagement?.containerName || plan.relayManagement?.containerId,
    );

    console.log('Creating or reusing the Web of Trust channel and Context Graph...');
    run('docker', composeArgs(context, 'run', '--rm', 'bootstrap'));
    run(
      'docker',
      relayBridgeAvailable
        ? composeProfileArgs(
            context,
            'bridge-relay',
            'up',
            '-d',
            'daemon',
            'host-query-bridge',
            'relay-query-bridge',
          )
        : composeArgs(context, 'up', '-d', 'daemon'),
    );
    await waitForIntegration(context);
    console.log('Running the end-to-end smoke check...');
    run('docker', composeArgs(context, 'run', '--rm', 'smoke'));
    const bootstrap = JSON.parse(readFileSync(join(context.stateDir, 'bootstrap.json'), 'utf8'));
    console.log('\nBuzz + DKG is ready.');
    console.log(`  Buzz Relay:   ${plan.relay.ws}`);
    console.log(`  DKG node:     ${status.nodeRole} ${status.version || ''}`.trimEnd());
    console.log(`  Channel:      ${bootstrap.channelName} (${bootstrap.channelId})`);
    console.log(`  Context Graph: ${bootstrap.contextGraphId}`);
    console.log(
      relayProxyManaged
        ? '  Agent memory: enabled for authenticated Buzz agents in every channel'
        : '  Agent memory: pending the relay proxy values printed above',
    );
    console.log('\nCommands: sudo buzz-dkg status | logs | smoke | remove');
  } catch (error) {
    const overridePath = join(context.configDir, 'relay.dkg.override.yml');
    if (existsSync(overridePath) && plan.relayManagement?.compose) {
      disableManagedRelayDkgProxy(context, plan.relayManagement);
    }
    throw error;
  }
}

async function plan(context, options, prompt) {
  const resolved = await resolvePlan(context, options, prompt);
  showPlan(context, resolved);
}

async function status(context) {
  const values = parseEnvFile(context.envPath);
  if (!values.BDI_BUZZ_HTTP) fail(`no V1a installation found at ${context.envPath}`);
  console.log(`Buzz Relay: ${values.BDI_BUZZ_WS}`);
  const relay = await probeRelay(values.BDI_BUZZ_PROBE_HTTP || values.BDI_BUZZ_HTTP);
  console.log('  reachable');
  console.log(
    relay.supportedExtensions.includes('buzz-dkg-memory-v1')
      ? '  agent memory proxy: enabled'
      : '  agent memory proxy: not advertised',
  );
  console.log(
    values.BDI_AUTO_PROVISION_CHANNELS === 'true'
      ? '  channel graphs: automatic (private)'
      : '  channel graphs: seeded bindings only',
  );
  const dkg = await dkgStatus(values.BDI_DKG_API);
  console.log(
    dkg
      ? `DKG node:   ${dkg.nodeRole} ${dkg.version || 'unknown'} (${values.BDI_DKG_API})`
      : `DKG node:   unavailable (${values.BDI_DKG_API})`,
  );
  run('docker', composeArgs(context, 'ps'), { allowFailure: true });
  console.log(`State:      ${context.stateDir}`);
}

function logs(context) {
  if (!existsSync(context.envPath)) fail(`no V1a installation found at ${context.envPath}`);
  run('docker', composeArgs(context, 'logs', '--tail', '100', 'daemon'));
}

function smoke(context) {
  if (!existsSync(context.envPath)) fail(`no V1a installation found at ${context.envPath}`);
  run('docker', composeArgs(context, 'run', '--rm', 'smoke'));
}

function identities(context) {
  const values = parseEnvFile(context.envPath);
  if (!values.BDI_BUZZ_OWNER_KEY || !values.BDI_SERVICE_KEY) {
    fail(`no managed Buzz identities found at ${context.envPath}`);
  }
  console.log(`DKG channel owner: ${publicKey(values.BDI_BUZZ_OWNER_KEY)}`);
  console.log(`DKG Memory service: ${publicKey(values.BDI_SERVICE_KEY)}`);
}

function remove(context) {
  if (!existsSync(context.envPath)) fail(`no V1a installation found at ${context.envPath}`);
  const values = parseEnvFile(context.envPath);
  if (values.BUZZ_DKG_RELAY_CONTAINER) {
    const inspected = run('docker', ['inspect', values.BUZZ_DKG_RELAY_CONTAINER], {
      capture: true,
      allowFailure: true,
    });
    if (inspected.status !== 0) {
      fail(
        `cannot inspect managed Buzz Relay '${values.BUZZ_DKG_RELAY_CONTAINER}'; refusing to leave a potentially advertised dead proxy`,
      );
    }
    const container = JSON.parse(inspected.stdout)[0];
    const management = relayManagementFromContainer(container, values.BUZZ_DKG_RELAY_CONTAINER);
    const relayOverride = join(context.configDir, 'relay.dkg.override.yml');
    if (management?.compose && existsSync(relayOverride)) {
      disableManagedRelayDkgProxy(context, management);
    } else {
      const relayEnvironment = new Map(
        (container?.Config?.Env ?? []).map((entry) => {
          const separator = entry.indexOf('=');
          return separator < 0
            ? [entry, '']
            : [entry.slice(0, separator), entry.slice(separator + 1)];
        }),
      );
      const stillAdvertisesProxy =
        relayEnvironment.get('BUZZ_DKG_MEMORY_ENABLED')?.toLowerCase() === 'true' ||
        Boolean(relayEnvironment.get('BUZZ_DKG_QUERY_URL')) ||
        Boolean(relayEnvironment.get('BUZZ_DKG_QUERY_TOKEN'));
      if (stillAdvertisesProxy) {
        fail(
          `Buzz Relay '${values.BUZZ_DKG_RELAY_CONTAINER}' is operator-managed and still advertises the DKG proxy, but its managed override cannot be restored; remove BUZZ_DKG_MEMORY_ENABLED, BUZZ_DKG_QUERY_URL and BUZZ_DKG_QUERY_TOKEN from the relay, restart it, then rerun buzz-dkg remove`,
        );
      }
    }
  }
  run(
    'docker',
    values.BUZZ_DKG_RELAY_CONTAINER
      ? composeProfileArgs(context, 'bridge-relay', 'down')
      : composeArgs(context, 'down'),
  );
  console.log(
    'Buzz–DKG integration stopped. Buzz and retained integration/DKG data were not removed.',
  );
}

function help() {
  console.log(`buzz-dkg — Buzz-first DKG installer preview

Usage:
  buzz-dkg plan [--relay URL] [--dkg-role auto|edge|core] [--dkg-network NETWORK]
  buzz-dkg install [--relay URL] [--dkg-role auto|edge|core] [--dkg-network NETWORK]
                   [--relay-members-enrolled]
  buzz-dkg status
  buzz-dkg logs
  buzz-dkg smoke
  buzz-dkg identities
  buzz-dkg remove

Install adopts a reachable Buzz Relay while preserving its identity, database,
URL, and TLS configuration. For a discovered local Compose relay it adds a
protected DKG proxy override and performs one controlled relay restart. Fresh
guided installs default to testnet;
fresh unattended installs must name testnet, mainnet-gnosis, or mainnet-base.
On a discovered closed Buzz Relay, install uses the relay's native buzz-admin
command to enroll its two managed identities. Use --relay-members-enrolled only
after enrolling them through another supported relay administration path.
Verifiable Memory publication stays off.`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    if (options.command === 'install') await install(options, prompt, installContext);
    else if (options.command === 'plan') await plan(installContext, options, prompt);
    else if (options.command === 'status' || options.command === 'doctor')
      await status(installContext);
    else if (options.command === 'logs') logs(installContext);
    else if (options.command === 'smoke') smoke(installContext);
    else if (options.command === 'identities') identities(installContext);
    else if (options.command === 'remove') remove(installContext);
    else help();
  } catch (error) {
    console.error(`buzz-dkg: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    prompt.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
