#!/usr/bin/env node
// Local-first DKG v10 explorer for Buzz receipt links.
//
// The design mandate: a receipt link must only resolve through the VIEWER'S
// OWN edge node (github.com/OriginTrail/dkg, v10). Receipts therefore link to
// http://127.0.0.1:9295/explore?ual=<ka>&cg=<contextGraphId> — the same link
// works for every member of a channel, but each viewer resolves it against
// their own node. If the viewer runs no node, or their node has not subscribed
// to the Context Graph the KA lives in, the page explains exactly which step
// is missing instead of showing the data. Access control is the DKG's own
// participation model (SWM syncs only to subscribed nodes; curated CGs enforce
// their allowlist at subscribe time). The loopback default serves only the
// viewer. A non-loopback bind is an explicit community-gateway trust boundary:
// this process then proxies its node bearer token, so startup requires a CG
// publication allowlist, caller secret, Host/origin allowlists, and rate limit.
//
// Run:  node explorer/local-explorer.mjs
// Env:  DKG_API        node API (default http://127.0.0.1:9200)
//       DKG_TOKEN      bearer token, or
//       DKG_TOKEN_PATH path to auth.token (default $DKG_HOME/auth.token,
//                      falling back to ~/.dkg-mainnet/auth.token)
//       PORT           default 9295
//       EXPLORER_ALLOWED_ORIGINS comma-separated desktop origins
// Gateway-only required env:
//       EXPLORER_PUBLIC_CGS, EXPLORER_GATEWAY_SECRET, EXPLORER_ALLOWED_HOSTS
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { createExplorerSecurity, validateExplorerInput } from './security.mjs';

const PORT = Number(process.env.PORT ?? 9295);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error('PORT must be 1..65535');
const BIND = process.env.EXPLORER_BIND ?? '127.0.0.1';
const NODE_API = (process.env.DKG_API ?? 'http://127.0.0.1:9200').replace(/\/$/, '');
const SECURITY = createExplorerSecurity({ bind: BIND, port: PORT });

function loadToken() {
  if (process.env.DKG_TOKEN) return process.env.DKG_TOKEN.trim();
  const candidates = [
    process.env.DKG_TOKEN_PATH,
    process.env.DKG_HOME && `${process.env.DKG_HOME}/auth.token`,
    `${homedir()}/.dkg-mainnet/auth.token`,
    `${homedir()}/.dkg/auth.token`,
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      const line = readFileSync(p, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'))
        .pop();
      if (line) return line;
    } catch {
      /* try next */
    }
  }
  return null;
}
const TOKEN = loadToken();
if (SECURITY.gateway && !TOKEN) throw new Error('gateway mode requires a readable DKG bearer token');

async function node(path, init = {}) {
  const res = await fetch(`${NODE_API}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
      ...(init.body ? { 'content-type': 'application/json' } : {}),
    },
  });
  return res;
}

async function sparql(cg, view, query) {
  const res = await node('/api/query', {
    method: 'POST',
    body: JSON.stringify({ contextGraphId: cg, view, sparql: query }),
  });
  if (!res.ok) throw new Error(`sparql ${res.status}`);
  return (await res.json()).result?.bindings ?? [];
}

// Node serializes SELECT bindings N-Triples-style.
function term(raw) {
  if (typeof raw !== 'string') return String(raw);
  if (raw.startsWith('"')) {
    const close = raw.lastIndexOf('"');
    return raw.slice(1, close).replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\');
  }
  return raw;
}

function layerCandidates(cg, r) {
  const out = [];
  for (const layer of ['_verifiable_memory', '_shared_memory']) {
    for (const addr of [r.agentAddress?.toLowerCase(), r.agentAddress].filter(Boolean)) {
      out.push(`did:dkg:context-graph:${cg}/${layer}/${addr}/${r.kaNumber}`);
    }
  }
  if (r.assertionGraph) out.push(r.assertionGraph);
  return [...new Set(out)];
}

/**
 * The three v10 memory layers of a Context Graph, as the node reports them.
 * One SPARQL per view; the node's own view-scoping restricts which named
 * graphs each layer may see, so a plain DISTINCT-graph enumeration per view
 * IS the layer listing. Labels prefer schema:name inside the graph.
 */
const LAYERS = [
  ['WM', 'working-memory'],
  ['SWM', 'shared-working-memory'],
  ['VM', 'verifiable-memory'],
];

async function layerOverview(cg) {
  const out = {};
  for (const [tag, view] of LAYERS) {
    try {
      const rows = await sparql(
        cg,
        view,
        `SELECT ?g (SAMPLE(?n) AS ?name) WHERE { GRAPH ?g { ?s ?p ?o . OPTIONAL { ?s <http://schema.org/name> ?n } } } GROUP BY ?g LIMIT 200`,
      );
      out[tag] = rows.map((r) => {
        const g = term(r.g);
        return { graph: g, label: r.name ? term(r.name) : g.split('/').slice(-2).join('/') };
      });
    } catch {
      out[tag] = null; // layer not readable on this node (e.g. WM is daemon-local)
    }
  }
  return out;
}

/** The whole gate flow as one JSON answer the page renders from. */
async function resolve(cg, ual) {
  // Gate 1 — is there a local edge node at all?
  let status;
  try {
    const res = await node('/api/status');
    if (res.status === 401 || res.status === 403) return { gate: 'auth' };
    if (!res.ok) return { gate: 'node-missing', detail: `node answered ${res.status}` };
    status = await res.json();
  } catch (err) {
    return { gate: 'node-missing', detail: String(err?.cause?.code ?? err).slice(0, 120) };
  }
  const nodeInfo = { name: status.name, version: status.version, api: NODE_API };

  // Gate 2 — does this node know the Context Graph? (false for a node that
  // has never subscribed; curated-CG allowlists are enforced by subscribe.)
  try {
    const res = await node(`/api/context-graph/exists?id=${encodeURIComponent(cg)}`);
    if (res.ok && (await res.json()).exists === false) {
      return { gate: 'not-subscribed', nodeInfo };
    }
  } catch {
    /* inconclusive probe — the KA lookup below still decides */
  }

  // Gate 3 — is the KA present locally? Present ⇔ this node participates in
  // the CG (SWM sync) or holds the published VM copy.
  const res = await node(
    `/api/knowledge-assets/${encodeURIComponent(ual)}?contextGraphId=${encodeURIComponent(cg)}`,
  );
  if (res.status === 404) return { gate: 'not-subscribed', nodeInfo };
  if (!res.ok) return { gate: 'node-error', detail: `knowledge-assets ${res.status}`, nodeInfo };
  const ka = await res.json();

  let triples = [];
  let graph = null;
  for (const g of layerCandidates(cg, ka)) {
    const view = g.includes('/_verifiable_memory/') ? 'verifiable-memory' : 'shared-working-memory';
    try {
      const rows = await sparql(cg, view, `SELECT ?s ?p ?o WHERE { GRAPH <${g}> { ?s ?p ?o } }`);
      if (rows.length) {
        triples = rows.map((r) => [term(r.s), term(r.p), term(r.o)]);
        graph = g;
        break;
      }
    } catch {
      /* try next layer graph */
    }
  }
  if (!triples.length) return { gate: 'not-subscribed', nodeInfo };

  return {
    gate: 'ok',
    nodeInfo,
    cg,
    ka: {
      name: ka.kaName ?? ual,
      layer: ka.memoryLayer ?? (graph?.includes('_verifiable_memory') ? 'VM' : 'SWM'),
      publishedUal: ka.publishedUal ?? null,
      state: ka.state ?? null,
      graph,
      // The KA's root entity IRI — the node UI's deep-link handle
      // (v10:open-entity). The titled subject (schema:name) is the node the
      // UI lists in its layer views; fall back to the first subject.
      rootEntity:
        triples.find((t) => t[1] === 'http://schema.org/name')?.[0] ?? triples[0]?.[0] ?? null,
    },
    triples,
    layers: await layerOverview(cg),
  };
}

/**
 * Where a successful gate lands: the node's OWN UI (served by the viewer's
 * edge node at /ui), deep-linked via the ?cg&entity|layer params the patched
 * dkg-node-ui understands. This page never renders KA data itself on the
 * happy path — the edge node UI is the explorer.
 */
function nodeUiUrl(out) {
  const base = `${NODE_API}/ui/?cg=${encodeURIComponent(out.cg)}`;
  if (out.ka.rootEntity) return `${base}&entity=${encodeURIComponent(out.ka.rootEntity)}`;
  return `${base}&layer=${out.ka.layer.toLowerCase()}`;
}

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function page(cg, ual) {
  return `<!doctype html><meta charset="utf-8">
<title>DKG · ${esc(ual)}</title>
<style>
  body{font:14px/1.5 ui-monospace,Menlo,monospace;background:#0d0b14;color:#e8e6f0;margin:0;padding:2rem;max-width:960px;margin-inline:auto}
  h1{font-size:1.05rem;color:#b09df5}.muted{color:#8b87a0}.badge{padding:.1rem .55rem;border-radius:1rem;font-weight:600}
  .swm{background:#4a3b00;color:#ffd75e}.vm{background:#0d3a24;color:#5eea9d}
  .card{background:#171225;border:1px solid #2c2440;border-radius:10px;padding:1rem 1.25rem;margin:1rem 0}
  pre{background:#0a0812;border:1px solid #2c2440;border-radius:8px;padding:.75rem;overflow-x:auto;white-space:pre-wrap;word-break:break-all}
  table{border-collapse:collapse;width:100%;font-size:12.5px}td{border-top:1px solid #241d38;padding:.35rem .5rem;vertical-align:top;word-break:break-all}
  .err{color:#ff8f8f}.ok{color:#5eea9d}a{color:#b09df5}
  .step{margin:.6rem 0}
  .layers{display:grid;grid-template-columns:repeat(3,1fr);gap:.75rem;margin-top:1rem}
  .col{background:#120e1e;border:1px solid #2c2440;border-radius:10px;padding:.6rem;min-height:6rem}
  .col.here{border-color:#7a5cff;box-shadow:0 0 0 1px #7a5cff40}
  .lh{border-bottom:1px solid #241d38;padding-bottom:.4rem;margin-bottom:.4rem}
  .ki{padding:.25rem .4rem;border-radius:6px;font-size:12px;word-break:break-all;color:#c9c5da}
  .ki.target{background:#2a2050;color:#fff;font-weight:600}
</style>
<h1>OriginTrail DKG — local resolution</h1>
<div class="muted">context graph: ${esc(cg)}<br>knowledge asset: ${esc(ual)}</div>
<div id="out" class="card">resolving through <b>your</b> edge node…</div>
<script>
const CG=${JSON.stringify(cg)},UAL=${JSON.stringify(ual)};
const esc=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
fetch('/api/resolve?cg='+encodeURIComponent(CG)+'&ual='+encodeURIComponent(UAL))
.then(r=>r.json()).then(d=>{
  const o=document.getElementById('out');
  if(d.gate==='node-missing'){o.innerHTML=
    '<div class="err">No DKG edge node is answering at '+esc(${JSON.stringify(NODE_API)})+'.</div>'+
    '<div class="step">This link resolves only through <b>your own</b> node. To proceed:</div>'+
    '<pre># 1. Run a DKG v10 edge node (github.com/OriginTrail/dkg)\\n'+
    'mkdir dkg-node && cd dkg-node && npm install dkg@latest\\n'+
    'DKG_HOME=$HOME/.dkg node_modules/.bin/dkg start</pre>'+
    '<div class="step">then reload this page.</div>'+(d.detail?'<div class="muted">('+esc(d.detail)+')</div>':'');return}
  if(d.gate==='auth'){o.innerHTML='<div class="err">Your node rejected the bearer token.</div>'+
    '<div class="step">Point this explorer at your token: <code>DKG_TOKEN_PATH=$DKG_HOME/auth.token</code> and restart it.</div>';return}
  if(d.gate==='not-subscribed'){o.innerHTML=
    '<div class="err">Your node has not joined this Context Graph, so the Knowledge Asset is not synced to it.</div>'+
    '<div class="step">Subscribe your node (curated graphs admit only allowlisted agents — ask the graph curator to add yours if this fails):</div>'+
    '<pre>curl -X POST '+esc(d.nodeInfo?.api||'http://127.0.0.1:9200')+'/api/context-graph/subscribe \\\\\\n'+
    '  -H "authorization: Bearer $(tail -1 $DKG_HOME/auth.token)" -H "content-type: application/json" \\\\\\n'+
    '  -d '+"'"+'{"contextGraphId":"'+esc(CG)+'","includeSharedMemory":true}'+"'"+'</pre>'+
    '<div class="step">then reload. Sync of the graph may take a moment after subscribing.</div>';return}
  if(d.gate!=='ok'){o.innerHTML='<div class="err">'+esc(d.detail||d.gate)+'</div>';return}
  const lvl=d.ka.layer==='VM'?'<span class="badge vm">🟢 VM — anchored on-chain</span>':'<span class="badge swm">🟡 SWM — shared working memory</span>';
  const layerMeta={WM:['working memory','node-local drafts'],SWM:['shared working memory','synced to subscribed nodes'],VM:['verifiable memory','anchored on-chain']};
  const cols=['WM','SWM','VM'].map(tag=>{
    const items=d.layers?.[tag];
    const head='<div class="lh"><b>'+tag+'</b> <span class="muted">'+layerMeta[tag][0]+'</span><br><span class="muted" style="font-size:11px">'+layerMeta[tag][1]+(items?' · '+items.length+' KA'+(items.length===1?'':'s'):'')+'</span></div>';
    if(!items) return '<div class="col">'+head+'<div class="muted" style="padding:.5rem">not readable from this node</div></div>';
    if(!items.length) return '<div class="col">'+head+'<div class="muted" style="padding:.5rem">empty</div></div>';
    const rows=items.map(it=>{
      const isT=it.graph===d.ka.graph;
      return '<div class="ki'+(isT?' target':'')+'" title="'+esc(it.graph)+'">'+(isT?'▶ ':'')+esc(it.label)+'</div>';
    }).join('');
    return '<div class="col'+(tag===d.ka.layer?' here':'')+'">'+head+rows+'</div>';
  }).join('');
  o.innerHTML='<div>'+lvl+' <span class="ok">resolved via '+esc(d.nodeInfo.name||'node')+' v'+esc(d.nodeInfo.version||'?')+' (your node)</span>'+
    ' <a style="float:right" href="'+esc(d.nodeInfo.api||'http://127.0.0.1:9200')+'/ui" target="_blank">open full node UI ↗</a></div>'+
    '<div class="layers">'+cols+'</div>'+
    '<div class="card" style="margin-top:1rem"><div class="muted">'+esc(d.ka.name)+' — landed in '+esc(d.ka.layer)+(d.ka.publishedUal?'<br>UAL: '+esc(d.ka.publishedUal):'')+'</div>'+
    '<table>'+d.triples.map(t=>'<tr><td>'+esc(t[0])+'</td><td>'+esc(t[1])+'</td><td>'+esc(t[2])+'</td></tr>').join('')+'</table></div>';
}).catch(e=>{document.getElementById('out').innerHTML='<div class="err">'+esc(e)+'</div>'});
</script>`;
}


/**
 * Prototype data API for the Buzz-native memory panel: one call returns the
 * channel-bound CG's layer overview, decision clusters, per-agent
 * contribution trails, and named subgraphs. All reads go through the
 * viewer's own node (same gate as /api/resolve).
 */
async function channelMemory(cg) {
  // Gate cheaply first.
  try {
    const st = await node('/api/status');
    if (!st.ok) return { gate: st.status === 401 ? 'auth' : 'node-missing' };
  } catch { return { gate: 'node-missing' }; }

  const layers = await layerOverview(cg);

  // Decision clusters with attribution + time, SWM view.
  let decisions = [];
  try {
    const rows = await sparql(cg, 'shared-working-memory',
      `SELECT ?s ?name ?digest ?t WHERE { GRAPH ?g {
         ?s a <https://w3id.org/buzz-dkg/buzz#DecisionCluster> .
         OPTIONAL { ?s <http://schema.org/name> ?name }
         OPTIONAL { ?s <https://w3id.org/buzz-dkg/buzz#sourceSetDigest> ?digest }
         OPTIONAL { ?s <http://www.w3.org/ns/prov#endedAtTime> ?t }
       } } LIMIT 200`);
    decisions = rows.map(r => ({ uri: term(r.s), name: r.name ? term(r.name) : null, digest: r.digest ? term(r.digest) : null, at: r.t ? term(r.t) : null }));
  } catch { /* view may be empty */ }

  // Per-agent contribution trails: events attributed to each pubkey.
  let contributors = [];
  try {
    const rows = await sparql(cg, 'shared-working-memory',
      `SELECT ?pk (COUNT(DISTINCT ?s) AS ?n) (MAX(?at) AS ?latest) WHERE { GRAPH ?g {
         ?s <https://w3id.org/buzz-dkg/nostr#pubkeyHex> ?pk .
         OPTIONAL { ?s <https://w3id.org/buzz-dkg/nostr#createdAt> ?at }
       } } GROUP BY ?pk ORDER BY DESC(?n) LIMIT 50`);
    contributors = rows.map(r => ({ pubkey: term(r.pk), events: Number(term(r.n)), latest: r.latest ? Number(term(r.latest)) : null }));
  } catch { /* ignore */ }

  // Named subgraphs registered on the CG.
  let subgraphs = [];
  try {
    const res = await node(`/api/sub-graph/list?contextGraphId=${encodeURIComponent(cg)}`);
    if (res.ok) { const j = await res.json(); subgraphs = j.subGraphs ?? j.sub_graphs ?? []; }
  } catch { /* endpoint optional */ }

  return { gate: 'ok', cg, layers, decisions, contributors, subgraphs };
}

/** Trail for one contributor: their events + the decisions derived from them. */
async function contributorTrail(cg, pubkey) {
  const rows = await sparql(cg, 'shared-working-memory',
    `SELECT ?s ?content ?at ?decision ?dname WHERE { GRAPH ?g {
       ?s <https://w3id.org/buzz-dkg/nostr#pubkeyHex> "${pubkey.replace(/[^0-9a-f]/g, '')}" .
       OPTIONAL { ?s <https://w3id.org/buzz-dkg/nostr#content> ?content }
       OPTIONAL { ?s <https://w3id.org/buzz-dkg/nostr#createdAt> ?at }
       OPTIONAL { ?decision <http://www.w3.org/ns/prov#wasDerivedFrom> ?s .
                  ?decision <http://schema.org/name> ?dname }
     } } ORDER BY DESC(?at) LIMIT 100`);
  return rows.map(r => ({
    event: term(r.s), content: r.content ? term(r.content).slice(0, 240) : null,
    at: r.at ? Number(term(r.at)) : null,
    decision: r.decision ? term(r.decision) : null,
    decisionName: r.dname ? term(r.dname) : null,
  }));
}

/**
 * Graph data for one named subgraph: the decision spine this subgraph's
 * evidence fed, plus one hop of evidence (claims/commits), per the graph-view
 * deliberation. Edges: supports (claim→decision via shared source event),
 * contradicts (if modeled), generated (run→claim). Deterministic: everything
 * carries a timestamp so the client can lay out time-ordered with no physics.
 */
async function subgraphGraph(cg, name) {
  try {
    const st = await node('/api/status');
    if (!st.ok) return { gate: st.status === 401 ? 'auth' : 'node-missing' };
  } catch { return { gate: 'node-missing' }; }

  const safe = name.replace(/[^a-zA-Z0-9_-]/g, '');
  const sgFilter = `FILTER(CONTAINS(STR(?g), "/${safe}/"))`;
  const BUZZ = 'https://w3id.org/buzz-dkg/buzz#';
  const PROV = 'http://www.w3.org/ns/prov#';
  const SCHEMA = 'http://schema.org/';

  // The three-layer memory regime, aligned with the node UI: every node is
  // queried per view and tagged with its layer; an entity present in more
  // than one layer keeps the strongest (VM > SWM > WM — anchored wins).
  const VIEWS = [
    ['working-memory', 'WM'],
    ['shared-working-memory', 'SWM'],
    ['verifiable-memory', 'VM'],
  ];
  const LAYER_RANK = { WM: 0, SWM: 1, VM: 2 };
  const layered = async (query) => {
    const out = [];
    for (const [view, layer] of VIEWS) {
      try {
        for (const r of await sparql(cg, view, query)) out.push({ ...r, layer });
      } catch { /* view may be empty */ }
    }
    return out;
  };

  // Claims (+ generating run + source events) inside the subgraph's graphs.
  const claimRows = await layered(
    `SELECT ?c ?text ?at ?run ?ev WHERE { GRAPH ?g {
       ?c a <${BUZZ}Claim> .
       OPTIONAL { ?c <${SCHEMA}text> ?text }
       OPTIONAL { ?c <${SCHEMA}dateCreated> ?at }
       OPTIONAL { ?run <${PROV}generated> ?c }
       OPTIONAL { ?c <${PROV}wasDerivedFrom> ?ev }
     } ${sgFilter} } LIMIT 1500`);

  // Forge artifacts (patches/issues) attributed into this subgraph.
  const forgeRows = await layered(
    `SELECT ?f ?type ?name ?at ?ev ?commit WHERE { GRAPH ?g {
       ?f a ?type . FILTER(STRSTARTS(STR(?type), "${BUZZ}"))
       FILTER(?type IN (<${BUZZ}Patch>, <${BUZZ}Issue>, <${BUZZ}StatusApplied>, <${BUZZ}StatusOpen>, <${BUZZ}Commit>))
       OPTIONAL { ?f <${SCHEMA}name> ?name }
       OPTIONAL { ?f <${SCHEMA}dateCreated> ?at }
       OPTIONAL { ?f <${PROV}wasDerivedFrom> ?ev }
       OPTIONAL { ?f <${BUZZ}commit> ?commit }
     } ${sgFilter} } LIMIT 300`);

  // Channel-wide decision clusters with their source events (for the join).
  const decisionRows = await layered(
    `SELECT ?d ?name ?t ?ev WHERE { GRAPH ?g {
       ?d a <${BUZZ}DecisionCluster> .
       OPTIONAL { ?d <${SCHEMA}name> ?name }
       OPTIONAL { ?d <${PROV}endedAtTime> ?t }
       OPTIONAL { ?d <${PROV}wasDerivedFrom> ?ev }
     } } LIMIT 8000`);

  // Explicit contestation, when modeled (first-class per the deliberation).
  let contraRows = [];
  try {
    contraRows = await sparql(cg, 'shared-working-memory',
      `SELECT ?c ?d WHERE { GRAPH ?g {
         { ?c <${BUZZ}contradicts> ?d } UNION { ?d <${PROV}wasInvalidatedBy> ?c }
       } } LIMIT 500`);
  } catch { /* not modeled yet */ }

  // Join in JS: source event URN → decisions derived from it.
  const evToDecisions = new Map();
  const decisions = new Map();
  for (const r of decisionRows) {
    const uri = term(r.d);
    const existing = decisions.get(uri);
    if (!existing) {
      decisions.set(uri, {
        id: uri, kind: 'decision',
        label: r.name ? term(r.name).slice(0, 160) : uri.split('/').pop(),
        at: r.t ? Date.parse(term(r.t)) / 1000 || null : null,
        contested: 0,
        layer: r.layer,
      });
    } else if (LAYER_RANK[r.layer] > LAYER_RANK[existing.layer]) {
      existing.layer = r.layer;
    }
    if (r.ev) {
      const ev = term(r.ev);
      if (!evToDecisions.has(ev)) evToDecisions.set(ev, new Set());
      evToDecisions.get(ev).add(uri);
    }
  }

  // Decisions curated INTO this subgraph (e.g. the `decisions` lens) go on
  // the spine even without a claim linking to them.
  try {
    const sgDecisionRows = await layered(
      `SELECT ?d WHERE { GRAPH ?g { ?d a <${BUZZ}DecisionCluster> } ${sgFilter} } LIMIT 8000`);
    for (const r of sgDecisionRows) {
      const d = decisions.get(term(r.d));
      if (d) { d.inSubgraph = true; }
    }
  } catch { /* optional */ }

  const nodes = new Map();
  const edges = [];
  const seenEdge = new Set();
  const pushEdge = (from, to, rel) => {
    const k = `${from}|${to}|${rel}`;
    if (seenEdge.has(k)) return;
    seenEdge.add(k);
    edges.push({ from, to, rel });
  };

  const upsertLayer = (id, layer) => {
    const n = nodes.get(id);
    if (n && LAYER_RANK[layer] > LAYER_RANK[n.layer]) n.layer = layer;
    return n;
  };
  for (const r of claimRows) {
    const id = term(r.c);
    if (!upsertLayer(id, r.layer)) {
      nodes.set(id, {
        id, kind: 'claim',
        label: r.text ? term(r.text).slice(0, 200) : id.split(':').pop(),
        at: r.at ? Date.parse(term(r.at)) / 1000 || null : null,
        run: r.run ? term(r.run) : null,
        layer: r.layer,
      });
    }
    if (r.ev) {
      for (const dUri of evToDecisions.get(term(r.ev)) ?? []) {
        const d = decisions.get(dUri);
        if (d) { nodes.set(dUri, d); pushEdge(id, dUri, 'supports'); }
      }
    }
  }
  for (const r of forgeRows) {
    const id = term(r.f);
    if (!upsertLayer(id, r.layer)) {
      nodes.set(id, {
        id, kind: 'commit',
        label: r.name ? term(r.name).slice(0, 160) : id.split(':').pop(),
        at: r.at ? Date.parse(term(r.at)) / 1000 || null : null,
        commit: r.commit ? term(r.commit).split(':').pop() : null,
        layer: r.layer,
      });
    }
    if (r.ev) {
      for (const dUri of evToDecisions.get(term(r.ev)) ?? []) {
        const d = decisions.get(dUri);
        if (d) { nodes.set(dUri, d); pushEdge(id, dUri, 'supports'); }
      }
    }
  }
  for (const d of decisions.values()) {
    if (d.inSubgraph) nodes.set(d.id, d);
  }
  for (const r of contraRows) {
    const c = term(r.c), d = term(r.d);
    if (nodes.has(c) && decisions.has(d)) {
      const dn = decisions.get(d);
      nodes.set(d, dn);
      dn.contested += 1;
      pushEdge(c, d, 'contradicts');
    }
  }

  // Versioned re-captures of the same thread produce multiple decision URIs
  // with the same label; merge them (keep newest) so the spine reads clean —
  // superseded versions stay addressable in the graph store, just not drawn.
  const canonicalByLabel = new Map();
  const remap = new Map();
  for (const n of nodes.values()) {
    if (n.kind !== 'decision') continue;
    const prev = canonicalByLabel.get(n.label);
    if (!prev) { canonicalByLabel.set(n.label, n); continue; }
    const keep = (n.at ?? 0) >= (prev.at ?? 0) ? n : prev;
    const drop = keep === n ? prev : n;
    canonicalByLabel.set(n.label, keep);
    remap.set(drop.id, keep.id);
    keep.contested = Math.max(keep.contested, drop.contested);
    if (LAYER_RANK[drop.layer] > LAYER_RANK[keep.layer]) keep.layer = drop.layer;
    nodes.delete(drop.id);
  }
  const finalEdges = [];
  const finalSeen = new Set();
  for (const e of edges) {
    const from = remap.get(e.from) ?? e.from;
    const to = remap.get(e.to) ?? e.to;
    const k = `${from}|${to}|${e.rel}`;
    if (from === to || finalSeen.has(k)) continue;
    finalSeen.add(k);
    finalEdges.push({ from, to, rel: e.rel });
  }

  return { gate: 'ok', cg, subgraph: safe, nodes: [...nodes.values()], edges: finalEdges };
}

/**
 * Raw triples for a subgraph, for the topology view (dkg-graph-viz input).
 * Layer-tagged per view (VM > SWM > WM on duplicates), agent-tagged from the
 * graph URI's participant segment, hard-capped server-side so the renderer
 * receives bounded input (client applies heaviest-subjects cap on top).
 */
const TRIPLES_CAP = 4000;
async function subgraphTriples(cg, name) {
  try {
    const st = await node('/api/status');
    if (!st.ok) return { gate: st.status === 401 ? 'auth' : 'node-missing' };
  } catch { return { gate: 'node-missing' }; }

  const safe = name.replace(/[^a-zA-Z0-9_-]/g, '');
  const seen = new Map(); // "s|p|o" -> entry (layer upgraded by rank)
  const RANK = { WM: 0, SWM: 1, VM: 2 };
  for (const [view, layer] of [
    ['working-memory', 'WM'],
    ['shared-working-memory', 'SWM'],
    ['verifiable-memory', 'VM'],
  ]) {
    try {
      const rows = await sparql(cg, view,
        `SELECT ?s ?p ?o ?g WHERE { GRAPH ?g { ?s ?p ?o }
           FILTER(CONTAINS(STR(?g), "/${safe}/")) } LIMIT ${TRIPLES_CAP}`);
      for (const r of rows) {
        const s = term(r.s), p = term(r.p), o = r.o;
        const key = `${s}|${p}|${o}`;
        const g = term(r.g);
        // participant segment: …/<cg-name>/<participant>/_shared_memory/…
        const m = /\/([a-z0-9_-]+)\/_(?:shared|working|verifiable)_memory\//i.exec(g);
        const existing = seen.get(key);
        if (existing) {
          if (RANK[layer] > RANK[existing.layer]) existing.layer = layer;
        } else if (seen.size < TRIPLES_CAP) {
          seen.set(key, { subject: s, predicate: p, object: o, layer, agent: m ? m[1] : safe });
        }
      }
    } catch { /* view may be empty */ }
  }
  return { gate: 'ok', cg, subgraph: safe, triples: [...seen.values()] };
}

/**
 * Evidence Envelope — the canonical agent/human seam object from the
 * humanize wrap: claim ID, sources, status, trust state, memory layer,
 * attribution, digest, relations, receipt/UAL, replay metadata. Human cards
 * and agent JSON render THIS SAME object; fields may be collapsed in UI but
 * the envelope is never thinned — unknown fields stay present as null.
 */
async function evidenceEnvelope(cg, uri) {
  try {
    const st = await node('/api/status');
    if (!st.ok) return { gate: st.status === 401 ? 'auth' : 'node-missing' };
  } catch { return { gate: 'node-missing' }; }

  const BUZZ = 'https://w3id.org/buzz-dkg/buzz#';
  const PROV = 'http://www.w3.org/ns/prov#';
  const SCHEMA = 'http://schema.org/';
  const NOSTR = 'https://w3id.org/buzz-dkg/nostr#';
  const safe = uri.replace(/[<>"\s]/g, '');

  // The entity's own triples + which graph/layer holds them.
  let layer = null;
  let graphUri = null;
  const props = new Map();
  for (const [view, tag] of [
    ['verifiable-memory', 'VM'],
    ['shared-working-memory', 'SWM'],
    ['working-memory', 'WM'],
  ]) {
    try {
      const rows = await sparql(cg, view,
        `SELECT ?p ?o ?g WHERE { GRAPH ?g { <${safe}> ?p ?o } } LIMIT 200`);
      if (rows.length > 0) {
        layer = tag;
        graphUri = term(rows[0].g);
        for (const r of rows) {
          const p = term(r.p);
          if (!props.has(p)) props.set(p, []);
          props.get(p).push(r.o);
        }
        break; // strongest layer wins (VM > SWM > WM)
      }
    } catch { /* view may be empty */ }
  }
  if (!layer) return { gate: 'ok', found: false, claimId: safe };

  const lits = (p) => (props.get(p) ?? []).map((o) => term(o));
  const sources = [...new Set(lits(`${PROV}wasDerivedFrom`))];

  // Source events: pull content + author for nostr-event sources.
  const sourceDetails = [];
  for (const ev of sources.slice(0, 12)) {
    try {
      const rows = await sparql(cg, 'shared-working-memory',
        `SELECT ?content ?pk ?at WHERE { GRAPH ?g {
           OPTIONAL { <${ev}> <${NOSTR}content> ?content }
           OPTIONAL { <${ev}> <${NOSTR}pubkeyHex> ?pk }
           OPTIONAL { <${ev}> <${NOSTR}createdAt> ?at }
         } } LIMIT 1`);
      const r = rows[0] ?? {};
      sourceDetails.push({
        id: ev,
        span: r.content ? term(r.content).slice(0, 200) : null,
        author: r.pk ? term(r.pk) : null,
        at: r.at ? Number(term(r.at)) : null,
      });
    } catch {
      sourceDetails.push({ id: ev, span: null, author: null, at: null });
    }
  }

  // Relations: what supports/derives-from this claim elsewhere.
  let relations = [];
  try {
    const rows = await sparql(cg, 'shared-working-memory',
      `SELECT ?s ?p WHERE { GRAPH ?g { ?s ?p <${safe}> .
         FILTER(?p IN (<${PROV}wasDerivedFrom>, <${BUZZ}contradicts>, <${PROV}wasInvalidatedBy>)) } } LIMIT 50`);
    relations = rows.map((r) => ({
      from: term(r.s),
      rel: term(r.p).split(/[/#]/).pop(),
    }));
  } catch { /* optional */ }

  const attribution = [
    ...new Set(sourceDetails.map((s) => s.author).filter(Boolean)),
  ];

  return {
    gate: 'ok',
    found: true,
    // — the envelope; every field always present —
    claimId: safe,
    name: lits(`${SCHEMA}name`)[0] ?? null,
    status: lits(`${SCHEMA}creativeWorkStatus`)[0] ?? (layer === 'VM' ? 'anchored' : 'shared'),
    trustState: 'provenance checked by your node',
    memoryLayer: layer,
    attribution,
    digest: lits(`${BUZZ}sourceSetDigest`)[0] ?? null,
    asOf: lits(`${PROV}endedAtTime`)[0] ?? lits(`${SCHEMA}dateCreated`)[0] ?? null,
    sources: sourceDetails,
    relations,
    receiptUal: lits(`${BUZZ}ual`)[0] ?? null,
    replay: { cg, graph: graphUri, sparqlEndpoint: '/api/query' },
  };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  try {
    if (req.method === 'OPTIONS' && url.pathname.startsWith('/api/')) {
      const cg = url.searchParams.get('cg') || '';
      const headers = SECURITY.authorize(req, cg, { preflight: true });
      res.writeHead(204, headers);
      return res.end();
    }
    if (url.pathname === '/api/channel-memory') {
      const cg = validateExplorerInput(url.searchParams.get('cg'), 'cg');
      if (!cg) throw Object.assign(new Error('cg required'), { status: 400 });
      const headers = SECURITY.authorize(req, cg);
      const out = await channelMemory(cg);
      res.writeHead(200, { 'content-type': 'application/json', ...headers });
      return res.end(JSON.stringify(out));
    }
    if (url.pathname === '/api/subgraph-graph') {
      const cg = validateExplorerInput(url.searchParams.get('cg'), 'cg');
      const name = validateExplorerInput(url.searchParams.get('name'), 'name');
      const headers = SECURITY.authorize(req, cg);
      const out = await subgraphGraph(cg, name);
      res.writeHead(200, { 'content-type': 'application/json', ...headers });
      return res.end(JSON.stringify(out));
    }
    if (url.pathname === '/api/subgraph-triples') {
      const cg = validateExplorerInput(url.searchParams.get('cg'), 'cg');
      const name = validateExplorerInput(url.searchParams.get('name'), 'name');
      const headers = SECURITY.authorize(req, cg);
      const out = await subgraphTriples(cg, name);
      res.writeHead(200, { 'content-type': 'application/json', ...headers });
      return res.end(JSON.stringify(out));
    }
    if (url.pathname === '/api/evidence') {
      const cg = validateExplorerInput(url.searchParams.get('cg'), 'cg');
      const uri = validateExplorerInput(url.searchParams.get('uri'), 'uri');
      const headers = SECURITY.authorize(req, cg);
      const out = await evidenceEnvelope(cg, uri);
      res.writeHead(200, { 'content-type': 'application/json', ...headers });
      return res.end(JSON.stringify(out));
    }
    if (url.pathname === '/api/contributor-trail') {
      const cg = validateExplorerInput(url.searchParams.get('cg'), 'cg');
      const pk = validateExplorerInput(url.searchParams.get('pubkey'), 'pubkey');
      const headers = SECURITY.authorize(req, cg);
      const out = await contributorTrail(cg, pk);
      res.writeHead(200, { 'content-type': 'application/json', ...headers });
      return res.end(JSON.stringify(out));
    }
    if (url.pathname === '/api/resolve') {
      const cg = validateExplorerInput(url.searchParams.get('cg'), 'cg');
      const ual = validateExplorerInput(url.searchParams.get('ual'), 'ual');
      const headers = SECURITY.authorize(req, cg);
      const out = await resolve(cg, ual);
      res.writeHead(200, { 'content-type': 'application/json', ...headers });
      return res.end(JSON.stringify(out));
    }
    if (url.pathname === '/explore') {
      const cg = url.searchParams.get('cg') ?? '';
      const ual = url.searchParams.get('ual') ?? '';
      if (SECURITY.gateway) {
        throw Object.assign(new Error('interactive explorer links are local-only'), { status: 404 });
      }
      // Gate server-side first: a viewer whose node participates in the CG is
      // handed straight into their edge node's own UI, landed on the KA.
      // Only a failing gate renders this explorer's instruction page.
      if (cg && ual) {
        try {
          const out = await resolve(cg, ual);
          if (out.gate === 'ok') {
            res.writeHead(302, { location: nodeUiUrl(out) });
            return res.end();
          }
        } catch {
          /* fall through to the instruction page */
        }
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(page(cg, ual));
    }
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('local-first DKG explorer — open a receipt link: /explore?ual=<ka>&cg=<contextGraphId>\n');
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  } catch (err) {
    res.writeHead(err.status ?? 500, { 'content-type': 'application/json', ...(err.headers || {}) });
    res.end(JSON.stringify({ error: String(err.message ?? err) }));
  }
});

server.listen(PORT, BIND, () => {
  console.log(`local-first DKG explorer on http://${BIND}:${PORT}`);
  console.log(`  node API: ${NODE_API} (token ${TOKEN ? 'loaded' : 'MISSING'})`);
  console.log(`  mode: ${SECURITY.gateway ? 'authenticated community gateway' : 'loopback viewer'}`);
});
