import { describe, expect, it } from 'vitest';
import { createExplorerSecurity, validateExplorerInput } from '../explorer/security.mjs';

function request(overrides = {}) {
  return {
    headers: { host: 'gateway.example:9295', origin: 'tauri://localhost', ...overrides.headers },
    socket: { remoteAddress: overrides.address || '100.64.0.2' },
  };
}

function gateway(overrides = {}) {
  return createExplorerSecurity({
    bind: '0.0.0.0',
    port: 9295,
    env: {
      EXPLORER_PUBLIC_CGS: 'agent/community',
      EXPLORER_GATEWAY_SECRET: 's'.repeat(32),
      EXPLORER_ALLOWED_HOSTS: 'gateway.example:9295',
      EXPLORER_ALLOWED_ORIGINS: 'tauri://localhost',
      ...overrides,
    },
  });
}

describe('explorer gateway security boundary', () => {
  it('fails startup without every gateway trust-boundary setting', () => {
    expect(() =>
      createExplorerSecurity({ bind: '0.0.0.0', port: 9295, env: {} }),
    ).toThrow(/GATEWAY_SECRET/);
    expect(() =>
      createExplorerSecurity({
        bind: '0.0.0.0',
        port: 9295,
        env: { EXPLORER_GATEWAY_SECRET: 's'.repeat(32) },
      }),
    ).toThrow(/PUBLIC_CGS/);
  });

  it('requires an allowlisted CG, bearer secret, Host, and exact Origin', () => {
    const policy = gateway();
    const authorized = request({ headers: { authorization: `Bearer ${'s'.repeat(32)}` } });
    expect(policy.authorize(authorized, 'agent/community')).toMatchObject({
      'access-control-allow-origin': 'tauri://localhost',
    });
    expect(() => policy.authorize(authorized, 'agent/private')).toThrow(/not served/);
    expect(() => policy.authorize(request(), 'agent/community')).toThrow(/authentication/);
    expect(() =>
      policy.authorize(
        request({ headers: { host: 'evil.example', authorization: `Bearer ${'s'.repeat(32)}` } }),
        'agent/community',
      ),
    ).toThrow(/host not allowed/);
    expect(() =>
      policy.authorize(
        request({ headers: { origin: 'https://evil.example', authorization: `Bearer ${'s'.repeat(32)}` } }),
        'agent/community',
      ),
    ).toThrow(/origin not allowed/);
  });

  it('rate-limits gateway callers and validates query inputs', () => {
    let now = 0;
    const policy = createExplorerSecurity({
      bind: '0.0.0.0',
      port: 9295,
      now: () => now,
      env: {
        EXPLORER_PUBLIC_CGS: 'agent/community',
        EXPLORER_GATEWAY_SECRET: 's'.repeat(32),
        EXPLORER_ALLOWED_HOSTS: 'gateway.example:9295',
        EXPLORER_RATE_LIMIT_PER_MINUTE: '1',
      },
    });
    const req = request({
      headers: { origin: undefined, authorization: `Bearer ${'s'.repeat(32)}` },
    });
    expect(() => policy.authorize(req, 'agent/community')).not.toThrow();
    expect(() => policy.authorize(req, 'agent/community')).toThrow(/rate limit/);
    now = 60_000;
    expect(() => policy.authorize(req, 'agent/community')).not.toThrow();
    expect(validateExplorerInput('agent/community', 'cg')).toBe('agent/community');
    expect(() => validateExplorerInput('agent/community> } UNION {', 'cg')).toThrow(/invalid/);
  });
});
