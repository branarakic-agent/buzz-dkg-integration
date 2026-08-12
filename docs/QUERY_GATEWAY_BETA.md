# Beta query and agent-memory gateway

The daemon can expose loopback-only query and agent-memory HTTP endpoints for a
trusted Buzz authorization front. They are disabled by default. The V1a
installer enables them on `127.0.0.1:9296` and creates a separate 64-hex bearer
token. The relay remains the public authorization boundary; clients never
receive this token or DKG credentials.

## Environment

```dotenv
BDI_QUERY_GATEWAY_ENABLED=true
BDI_QUERY_GATEWAY_BIND=127.0.0.1
BDI_QUERY_GATEWAY_PORT=9296
BDI_QUERY_GATEWAY_TOKEN=<32-to-512-character-secret>
```

Only literal `127.0.0.1` and `::1` binds are accepted. Optional bounded
settings are `BDI_QUERY_GATEWAY_MAX_BODY_BYTES`,
`BDI_QUERY_GATEWAY_MAX_RESULT_BYTES`, `BDI_QUERY_GATEWAY_MAX_QUERY_BYTES`,
`BDI_QUERY_GATEWAY_TIMEOUT_MS`, `BDI_QUERY_GATEWAY_DKG_TIMEOUT_MS`,
`BDI_QUERY_GATEWAY_MAX_CONCURRENT`, `BDI_QUERY_GATEWAY_MAX_DKG_CONCURRENT`,
`BDI_QUERY_GATEWAY_MAX_DKG_QUEUE`, `BDI_QUERY_GATEWAY_CACHE_TTL_MS`, and
`BDI_QUERY_GATEWAY_MAX_CACHE_ENTRIES`. The DKG concurrency ceiling is global
to the gateway: one summary request cannot bypass it by fanning out into many
triple-store reads. Identical in-flight requests are coalesced, and successful
results are cached for the configured short TTL.
The defaults serialize DKG reads and cache successful results for two minutes,
which aligns with a Core node's single background store lane while still
allowing memory writes to invalidate their channel immediately.

The installer uses a 120-second end-to-end gateway deadline. Individual DKG
lifecycle calls use a 180-second deadline. Memory submission returns HTTP `202`
with `state: "processing"` after the signed envelope and operation intent are
durably recorded; slow finalize/share work continues on the crash-recoverable
daemon queue rather than holding the agent's HTTP request open. A client polls
by resubmitting the exact same signed envelope. The proposal event ID makes
that retry idempotent. The endpoint returns HTTP `200` with `state: "stored"`
only after the graph is queryable.

A same-host Buzz authorization front should use:

```dotenv
BUZZ_DKG_QUERY_URL=http://127.0.0.1:9296/v1/query
BUZZ_DKG_QUERY_TOKEN=<same secret as BDI_QUERY_GATEWAY_TOKEN>
BUZZ_DKG_MEMORY_ENABLED=true
```

The relay derives the companion memory endpoint from that URL and forwards to
`/v1/memory` with the same token. `BUZZ_DKG_MEMORY_ENABLED` is deliberately
separate from query configuration: set it only when the integration supports
`/v1/memory`. A compatible relay advertises both `buzz-dkg-memory-v1` and
`buzz-dkg-memory-v2` through NIP-11, plus a `dkg_memory` descriptor containing
the supported schema versions, ontology profiles, adapter profiles, proposal
kind, and fixed query operations. Agents use v2 only when both the extension
and descriptor agree; v1 remains a compatibility path.

If an adopted relay remains on a Docker bridge, its `127.0.0.1` is not the
host-networked daemon's loopback. The query bridge supports two bounded
transports without weakening the gateway bind.

On hosts that allow container-to-host-gateway traffic, bind the bridge to the
Docker network's private host-gateway address and point the relay at it:

```dotenv
BDI_QUERY_BRIDGE_BIND=172.18.0.1
BDI_QUERY_BRIDGE_PORT=9297
BUZZ_DKG_QUERY_URL=http://172.18.0.1:9297/v1/query
```

The bridge binds only the explicit RFC1918 address, carries no credential, and
forwards opaque TCP to the loopback gateway. The relay still supplies the
dedicated bearer token and the gateway still enforces it. Discover the actual
gateway with `docker network inspect`; do not assume the example address.

On hosts whose firewall blocks that traffic, use a shared Unix socket and two
credential-free bridge processes. The host-networked process listens on the
socket and forwards to the gateway; the second process shares the relay's
network namespace, listens only on that namespace's loopback, and forwards to
the socket:

```dotenv
# host-networked bridge
BDI_QUERY_BRIDGE_LISTEN_SOCKET=/runtime/query-gateway.sock
BDI_QUERY_GATEWAY_PORT=9296

# bridge sharing the relay network namespace
BDI_QUERY_BRIDGE_BIND=127.0.0.1
BDI_QUERY_BRIDGE_PORT=9297
BDI_QUERY_BRIDGE_TARGET_SOCKET=/runtime/query-gateway.sock

# relay
BUZZ_DKG_QUERY_URL=http://127.0.0.1:9297/v1/query
BUZZ_DKG_MEMORY_ENABLED=true
```

Mount the same private runtime directory into both bridge processes and run
them as the runtime directory owner. The listener refuses to replace a
non-socket path and creates the socket with mode `0660`.

## Request contract

Send `POST /v1/query`, `Content-Type: application/json`, and
`Authorization: Bearer <token>`. The request object has exactly these fields:

```json
{
  "channelId": "channel-one",
  "operation": "channel_memory",
  "arguments": {},
  "requesterPubkey": "<64-hex-pubkey>"
}
```

The operation and its exact arguments are:

| operation               | arguments                                       | result                                                                                                                        |
| ----------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `channel_memory`        | `{}`                                            | `{ layers: { WM: null, SWM, VM }, decisions, contributors, subgraphs }`                                                       |
| `contributor_trail`     | `{ pubkey }`                                    | `{ pubkey, trail }`                                                                                                           |
| `software_contributors` | `{ repository, componentName, componentType? }` | `{ repository, componentName, componentType, contributors }`                                                                  |
| `decision_trace`        | `{ repository, commitSha, componentName }`      | `{ repository, commitSha, componentName, decisions }`                                                                         |
| `subgraph_graph`        | `{ name }`                                      | `{ subgraph, nodes, edges }`                                                                                                  |
| `subgraph_triples`      | `{ name }`                                      | `{ subgraph, triples }`                                                                                                       |
| `evidence`              | `{ uri }`                                       | `{ found, claimId, name, status, trustState, memoryLayer, attribution, digest, asOf, sources, relations, receiptUal, graph }` |
| `semantic_query`        | `{ sparql, view? }`                             | `{ queryType, scope, cost, layers }`                                                                                          |

`semantic_query` additionally requires `"scope":{"type":"current_channel"}`.
It is the unified agent-facing read operation: an authenticated agent authors a
SPARQL `SELECT`, `ASK`, or bounded `CONSTRUCT`, while the relay supplies the
requester identity and the integration resolves the channel's Context Graph.
For example:

```json
{
  "channelId": "channel-one",
  "operation": "semantic_query",
  "scope": { "type": "current_channel" },
  "arguments": {
    "sparql": "SELECT ?decision ?name WHERE { GRAPH ?g { ?decision <http://schema.org/name> ?name } } LIMIT 25",
    "view": "both"
  },
  "requesterPubkey": "<64-hex-pubkey>"
}
```

The SPARQL 1.1 AST is checked before it reaches DKG. Updates, DESCRIBE,
`FROM`, `SERVICE`, explicit graph identifiers, unconstrained `?s ?p ?o`
scans, and unbounded property paths are rejected. `SELECT` and `CONSTRUCT`
require `LIMIT` (maximum 100). A structural cost budget also bounds triples,
optionals, unions, subqueries, `VALUES`, and variable predicates. Rejections
use `unsafe_query` or `query_too_expensive` and include
`error.details.suggestions` so an agent can make the query smaller and retry.
Aggregate, grouping, ordering, and distinct operations carry high cost; agents
should usually fetch a small row set and process it locally.
Accepted semantic queries have a 10-second DKG execution ceiling in addition
to the gateway's concurrency and response-size limits.

A successful response is:

```json
{
  "ok": true,
  "channelId": "channel-one",
  "cg": "did:dkg:otp/0xabc/42",
  "operation": "channel_memory",
  "result": {}
}
```

`cg` is returned for transparency but is always resolved from the daemon's
configured channel bindings. Requests cannot supply a Context Graph, DKG URL,
token, or write operation. SPARQL is accepted only inside `semantic_query` and
only under the current-channel scope above. Unknown fields are rejected.
Retrieval is limited to shared working memory and verifiable memory; working
memory is never queried and is represented as `null`.

Errors use `{ "ok": false, "error": { "code": "...", "message": "...", "details": {} } }`;
`details` is present only when structured correction guidance is available.
Responses and structured audit logs never include gateway or DKG credentials or
raw upstream failures.

`repository` is a canonical HTTPS clone-page URL such as
`https://github.com/acme/api`. The relay and sidecar normalize GitHub casing,
an optional `.git` suffix, and trailing slashes. Requiring repository scope
prevents two unrelated projects' identically named functions from being
combined by a competency query.

## Agent-memory write contract

Only the relay calls `POST /v1/memory`. Its exact envelope contains a channel
UUID, authenticated requester pubkey, one fully signed kind-`40009` proposal,
and the fully signed source events referenced by that proposal. The sidecar
independently verifies every signature and ID, exact `h` channel tags, source
markers, requester/author equality, source-set equality, semantic bounds, and
that the agent authored at least one source. It does not trust the relay to
construct RDF.

Schema v2 always selects `dkg-memory@1` and may add `dkg-software@1`. The Buzz
adapter attaches `buzz-nostr@1`; agents cannot select it. The sidecar validates
all profile types, relation predicates, literal attributes, locators, and
bounds before minting RDF identifiers. Direct edges support ordinary SPARQL
joins, while reified assertion nodes carry confidence and signed evidence.
Schema v1 still compiles through its unchanged legacy graph path.

For a valid proposal the sidecar deterministically creates or reuses that
channel's private Context Graph, compiles provenance-bearing RDF, writes Working
Memory, promotes it to Shared Working Memory, and records a terminal local
operation. The proposal event ID is the idempotency key, so retries do not
duplicate graph state. This beta performs no Verifiable Memory publication and
emits no relay chat event for the background write.

The public response exposes one stable `operationId` and only two lifecycle
states. Internal recovery phases are intentionally hidden:

```json
{
  "ok": true,
  "outcome": "accepted",
  "operationId": 42,
  "proposalEventId": "<64-hex-event-id>",
  "channelId": "<channel-uuid>",
  "contextGraphId": "buzz-<deterministic-id>",
  "state": "processing"
}
```

An idempotent poll changes `outcome` to `duplicate` and eventually changes
`state` to `stored`. Clients must not claim that memory was recorded while the
state is `processing`.

The normative beta profiles, SHACL shapes, lifelike fixture, and executable
competency queries ship in the installer under `ontology/`. The acceptance
suite proves queries including “who edited this function?” and “what decisions
behind this commit affected this component?” as well as non-software tasks and
cross-profile evidence traces.
