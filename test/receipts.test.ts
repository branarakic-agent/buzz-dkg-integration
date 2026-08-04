import { describe, expect, it } from 'vitest';
import {
  swmReceipt,
  vmReceipt,
  parseReceiptDigest,
  parseReceiptKaName,
} from '../src/receipts/compose.ts';
import { parseBindings } from '../src/config.ts';
import type { OpRecord } from '../src/types.ts';
import { hexId } from './helpers.ts';

const op: OpRecord = {
  id: 1,
  triggerEventId: hexId('trigger'),
  triggerKind: 40004,
  channelId: 'chan-a',
  contextGraphId: '0xagent/graph-a',
  rootEventId: hexId('root'),
  digest: 'a'.repeat(64),
  kaName: 'buzz-dkg-aaaaaaaaaaaa',
  rootUri: 'did:example:root',
  title: 'A decision',
  assertionUri: 'did:dkg:context-graph:0xagent/graph-a/assertion/0xagent/buzz-dkg-aaaaaaaaaaaa',
  state: 'shared',
  receiptEventId: null,
  ual: 'did:dkg:base:8453/0xstore/42',
  txHash: '0xtx',
  vmReceiptEventId: null,
  consumedApprovalId: null,
  error: null,
};

describe('explorer links on receipts', () => {
  it('SWM receipt links by KA name (no minted UAL to link) when a base URL is given', () => {
    const r = swmReceipt(op, 'http://192.168.0.24:5183');
    expect(r).toContain(
      '[Explore in DKG Explorer](http://192.168.0.24:5183/explore?ual=buzz-dkg-aaaaaaaaaaaa&cg=0xagent%2Fgraph-a)',
    );
  });

  it('VM receipt links by full UAL, url-encoded', () => {
    const r = vmReceipt(op, hexId('approval'), hexId('approver'), 'http://192.168.0.24:5183');
    expect(r).toContain(
      `[Explore in DKG Explorer](http://192.168.0.24:5183/explore?ual=${encodeURIComponent(op.ual!)}&cg=${encodeURIComponent(op.contextGraphId)})`,
    );
  });

  it('no explorer URL → no link line, receipt ends exactly as before', () => {
    const r = swmReceipt(op);
    expect(r).not.toContain('Explore in DKG Explorer');
    expect(r.endsWith('status: SWM (not published to Verifiable Memory)')).toBe(true);
    const v = vmReceipt(op, hexId('approval'), hexId('approver'));
    expect(v).not.toContain('Explore in DKG Explorer');
    expect(v.endsWith(`approval-event: ${hexId('approval')}`)).toBe(true);
  });

  it('link line does not disturb the anchored machine-readable parsers', () => {
    const r = swmReceipt(op, 'http://x');
    expect(parseReceiptDigest(r)).toBe(op.digest);
    expect(parseReceiptKaName(r)).toBe(op.kaName);
    expect(r).toContain(`trigger: ${op.triggerEventId}`);
  });

  it('level badges lead both receipts', () => {
    expect(swmReceipt(op).startsWith('🟡 ')).toBe(true);
    expect(vmReceipt(op, hexId('a'), hexId('b')).startsWith('🟢 ')).toBe(true);
  });
});

describe('bindings explorerUrl parsing', () => {
  it('accepts an optional per-binding explorerUrl and strips a trailing slash', () => {
    const [b] = parseBindings(
      JSON.stringify([
        {
          channelId: 'c',
          contextGraphId: 'g',
          promoters: [],
          explorerUrl: 'http://host:5183/',
        },
      ]),
    );
    expect(b!.explorerUrl).toBe('http://host:5183');
  });

  it('omits the field when absent', () => {
    const [b] = parseBindings(
      JSON.stringify([{ channelId: 'c', contextGraphId: 'g', promoters: [] }]),
    );
    expect(b!.explorerUrl).toBeUndefined();
  });

  it('rejects unsafe schemes and markdown-breaking explorer URLs', () => {
    for (const explorerUrl of ['javascript:alert(1)', 'https://host/) [forged](https://evil)']) {
      expect(() =>
        parseBindings(
          JSON.stringify([{ channelId: 'c', contextGraphId: 'g', promoters: [], explorerUrl }]),
        ),
      ).toThrow(/explorerUrl/);
    }
  });
});
