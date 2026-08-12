import { finalizeEvent, getPublicKey, type EventTemplate } from 'nostr-tools';
import oxigraph from 'oxigraph';
import { describe, expect, it } from 'vitest';
import { Daemon } from '../src/daemon.ts';
import {
  compileAgentMemory,
  contextGraphIdForChannel,
  parseAgentMemoryEnvelope,
} from '../src/memory/proposal.ts';
import { QueryGatewayService } from '../src/query-gateway/service.ts';
import { DKG_MEMORY_PROPOSAL_KIND, type DaemonConfig, type NostrEvent } from '../src/types.ts';
import { MockDkg, MockRelay, hexId } from './helpers.ts';

const CHANNEL = 'c69311ba-a5a2-4b2a-a27f-99f7669af643';
const SECRET = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const PUBKEY = getPublicKey(SECRET);
const OTHER_SECRET = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);

function signed(template: EventTemplate): NostrEvent {
  return finalizeEvent(template, SECRET) as NostrEvent;
}

function signedWith(template: EventTemplate, secret: Uint8Array): NostrEvent {
  return finalizeEvent(template, secret) as NostrEvent;
}

function envelope(overrides: { proposalContent?: string; channelId?: string } = {}) {
  const channelId = overrides.channelId ?? CHANNEL;
  const source = signed({
    kind: 9,
    created_at: 1_788_000_000,
    tags: [['h', channelId]],
    content: 'We will use Oxigraph and ship the migration on Friday.',
  });
  const content =
    overrides.proposalContent ??
    JSON.stringify({
      schemaVersion: 1,
      summary: 'Adopt Oxigraph and migrate Friday',
      items: [
        { kind: 'decision', text: 'The project will use Oxigraph.' },
        { kind: 'task', text: 'Ship the migration on Friday.' },
        {
          kind: 'relationship',
          text: 'The migration uses Oxigraph.',
          subject: 'migration',
          predicate: 'uses',
          object: 'Oxigraph',
          confidence: 0.96,
        },
      ],
      model: 'test-model',
      promptVersion: 'agent-memory-v1',
    });
  const proposal = signed({
    kind: DKG_MEMORY_PROPOSAL_KIND,
    created_at: source.created_at + 1,
    tags: [
      ['h', channelId],
      ['e', source.id, '', 'source'],
      ['t', 'dkg-memory-proposal'],
    ],
    content,
  });
  return {
    channelId,
    requesterPubkey: PUBKEY,
    proposalEvent: proposal,
    sourceEvents: [source],
  };
}

function setup() {
  const relay = new MockRelay(hexId('service'));
  const dkg = new MockDkg();
  const config: DaemonConfig = {
    relayHttpUrl: 'https://relay.example.test',
    relayWsUrl: 'wss://relay.example.test',
    serviceSecretKeyHex: '11'.repeat(32),
    mentionLabels: ['dkg'],
    dkgApiUrl: 'http://127.0.0.1:9200',
    dkgToken: 'test-token',
    approvalEmoji: '✅',
    publishMode: 'disabled',
    maxPublishesPerDay: 0,
    dbPath: ':memory:',
    bindings: [],
    autoProvisionChannels: true,
    contextGraphAccessPolicy: 1,
  };
  const daemon = new Daemon(config, { relay: relay.asRelay(), dkg: dkg.asDkg() });
  return { daemon, relay, dkg };
}

function generatedStore(quads: ReturnType<typeof compileAgentMemory>['quads']) {
  const store = new oxigraph.Store();
  loadGeneratedQuads(store, quads, 'urn:test:generated:swm');
  return store;
}

function loadGeneratedQuads(
  store: InstanceType<typeof oxigraph.Store>,
  quads: ReturnType<typeof compileAgentMemory>['quads'],
  graphUri: string,
) {
  const graph = `<${graphUri}>`;
  const serialized = quads
    .map(({ subject, predicate, object }) => {
      const rdfObject = object.startsWith('"') ? object : `<${object}>`;
      return `<${subject}> <${predicate}> ${rdfObject} ${graph} .`;
    })
    .join('\n');
  store.load(serialized, { format: 'application/n-quads' });
}

function queryRows(store: InstanceType<typeof oxigraph.Store>, sparql: string) {
  const result = store.query(sparql);
  if (!Array.isArray(result)) throw new Error('expected SELECT results');
  return result as Array<Map<string, oxigraph.Term>>;
}

const v2Content = () =>
  JSON.stringify({
    schemaVersion: 2,
    profiles: ['dkg-memory@1', 'dkg-software@1'],
    summary: 'JWT verification decisions and implementation history',
    entities: [
      {
        id: 'auth-gateway',
        type: 'code:Package',
        name: 'Authentication gateway',
        locator: {
          kind: 'code',
          repository: 'https://github.com/acme/api',
          package: '@acme/auth',
        },
      },
      {
        id: 'verify-token',
        type: 'code:Function',
        name: 'verifyToken',
        locator: {
          kind: 'code',
          repository: 'https://github.com/acme/api',
          package: '@acme/auth',
          path: 'src/token.ts',
          symbol: 'verifyToken',
          symbolKind: 'function',
        },
      },
      { id: 'alice', type: 'github:User', name: 'Alice Nguyen' },
      { id: 'bob', type: 'github:User', name: 'Bob Ortiz' },
      {
        id: 'first-commit',
        type: 'github:Commit',
        name: 'Implement token rotation',
        locator: {
          kind: 'github',
          repository: 'acme/api',
          resource: 'commit',
          id: 'a1b2c3d4',
        },
        attributes: [{ predicate: 'schema:dateCreated', value: '2026-07-14T10:15:00Z' }],
      },
      {
        id: 'second-commit',
        type: 'github:Commit',
        name: 'Add typed verification failures',
        locator: {
          kind: 'github',
          repository: 'acme/api',
          resource: 'commit',
          id: 'e5f6a7b8',
        },
        attributes: [{ predicate: 'schema:dateCreated', value: '2026-07-21T16:40:00Z' }],
      },
      {
        id: 'jwt-decision',
        type: 'decisions:Decision',
        name: 'Use short-lived JWT access tokens',
        attributes: [
          {
            predicate: 'decisions:context',
            value: 'Reduce credential exposure after a token leak',
          },
          {
            predicate: 'decisions:outcome',
            value: 'Use 15-minute access tokens and rotate refresh tokens',
          },
        ],
      },
    ],
    relations: [
      { subject: 'first-commit', predicate: 'github:affects', object: 'verify-token' },
      { subject: 'first-commit', predicate: 'github:affects', object: 'auth-gateway' },
      { subject: 'first-commit', predicate: 'github:authoredBy', object: 'alice' },
      { subject: 'second-commit', predicate: 'github:affects', object: 'verify-token' },
      { subject: 'second-commit', predicate: 'github:authoredBy', object: 'bob' },
      { subject: 'jwt-decision', predicate: 'decisions:affects', object: 'auth-gateway' },
      {
        subject: 'jwt-decision',
        predicate: 'decisions:implementedBy',
        object: 'first-commit',
        confidence: 0.98,
      },
    ],
    model: 'test/model',
    promptVersion: 'agent-memory-v2',
  });

describe('agent memory proposal contract', () => {
  it('verifies signed evidence and compiles semantic items with provenance', () => {
    const parsed = parseAgentMemoryEnvelope(envelope());
    const compiled = compileAgentMemory(parsed.envelope, parsed.proposal);
    expect(compiled.title).toBe('Adopt Oxigraph and migrate Friday');
    expect(compiled.quads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          predicate: 'https://w3id.org/buzz-dkg/buzz#memoryKind',
          object: '"decision"',
        }),
        expect.objectContaining({
          predicate: 'http://www.w3.org/ns/prov#wasDerivedFrom',
          object: `urn:nostr:event:${parsed.envelope.sourceEvents[0]!.id}`,
        }),
      ]),
    );
  });

  it('rejects invalid semantics and evidence that does not match the signed references', () => {
    expect(() =>
      parseAgentMemoryEnvelope(
        envelope({
          proposalContent: JSON.stringify({ schemaVersion: 1, summary: 'x', items: [] }),
        }),
      ),
    ).toThrow(/items must contain/);
    const mismatched = envelope();
    mismatched.sourceEvents = [
      signed({
        kind: 9,
        created_at: 1_788_000_010,
        tags: [['h', CHANNEL]],
        content: 'different event',
      }),
    ];
    expect(() => parseAgentMemoryEnvelope(mismatched)).toThrow(/references do not match/);

    const wrongMarker = envelope();
    wrongMarker.proposalEvent = signed({
      kind: DKG_MEMORY_PROPOSAL_KIND,
      created_at: wrongMarker.proposalEvent.created_at,
      tags: [
        ['h', CHANNEL],
        ['e', wrongMarker.sourceEvents[0]!.id, '', 'reply'],
        ['t', 'dkg-memory-proposal'],
      ],
      content: wrongMarker.proposalEvent.content,
    });
    expect(() => parseAgentMemoryEnvelope(wrongMarker)).toThrow(/source.*marker/);

    expect(() =>
      parseAgentMemoryEnvelope(
        envelope({
          proposalContent: JSON.stringify({
            schemaVersion: 1,
            summary: 'contains\na control character',
            items: [{ kind: 'claim', text: 'x' }],
          }),
        }),
      ),
    ).toThrow(/non-control UTF-8 bytes/);
    expect(() => parseAgentMemoryEnvelope(envelope({ channelId: CHANNEL.toUpperCase() }))).toThrow(
      /channelId is invalid/,
    );
  });

  it('rejects tampered signatures and requester/source authentication mismatches', () => {
    // JSON round-trip mirrors the HTTP boundary and removes nostr-tools'
    // private verification cache symbol before tampering.
    const tamperedSource = JSON.parse(JSON.stringify(envelope())) as ReturnType<typeof envelope>;
    tamperedSource.sourceEvents[0] = {
      ...tamperedSource.sourceEvents[0]!,
      content: 'changed after signing',
    };
    expect(() => parseAgentMemoryEnvelope(tamperedSource)).toThrow(/signature or event id/);

    const tamperedProposal = JSON.parse(JSON.stringify(envelope())) as ReturnType<typeof envelope>;
    tamperedProposal.proposalEvent = {
      ...tamperedProposal.proposalEvent,
      content: '{"schemaVersion":1,"summary":"changed","items":[]}',
    };
    expect(() => parseAgentMemoryEnvelope(tamperedProposal)).toThrow(/signature or event id/);

    const wrongRequester = envelope();
    wrongRequester.requesterPubkey = '00'.repeat(32);
    expect(() => parseAgentMemoryEnvelope(wrongRequester)).toThrow(/author.*requesterPubkey/);

    const otherSource = signedWith(
      {
        kind: 9,
        created_at: 1_788_000_020,
        tags: [['h', CHANNEL]],
        content: 'A source written by another participant.',
      },
      OTHER_SECRET,
    );
    const noRequesterSource = envelope();
    noRequesterSource.sourceEvents = [otherSource];
    noRequesterSource.proposalEvent = signed({
      kind: DKG_MEMORY_PROPOSAL_KIND,
      created_at: otherSource.created_at + 1,
      tags: [
        ['h', CHANNEL],
        ['e', otherSource.id, '', 'source'],
        ['t', 'dkg-memory-proposal'],
      ],
      content: noRequesterSource.proposalEvent.content,
    });
    expect(() => parseAgentMemoryEnvelope(noRequesterSource)).toThrow(/authored by the proposing/);
  });

  it('compiles v2 profile entities into the direct edges required by real SPARQL questions', () => {
    const parsed = parseAgentMemoryEnvelope(envelope({ proposalContent: v2Content() }));
    const compiled = compileAgentMemory(parsed.envelope, parsed.proposal);
    const store = generatedStore(compiled.quads);
    const contributors = queryRows(
      store,
      `PREFIX schema: <http://schema.org/>
       PREFIX code: <http://dkg.io/ontology/code/>
       PREFIX github: <http://dkg.io/ontology/github/>
       SELECT DISTINCT ?name ?sha WHERE { GRAPH ?g {
         ?function a code:Function ; schema:name "verifyToken" .
         ?commit a github:Commit ; github:affects ?function ;
           github:authoredBy ?editor ; github:sha ?sha .
         ?editor schema:name ?name .
       } } ORDER BY ?sha`,
    );
    expect(
      contributors.map((row) => ({
        name: row.get('name')?.value,
        sha: row.get('sha')?.value,
      })),
    ).toEqual([
      { name: 'Alice Nguyen', sha: 'a1b2c3d4' },
      { name: 'Bob Ortiz', sha: 'e5f6a7b8' },
    ]);

    const decisions = queryRows(
      store,
      `PREFIX schema: <http://schema.org/>
       PREFIX code: <http://dkg.io/ontology/code/>
       PREFIX github: <http://dkg.io/ontology/github/>
       PREFIX decisions: <http://dkg.io/ontology/decisions/>
       SELECT ?decision ?context ?outcome WHERE { GRAPH ?g {
         ?component a code:Package ; schema:name "Authentication gateway" .
         ?commit a github:Commit ; github:sha "a1b2c3d4" ; github:affects ?component .
         ?decision a decisions:Decision ; decisions:affects ?component ;
           decisions:implementedBy ?commit ; decisions:context ?context ;
           decisions:outcome ?outcome .
       } }`,
    );
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.get('context')?.value).toContain('credential exposure');
    expect(decisions[0]!.get('outcome')?.value).toContain('15-minute');
    expect(compiled.quads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          predicate: 'http://dkg.io/ontology/memory/profile',
          object: 'http://dkg.io/ontology/profile/dkg-software/1',
        }),
        expect.objectContaining({
          predicate: 'http://dkg.io/ontology/memory/confidence',
          object: '"0.98"^^<http://www.w3.org/2001/XMLSchema#decimal>',
        }),
        expect.objectContaining({
          predicate: 'https://w3id.org/buzz-dkg/buzz#sourceSetDigest',
          object: `"${compiled.digest}"`,
        }),
      ]),
    );
    const proposingAgent = `urn:nostr:pubkey:${parsed.envelope.requesterPubkey}`;
    const decisionUri = decisions[0]!.get('decision')!.value;
    const attributedEntities = queryRows(
      store,
      `PREFIX prov: <http://www.w3.org/ns/prov#>
       SELECT ?agent WHERE { GRAPH ?g { <${decisionUri}> prov:wasAttributedTo ?agent } }`,
    );
    expect(attributedEntities.map((row) => row.get('agent')?.value)).toEqual([proposingAgent]);
    const attributedAssertions = queryRows(
      store,
      `PREFIX memory: <http://dkg.io/ontology/memory/>
       PREFIX prov: <http://www.w3.org/ns/prov#>
       SELECT ?assertion ?agent WHERE { GRAPH ?g {
         ?assertion a memory:Assertion ; prov:wasAttributedTo ?agent .
       } }`,
    );
    expect(attributedAssertions).toHaveLength(7);
    expect(new Set(attributedAssertions.map((row) => row.get('agent')?.value))).toEqual(
      new Set([proposingAgent]),
    );
  });

  it('converges canonical repository, project, and function identity across communities', () => {
    const firstContent = JSON.parse(v2Content()) as {
      entities: Array<{ type: string; locator?: Record<string, unknown> }>;
    } & Record<string, unknown>;
    for (const entity of firstContent.entities) {
      if (entity.locator?.kind === 'code') {
        entity.locator.repository = 'https://github.com/Acme/API.git/';
      }
    }
    const first = parseAgentMemoryEnvelope(
      envelope({ proposalContent: JSON.stringify(firstContent) }),
    );
    const second = parseAgentMemoryEnvelope(
      envelope({
        channelId: 'e5a7cdb2-544e-480e-b388-71a1e5580370',
        proposalContent: v2Content(),
      }),
    );
    const firstCompiled = compileAgentMemory(first.envelope, first.proposal);
    const secondCompiled = compileAgentMemory(second.envelope, second.proposal);
    const codeFunctionType = 'http://dkg.io/ontology/code/Function';
    const firstFunction = firstCompiled.quads.find(
      (quad) =>
        quad.predicate.endsWith('22-rdf-syntax-ns#type') && quad.object === codeFunctionType,
    )!.subject;
    const secondFunction = secondCompiled.quads.find(
      (quad) =>
        quad.predicate.endsWith('22-rdf-syntax-ns#type') && quad.object === codeFunctionType,
    )!.subject;
    expect(firstFunction).toBe(secondFunction);
    expect(firstFunction).toBe(
      'urn:dkg:code:file:github.com%2Facme%2Fapi/%40acme%2Fauth/src%2Ftoken.ts#function:verifyToken',
    );

    const otherRepository = JSON.parse(v2Content()) as typeof firstContent;
    for (const entity of otherRepository.entities) {
      if (entity.locator?.kind === 'code') {
        entity.locator.repository = 'https://github.com/other/api';
      }
    }
    const other = parseAgentMemoryEnvelope(
      envelope({ proposalContent: JSON.stringify(otherRepository) }),
    );
    const otherFunction = compileAgentMemory(other.envelope, other.proposal).quads.find(
      (quad) =>
        quad.predicate.endsWith('22-rdf-syntax-ns#type') && quad.object === codeFunctionType,
    )!.subject;
    expect(otherFunction).not.toBe(firstFunction);

    const alternateForgePort = JSON.parse(v2Content()) as typeof firstContent;
    for (const entity of alternateForgePort.entities) {
      if (entity.locator?.kind === 'code') {
        entity.locator.repository = 'https://forge.example.org:8443/acme/api';
      }
    }
    const defaultForgePort = JSON.parse(v2Content()) as typeof firstContent;
    for (const entity of defaultForgePort.entities) {
      if (entity.locator?.kind === 'code') {
        entity.locator.repository = 'https://forge.example.org/acme/api';
      }
    }
    const functionUri = (content: typeof firstContent) => {
      const parsed = parseAgentMemoryEnvelope(
        envelope({ proposalContent: JSON.stringify(content) }),
      );
      return compileAgentMemory(parsed.envelope, parsed.proposal).quads.find(
        (quad) =>
          quad.predicate.endsWith('22-rdf-syntax-ns#type') && quad.object === codeFunctionType,
      )!.subject;
    };
    expect(functionUri(alternateForgePort)).not.toBe(functionUri(defaultForgePort));

    const store = new oxigraph.Store();
    loadGeneratedQuads(store, firstCompiled.quads, 'urn:test:community-one');
    loadGeneratedQuads(store, secondCompiled.quads, 'urn:test:community-two');
    const sharedFunctions = queryRows(
      store,
      `PREFIX schema: <http://schema.org/>
       PREFIX code: <http://dkg.io/ontology/code/>
       SELECT ?function (COUNT(DISTINCT ?graph) AS ?graphs) WHERE {
         GRAPH ?graph { ?function a code:Function ; schema:name "verifyToken" . }
       } GROUP BY ?function`,
    );
    expect(sharedFunctions).toHaveLength(1);
    expect(sharedFunctions[0]!.get('function')?.value).toBe(firstFunction);
    expect(sharedFunctions[0]!.get('graphs')?.value).toBe('2');

    const projectProposal = (uri: string) =>
      JSON.stringify({
        schemaVersion: 2,
        profiles: ['dkg-memory@1'],
        summary: 'Discuss the Open Climate project',
        entities: [
          {
            id: 'project',
            type: 'schema:Project',
            name: 'Open Climate',
            locator: { kind: 'uri', uri },
          },
        ],
        relations: [],
      });
    const projectOne = parseAgentMemoryEnvelope(
      envelope({ proposalContent: projectProposal('https://projects.example.org/open-climate/') }),
    );
    const projectTwo = parseAgentMemoryEnvelope(
      envelope({
        channelId: 'e5a7cdb2-544e-480e-b388-71a1e5580370',
        proposalContent: projectProposal('https://projects.example.org/open-climate'),
      }),
    );
    const projectType = 'http://schema.org/Project';
    const projectUri = (parsed: typeof projectOne) =>
      compileAgentMemory(parsed.envelope, parsed.proposal).quads.find(
        (quad) => quad.predicate.endsWith('22-rdf-syntax-ns#type') && quad.object === projectType,
      )!.subject;
    expect(projectUri(projectOne)).toBe(projectUri(projectTwo));
    expect(projectUri(projectOne)).toBe('https://projects.example.org/open-climate');

    const localProposal = JSON.stringify({
      schemaVersion: 2,
      profiles: ['dkg-memory@1'],
      summary: 'Discuss an unidentified local initiative',
      entities: [{ id: 'initiative', type: 'memory:Entity', name: 'Phoenix' }],
      relations: [],
    });
    const localOne = parseAgentMemoryEnvelope(envelope({ proposalContent: localProposal }));
    const localTwo = parseAgentMemoryEnvelope(
      envelope({
        channelId: 'e5a7cdb2-544e-480e-b388-71a1e5580370',
        proposalContent: localProposal,
      }),
    );
    const localType = 'http://dkg.io/ontology/memory/Entity';
    const localUri = (parsed: typeof localOne) =>
      compileAgentMemory(parsed.envelope, parsed.proposal).quads.find(
        (quad) => quad.predicate.endsWith('22-rdf-syntax-ns#type') && quad.object === localType,
      )!.subject;
    expect(localUri(localOne)).not.toBe(localUri(localTwo));
  });

  it('compiles a general-only profile into queryable event and task memory', () => {
    const parsed = parseAgentMemoryEnvelope(
      envelope({
        proposalContent: JSON.stringify({
          schemaVersion: 2,
          profiles: ['dkg-memory@1'],
          summary: 'Prepare the community workshop',
          entities: [
            {
              id: 'workshop',
              type: 'schema:Event',
              name: 'Community memory workshop',
              attributes: [{ predicate: 'schema:startDate', value: '2026-08-14T16:00:00Z' }],
            },
            { id: 'room', type: 'schema:Place', name: 'Belgrade workshop room' },
            { id: 'mira', type: 'schema:Person', name: 'Mira' },
            {
              id: 'slides',
              type: 'tasks:Task',
              name: 'Prepare the ontology slides',
              attributes: [
                { predicate: 'tasks:status', value: 'todo' },
                { predicate: 'tasks:dueDate', value: '2026-08-13T12:00:00Z' },
              ],
            },
          ],
          relations: [
            { subject: 'slides', predicate: 'schema:about', object: 'workshop' },
            { subject: 'slides', predicate: 'tasks:assignee', object: 'mira' },
            { subject: 'workshop', predicate: 'schema:location', object: 'room' },
          ],
        }),
      }),
    );
    const store = generatedStore(compileAgentMemory(parsed.envelope, parsed.proposal).quads);
    const tasks = queryRows(
      store,
      `PREFIX schema: <http://schema.org/>
       PREFIX tasks: <http://dkg.io/ontology/tasks/>
       SELECT ?taskName ?assigneeName ?eventName ?placeName ?due WHERE { GRAPH ?g {
         ?task a tasks:Task ; schema:name ?taskName ; schema:about ?event ;
           tasks:status "todo" ; tasks:assignee ?assignee ; tasks:dueDate ?due .
         ?assignee schema:name ?assigneeName .
         ?event a schema:Event ; schema:name ?eventName ; schema:location ?place .
         ?place schema:name ?placeName .
       } }`,
    );
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.get('taskName')?.value).toBe('Prepare the ontology slides');
    expect(tasks[0]!.get('assigneeName')?.value).toBe('Mira');
    expect(tasks[0]!.get('eventName')?.value).toBe('Community memory workshop');
    expect(tasks[0]!.get('placeName')?.value).toBe('Belgrade workshop room');
    expect(tasks[0]!.get('due')?.value).toBe('2026-08-13T12:00:00Z');
  });

  it('rejects v2 namespace injection, dangling relations, and unsafe locators', () => {
    const valid = JSON.parse(v2Content()) as Record<string, unknown>;
    expect(() =>
      parseAgentMemoryEnvelope(
        envelope({
          proposalContent: JSON.stringify({
            ...valid,
            entities: [{ id: 'attack', type: 'evil:Root', name: 'Attack' }],
            relations: [],
          }),
        }),
      ),
    ).toThrow(/type is not allowed/);
    expect(() =>
      parseAgentMemoryEnvelope(
        envelope({
          proposalContent: JSON.stringify({
            ...valid,
            relations: [
              { subject: 'jwt-decision', predicate: 'decisions:affects', object: 'missing' },
            ],
          }),
        }),
      ),
    ).toThrow(/endpoints must reference/);
    expect(() =>
      parseAgentMemoryEnvelope(
        envelope({
          proposalContent: JSON.stringify({
            ...valid,
            entities: [
              {
                id: 'attack',
                type: 'memory:Entity',
                name: 'Attack',
                locator: { kind: 'uri', uri: 'javascript:alert(1)' },
              },
            ],
            relations: [],
          }),
        }),
      ),
    ).toThrow(/HTTPS or URN/);

    expect(() =>
      parseAgentMemoryEnvelope(
        envelope({
          proposalContent: JSON.stringify({
            ...valid,
            entities: [{ id: 'commit', type: 'github:Commit', name: 'Unlocatable commit' }],
            relations: [],
          }),
        }),
      ),
    ).toThrow(/stable github identifier/);
  });
});

describe('automatic channel memory lifecycle', () => {
  it('keeps an unknown-channel read side-effect-free', async () => {
    const { daemon, dkg } = setup();
    const service = new QueryGatewayService(
      (channelId) => daemon.contextGraphForQuery(channelId),
      dkg.asDkg(),
      {
        enabled: true,
        bind: '127.0.0.1',
        port: 0,
        token: 'x'.repeat(32),
        maxBodyBytes: 16_384,
        maxResultBytes: 1_048_576,
        maxQueryBytes: 8_192,
        operationTimeoutMs: 1_000,
        dkgTimeoutMs: 500,
        maxConcurrent: 4,
        maxDkgConcurrent: 2,
        maxDkgQueue: 32,
        cacheTtlMs: 30_000,
        maxCacheEntries: 256,
      },
    );
    await expect(
      service.execute({
        channelId: CHANNEL,
        operation: 'channel_memory',
        arguments: {},
        requesterPubkey: PUBKEY,
      }),
    ).rejects.toMatchObject({ code: 'unknown_channel' });
    expect(dkg.createdContextGraphs).toHaveLength(0);
    expect(daemon.registry.contextGraphFor(CHANNEL)).toBeNull();
  });

  it('does not reserve a channel when canonical v2 compilation rejects the proposal', () => {
    const { daemon, dkg } = setup();
    const valid = JSON.parse(v2Content()) as { entities: Array<Record<string, unknown>> } & Record<
      string,
      unknown
    >;
    const duplicateCommit = {
      ...valid.entities.find((entity) => entity.id === 'first-commit')!,
      id: 'duplicate-commit',
    };
    valid.entities.push(duplicateCommit);

    expect(() =>
      daemon.submitAgentMemory(
        envelope({
          proposalContent: JSON.stringify(valid),
        }),
      ),
    ).toThrow(/duplicate identifiers/);
    expect(daemon.registry.contextGraphFor(CHANNEL)).toBeNull();
    expect(dkg.createdContextGraphs).toHaveLength(0);
  });

  it('provisions one private Context Graph and stores a proposal in SWM without a chat receipt', async () => {
    const { daemon, relay, dkg } = setup();
    const request = envelope();
    const result = await daemon.submitAgentMemory(request);
    const expectedGraph = contextGraphIdForChannel('https://relay.example.test', CHANNEL);

    expect(result).toMatchObject({
      ok: true,
      outcome: 'accepted',
      channelId: CHANNEL,
      requesterPubkey: PUBKEY,
      contextGraphId: expectedGraph,
      operationId: expect.any(Number),
      state: 'processing',
    });
    await daemon.drain();
    expect(dkg.createdContextGraphs).toEqual([
      expect.objectContaining({
        id: expectedGraph,
        accessPolicy: 1,
        publishPolicy: 0,
        register: false,
      }),
    ]);
    expect(dkg.kas.get(result.kaName)).toMatchObject({
      state: 'promoted',
      writes: 1,
      finalizes: 1,
      shares: 1,
      publishes: 0,
    });
    expect(dkg.lifecycleLog).toEqual([
      { operation: 'write', name: result.kaName, contextGraphId: expectedGraph },
      { operation: 'finalize', name: result.kaName, contextGraphId: expectedGraph },
      { operation: 'share', name: result.kaName, contextGraphId: expectedGraph },
    ]);
    expect(dkg.queryLog).toContainEqual(
      expect.objectContaining({ contextGraphId: expectedGraph, view: 'shared-working-memory' }),
    );
    expect(relay.sent).toHaveLength(0);

    const replay = await daemon.submitAgentMemory(request);
    expect(replay.outcome).toBe('duplicate');
    expect(replay.operationId).toBe(result.operationId);
    expect(replay.state).toBe('stored');
    expect(dkg.createdContextGraphs).toHaveLength(1);
    expect(dkg.kas.get(result.kaName)?.writes).toBe(1);
  });

  it('creates a different deterministic graph for a different channel', async () => {
    const { daemon, dkg } = setup();
    const other = 'e5a7cdb2-544e-480e-b388-71a1e5580370';
    const first = await daemon.submitAgentMemory(envelope());
    const second = await daemon.submitAgentMemory(envelope({ channelId: other }));
    expect(first.contextGraphId).not.toBe(second.contextGraphId);
    await daemon.drain();
    expect(dkg.createdContextGraphs).toHaveLength(2);
    const firstGraph = contextGraphIdForChannel('https://relay.example.test', CHANNEL);
    const secondGraph = contextGraphIdForChannel('https://relay.example.test', other);
    expect(
      dkg.lifecycleLog
        .filter((entry) => entry.name === first.kaName)
        .map((entry) => entry.contextGraphId),
    ).toEqual([firstGraph, firstGraph, firstGraph]);
    expect(
      dkg.lifecycleLog
        .filter((entry) => entry.name === second.kaName)
        .map((entry) => entry.contextGraphId),
    ).toEqual([secondGraph, secondGraph, secondGraph]);
    expect(dkg.queryLog.filter((entry) => entry.contextGraphId === firstGraph)).not.toHaveLength(0);
    expect(dkg.queryLog.filter((entry) => entry.contextGraphId === secondGraph)).not.toHaveLength(
      0,
    );
  });

  it('accepts durably before slow first-use graph provisioning starts', async () => {
    const { daemon, dkg } = setup();
    const request = envelope();
    let release!: () => void;
    dkg.createContextGraphGate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const accepted = daemon.submitAgentMemory(request);
    expect(accepted).toMatchObject({ outcome: 'accepted', state: 'processing' });
    expect(dkg.createContextGraphStarted).toBe(0);
    expect(dkg.lifecycleLog).toHaveLength(0);

    const pendingPoll = daemon.submitAgentMemory(request);
    expect(pendingPoll).toMatchObject({
      outcome: 'duplicate',
      operationId: accepted.operationId,
      state: 'processing',
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(dkg.createContextGraphStarted).toBe(1);
    expect(daemon.registry.opByTrigger(accepted.proposalEventId)?.state).toBe('distilled');
    release();
    await daemon.drain();
    expect(daemon.registry.opByTrigger(accepted.proposalEventId)?.state).toBe('receipted');

    const storedPoll = daemon.submitAgentMemory(request);
    expect(storedPoll).toMatchObject({
      outcome: 'duplicate',
      operationId: accepted.operationId,
      state: 'stored',
    });
    expect(dkg.createdContextGraphs).toHaveLength(1);
  });

  it('treats reordered source events and JSON object keys as an idempotent retry', async () => {
    const { daemon, dkg } = setup();
    const request = envelope();
    const second = signed({
      kind: 9,
      created_at: request.sourceEvents[0]!.created_at + 1,
      tags: [['h', CHANNEL]],
      content: 'The second signed source event.',
    });
    request.sourceEvents.push(second);
    request.proposalEvent = signed({
      kind: DKG_MEMORY_PROPOSAL_KIND,
      created_at: second.created_at + 1,
      tags: [
        ['h', CHANNEL],
        ['e', request.sourceEvents[0]!.id, '', 'source'],
        ['e', second.id, '', 'source'],
        ['t', 'dkg-memory-proposal'],
      ],
      content: request.proposalEvent.content,
    });
    const first = await daemon.submitAgentMemory(request);
    await daemon.drain();

    const retry = {
      sourceEvents: [...request.sourceEvents].reverse().map((event) => ({
        sig: event.sig,
        content: event.content,
        tags: event.tags,
        kind: event.kind,
        created_at: event.created_at,
        pubkey: event.pubkey,
        id: event.id,
      })),
      proposalEvent: {
        sig: request.proposalEvent.sig,
        content: request.proposalEvent.content,
        tags: request.proposalEvent.tags,
        kind: request.proposalEvent.kind,
        created_at: request.proposalEvent.created_at,
        pubkey: request.proposalEvent.pubkey,
        id: request.proposalEvent.id,
      },
      requesterPubkey: request.requesterPubkey,
      channelId: request.channelId,
    };
    const duplicate = await daemon.submitAgentMemory(retry);
    expect(duplicate.outcome).toBe('duplicate');
    expect(duplicate.kaName).toBe(first.kaName);
    expect(dkg.kas.get(first.kaName)?.writes).toBe(1);
  });

  it('recovers a proposal interrupted after finalize without repeating completed steps', async () => {
    const { daemon, dkg } = setup();
    dkg.failShareOnce = new Error('transient share failure');
    const accepted = await daemon.submitAgentMemory(envelope());
    await daemon.drain();
    expect(daemon.registry.opByTrigger(accepted.proposalEventId)?.state).toBe('finalized');

    await daemon.recover();
    expect(daemon.registry.opByTrigger(accepted.proposalEventId)?.state).toBe('receipted');
    expect(dkg.kas.get(accepted.kaName)).toMatchObject({
      writes: 1,
      finalizes: 1,
      shares: 1,
      state: 'promoted',
    });
  });
});
