# OT-RFC-67 — live reference instance (Beta V1 precursor)

This document records a **running instance** of the deployment shape specified in
[OT-RFC-67 § Reference Deployment — Buzz + DKG Beta V1](https://github.com/OriginTrail/dkgv10-spec/pull/147):
an established Buzz community that gained a community DKG provider **without moving the
community, changing its relay identity, or asking members to run infrastructure**.

It was assembled by hand (launchd + scripts), predating the `buzz-dkg install`
product interface the RFC proposes — it is evidence that the shape works, not a
conforming installer.

## Topology

```text
Existing Buzz member (desktop app, unchanged Nostr identity)
  -> signed Nostr events
  -> existing Buzz Relay (adopted in place; URL/identity/history preserved)
  -> @dkg projector daemon (verifies, maps to RDF, replays + follows live)
  -> Web of Trust Context Graph on the community DKG Edge node (v10, mainnet)
  -> community provider (read-only explorer API, private-network TLS)
  -> Memory panel in Buzz
```

- **Relay**: pre-existing `buzz-relay`, adopted untouched — same URL, identity,
  history, channels, membership. Now supervised (launchd KeepAlive).
- **DKG node**: Edge node (DKG v10) beside the relay; Working / Shared Working /
  Verifiable Memory; ~200 decisions across per-participant sub-graphs in the
  community's stable Context Graph.
- **Projector**: the `@dkg` daemon + [`wot-autocapture.mjs`](../../wot-autocapture.mjs)
  (event → KA with preserved event id, author, digest; idempotent versioned
  writes; per-participant sub-graphs).
- **Community provider**: [`explorer/local-explorer.mjs`](../../explorer/local-explorer.mjs)
  — loopback by default; `EXPLORER_BIND=0.0.0.0` opts into community-provider
  mode, published to members over a private network (Tailscale) behind TLS.
  Gateway mode additionally requires an explicit served-CG allowlist, caller
  secret, expected Host/origin allowlists, and rate limit. Per the RFC:
  private-network operation, reported as such, never presented as public.
- **Client**: Buzz desktop with the memory-panel feature
  ([patch](../../patches/buzz-desktop-dkg-memory-gateway.patch)) resolving
  local-node → community provider → discovery, in that order.

## The trust boundary, rendered honestly (three states)

| State | Label in UI | When |
|---|---|---|
| 🟢 | **✓ Verified through your node** | viewer runs a participating DKG node |
| 🔵 | **✓ Resolved through the community DKG provider** (RFC-normative wording) | no local node; provider reachable — full memory, operator-identical |
| 🟡 | **Shown for discovery — unverified (via relay receipts)** | provider unreachable; relay receipts only |

| Verified (own node) | Community provider | Discovery (degraded) |
|---|---|---|
| ![verified](screenshots/verified-own-node.png) | ![provider](screenshots/community-provider.png) | ![discovery](screenshots/discovery-degraded.png) |

Evidence trails resolve end-to-end (decision → its source messages, checked by
the resolving node):

![evidence trail](screenshots/evidence-trail.png)

Any sub-graph opens into **Traces** (the decision timeline with evidence
hanging off each box) or **Graph** — the knowledge graph in the DKG node's own
visual idiom (dark canvas, hexagonal entities, entity-type colors, the node's
click-inspector), so the Buzz surface and the node UI read as one product:

![graph view, node-UI parity](screenshots/graph-node-parity.png)

## Acceptance criteria observed on this instance

Mapped to the RFC's Beta V1 release-candidate checks (manual instance — not a
conforming-installer run):

| # | Criterion | Observed |
|---|---|---|
| 2 | relay URL/identity unchanged; existing clients stay connected | ✅ members' apps continued uninterrupted through provider install |
| 3 | historical events → provenance-preserving triples in the stable graph | ✅ idempotent replay of channel history into versioned KAs |
| 4 | new attestations projected live and displayed through the provider | ✅ live capture → panel, end-to-end |
| 5 | restart + replay preserve graph identity, no duplicates | ✅ versioned-KA idempotency; node restarts survived |
| 6 | provider outage rendered honestly | ✅ degraded state is the labeled discovery mode, never silent emptiness |
| — | zero automatic Verifiable Memory spend | ✅ VM publication human-authorized only |
| 1, 7, 8 | plan/inspect, upgrade/backup-restore, clean uninstall | ⬜ installer-level — not exercised by this manual instance |

Distinct-viewer verification: members with **no DKG node** (macOS + Windows test
builds) see the identical memory the operator sees, under the 🔵 label; the
operator's own view resolves 🟢 through their node. All three states are covered
by e2e tests in the client patch.

## What this instance does not claim

No `buzz-dkg` installer, no adoption planner, no managed backup/rollback, no
Part-2 `ReputationProvider` envelope on the provider API (it serves the memory
surface, not trust-claim discovery), and no per-member authorization beyond the
gateway secret plus private-network access control. Those are precisely the
gaps Beta V1 specifies the product should close.
