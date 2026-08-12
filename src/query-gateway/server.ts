import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DkgClient } from '../dkg/client.ts';
import { IntegrationApiError } from '../errors.ts';
import { logger } from '../log.ts';
import type { AgentMemoryIngestResult, ChannelBinding, QueryGatewayConfig } from '../types.ts';
import { parseQueryGatewayRequest, type QueryCacheStatus, QueryGatewayService } from './service.ts';

type EnabledGatewayConfig = Extract<QueryGatewayConfig, { enabled: true }>;
type GatewayLogger = Pick<typeof logger, 'info' | 'warn'>;

const JSON_HEADERS = {
  'cache-control': 'no-store',
  'content-type': 'application/json; charset=utf-8',
  'x-content-type-options': 'nosniff',
};

function isLoopback(address: string | undefined): boolean {
  if (!address) return false;
  return address === '::1' || address.startsWith('127.') || address.startsWith('::ffff:127.');
}

function bearer(req: IncomingMessage): string {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return '';
  return header.slice(7);
}

function secretsEqual(actual: string, expected: string): boolean {
  const left = Buffer.from(actual, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

function responseJson(
  res: ServerResponse,
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    ...JSON_HEADERS,
    'content-length': String(Buffer.byteLength(body)),
    ...headers,
  });
  res.end(body);
}

function gatewayFailure(error: unknown): IntegrationApiError {
  if (error instanceof IntegrationApiError) return error;
  return new IntegrationApiError(502, 'upstream_failure', 'DKG query failed');
}

async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const declared = req.headers['content-length'];
  if (declared !== undefined) {
    const value = Number(declared);
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new IntegrationApiError(400, 'invalid_request', 'content-length is invalid');
    }
    if (value > maxBytes) {
      throw new IntegrationApiError(413, 'body_too_large', 'request body exceeds the limit');
    }
  }

  const chunks: Buffer[] = [];
  let bytes = 0;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    req.on('data', (chunk: Buffer | string) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > maxBytes) {
        req.resume();
        fail(new IntegrationApiError(413, 'body_too_large', 'request body exceeds the limit'));
        return;
      }
      chunks.push(buffer);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve();
    });
    req.on('aborted', () =>
      fail(new IntegrationApiError(400, 'invalid_request', 'request aborted')),
    );
    req.on('error', () => fail(new IntegrationApiError(400, 'invalid_request', 'request failed')));
  });
  if (bytes === 0) throw new IntegrationApiError(400, 'invalid_request', 'request body is empty');
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new IntegrationApiError(400, 'invalid_request', 'request body is not valid JSON');
  }
}

export class QueryGateway {
  readonly #server: Server;
  readonly #service: QueryGatewayService;
  readonly #log: GatewayLogger;
  readonly config: EnabledGatewayConfig;
  #inFlight = 0;

  constructor(
    config: EnabledGatewayConfig,
    bindings: readonly ChannelBinding[],
    dkg: DkgClient,
    dependencies: {
      log?: GatewayLogger;
      resolveContextGraph?: (channelId: string) => string | null | Promise<string | null>;
      submitAgentMemory?: (raw: unknown) => AgentMemoryIngestResult;
    } = {},
  ) {
    this.config = config;
    const mapped = new Map<string, string>();
    for (const binding of bindings) {
      if (mapped.has(binding.channelId)) {
        throw new Error(`duplicate query-gateway channel binding '${binding.channelId}'`);
      }
      mapped.set(binding.channelId, binding.contextGraphId);
    }
    const resolveContextGraph =
      dependencies.resolveContextGraph ?? ((channelId: string) => mapped.get(channelId) ?? null);
    this.#service = new QueryGatewayService(resolveContextGraph, dkg, config);
    this.#submitAgentMemory = dependencies.submitAgentMemory;
    this.#log = dependencies.log ?? logger;
    this.#server = createServer((req, res) => void this.handle(req, res));
    this.#server.maxHeadersCount = 32;
    this.#server.headersTimeout = 5_000;
    this.#server.requestTimeout = 10_000;
    this.#server.keepAliveTimeout = 5_000;
    this.#server.setTimeout(config.operationTimeoutMs + 5_000, (socket) => socket.destroy());
  }

  readonly #submitAgentMemory: ((raw: unknown) => AgentMemoryIngestResult) | undefined;

  get address(): AddressInfo | null {
    const address = this.#server.address();
    return address && typeof address !== 'string' ? address : null;
  }

  async start(): Promise<void> {
    if (this.#server.listening) return;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      this.#server.once('error', onError);
      this.#server.listen(this.config.port, this.config.bind, () => {
        this.#server.off('error', onError);
        resolve();
      });
    });
    this.#log.info('query gateway started', {
      bind: this.config.bind,
      port: this.address?.port ?? this.config.port,
    });
  }

  async stop(): Promise<void> {
    if (!this.#server.listening) return;
    await new Promise<void>((resolve, reject) => {
      this.#server.close((error) => (error ? reject(error) : resolve()));
      this.#server.closeIdleConnections();
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let audit: { channelId: string; operation: string; requesterPubkey: string } | null = null;
    let cacheStatus: QueryCacheStatus | undefined;
    let counted = false;
    const startedAt = performance.now();
    try {
      if (!isLoopback(req.socket.remoteAddress)) {
        throw new IntegrationApiError(403, 'loopback_required', 'loopback client required');
      }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/v1/query' && url.pathname !== '/v1/memory') {
        throw new IntegrationApiError(404, 'not_found', 'route not found');
      }
      if (url.search) {
        throw new IntegrationApiError(400, 'invalid_request', 'query parameters are not accepted');
      }
      if (req.method !== 'POST') {
        responseJson(
          res,
          405,
          { ok: false, error: { code: 'method_not_allowed', message: 'POST required' } },
          { allow: 'POST' },
        );
        return;
      }
      if (!secretsEqual(bearer(req), this.config.token)) {
        throw new IntegrationApiError(401, 'unauthorized', 'valid bearer token required');
      }
      const contentType = String(req.headers['content-type'] ?? '')
        .split(';', 1)[0]
        ?.trim()
        .toLowerCase();
      if (contentType !== 'application/json') {
        throw new IntegrationApiError(415, 'unsupported_media_type', 'application/json required');
      }
      if (this.#inFlight >= this.config.maxConcurrent) {
        throw new IntegrationApiError(429, 'busy', 'query gateway concurrency limit reached', {
          retryAfterSeconds: 2,
        });
      }
      this.#inFlight += 1;
      counted = true;
      const raw = await readJsonBody(req, this.config.maxBodyBytes);
      let output: unknown;
      let responseStatus = 200;
      if (url.pathname === '/v1/memory') {
        if (!this.#submitAgentMemory) {
          throw new IntegrationApiError(
            404,
            'memory_disabled',
            'agent memory ingestion is disabled',
          );
        }
        const memory = this.#submitAgentMemory(raw);
        this.#service.invalidateChannel(memory.channelId);
        output = memory;
        responseStatus = memory.state === 'stored' ? 200 : 202;
        audit = {
          channelId: memory.channelId,
          operation: 'agent_memory',
          requesterPubkey: memory.requesterPubkey,
        };
      } else {
        const parsed = parseQueryGatewayRequest(raw);
        audit = {
          channelId: parsed.channelId,
          operation: parsed.operation,
          requesterPubkey: parsed.requesterPubkey,
        };
        output = await this.#service.execute(parsed, (status) => {
          cacheStatus = status;
        });
      }
      const body = JSON.stringify(output);
      const resultBytes = Buffer.byteLength(body, 'utf8');
      if (resultBytes > this.config.maxResultBytes) {
        throw new IntegrationApiError(502, 'result_too_large', 'query result exceeds the limit');
      }
      res.writeHead(responseStatus, {
        ...JSON_HEADERS,
        'content-length': String(resultBytes),
      });
      res.end(body);
      this.#log.info('query gateway request served', {
        ...audit,
        resultBytes,
        durationMs: Math.round(performance.now() - startedAt),
        ...(cacheStatus ? { cacheStatus } : {}),
        ...this.#service.loadSnapshot(),
      });
    } catch (error) {
      const failure = gatewayFailure(error);
      this.#log.warn('query gateway request rejected', {
        status: failure.status,
        code: failure.code,
        durationMs: Math.round(performance.now() - startedAt),
        ...(cacheStatus ? { cacheStatus } : {}),
        ...this.#service.loadSnapshot(),
        ...(audit ?? {}),
      });
      if (!res.headersSent) {
        const retryAfterSeconds = failure.details?.retryAfterSeconds;
        responseJson(
          res,
          failure.status,
          {
            ok: false,
            error: {
              code: failure.code,
              message: failure.message,
              ...(failure.details ? { details: failure.details } : {}),
            },
          },
          typeof retryAfterSeconds === 'number'
            ? { 'retry-after': String(Math.max(1, Math.ceil(retryAfterSeconds))) }
            : {},
        );
      } else {
        res.destroy();
      }
    } finally {
      if (counted) this.#inFlight -= 1;
    }
  }
}
