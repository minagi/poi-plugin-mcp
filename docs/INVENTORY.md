# Versioned inventory observations

`GET /inventory/snapshot` reads a consistent, versioned observation of Poi's Redux
cache. `GET /inventory/events` and `/inventory/events/wait` expose record changes
from `store.subscribe()`. No game requests are issued and no Redux actions are
dispatched. A cache snapshot is not proof that every server-side inventory source
has been loaded or is complete.

The HTTP endpoints are loopback read-only endpoints, like `/all`. HTTP MCP and
stdio MCP also expose `get_inventory_snapshot` and `get_inventory_events`.
MCP resource subscriptions remain disabled; use HTTP long polling for waiting.

## Snapshot and continuation

1. Read `/inventory/snapshot`. Require `available: true` and `schemaVersion: 1`.
2. Install its `sources[*].records`, retaining each source's availability and
   revision. Keep the snapshot's `sessionId` and global `revision` as the fence.
3. Request `/inventory/events/wait?after=REV&sessionId=SESSION&limit=256&timeoutMs=30000`.
4. Apply events in revision order, replacing each `changes[*].upserts` record and
   removing only explicit `removedIds`. Advance to the **last applied event**,
   never directly to `latestRevision` when a response contains a limited batch.
5. Repeat. A timeout is a normal idle result, not a disconnected or deleted source.

Each event has one global `revision`, `capturedAt`, and a `changes` array. Each
change has `source`, `sourceRevision`, `available`, `error`, `baseline`, an ID-keyed
`upserts` object and `removedIds`. Snapshots contain the same session and global
revision plus an ID-keyed record map for each source. The initial observation is
revision zero and produces no mass-addition event.

Supported sources: ships, equipment, active_quests, quest_records, fleets,
resources, repairs, constructions, airbase, useitems, basic, maps. Ship and
equipment IDs are instance IDs. Airbase keys are `area:rid`; resources use IDs
1–8 and `{name, value}` records; basic uses one `basic` record. Quest list pages
are not the active-quest or quest-progress stores and remain separate telemetry.

## Recovery and guarantees

- `resyncRequired: true` at response level means a session mismatch, an ahead
  cursor or an evicted history range. Obtain a new snapshot. Events larger than
  the single-event budget publish an explicit invalidation event with
  `resyncRequired: true`; do not treat its empty changes array as no change.
- The ring retains at most 256 events and 32 MiB; a delta larger than 8 MiB is
  invalidated rather than silently truncated. A snapshot can be newer than
  pending events; discard events already covered by its fence. Reject a stale
  snapshot within the same session.
- A missing/malformed source is unavailable, retaining its last valid record
  map. It never emits removals. A valid empty inventory does emit removals.
- Source row order and unrelated Redux changes do not produce inventory events.
  Record fields are retained, including optional/null fields; source references
  rely on Redux's immutable state contract.
- Availability changes are versioned observations too. `baseline: true` marks
  the first valid records of an initially unavailable source.
- Inventory revisions and action-event generations are independent streams.
  They must not be compared or treated as a proven one-to-one cause mapping.
- Observing committed store values includes cache changes absent from the action
  event whitelist (for example equipment locks). It does not restore changes
  before attachment, lost history, or updates Poi never reflected in its store.
- If a subscribable Poi store cannot be located, `available: false` explicitly
  reports `store_subscription_unavailable`; callers may use action-triggered
  snapshots plus periodic reconciliation instead.

The subscriber and pending waits are removed when the bridge stops. Restarting
the bridge creates a new inventory session.
