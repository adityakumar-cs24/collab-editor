# collab-editor

[![CI](https://github.com/adityakumar-cs24/collab-editor/actions/workflows/ci.yml/badge.svg)](https://github.com/adityakumar-cs24/collab-editor/actions/workflows/ci.yml)

A real-time, offline-first collaborative text editor built around a sequence CRDT implemented from scratch. It is built around one hard problem: when several people edit the same document at the same time (including while offline), every copy must end up identical, with no central server deciding the order of edits.

## What this project demonstrates

Every claim below is backed by a test in this repository.

- **A naive design provably fails.** An index-based implementation diverges on a two-user concurrent edit, silently, with no error (see "The problem").
- **Convergence under random concurrency.** Property-based fuzzing simulates 3 and 10 replicas making random inserts and deletes, with out-of-order and duplicated delivery. Every replica ends with identical text, an empty pending buffer, and exactly one node per insert (nothing lost, nothing duplicated).
- **Out-of-order delivery is handled.** Operations that arrive before their dependency are parked and applied automatically when it shows up. A 11-character chain delivered in reverse order still produces the right text.
- **Idempotent operations.** Delivering the same operation repeatedly changes nothing.
- **A total order on character ids**, verified as properties (antisymmetric, transitive, unique keys), because every replica must break ties identically.
- **A pure, dependency-free core.** The CRDT has no networking or I/O, so it can be tested exhaustively and shared between client and server.

## Status: CRDT core complete, networking not started

## Roadmap

- [x] Monorepo, TypeScript, Vitest, CI
- [x] Naive index-based version, with a test showing it diverges
- [x] Character ids and Lamport clock
- [x] RGA sequence: insert, delete, tombstones
- [x] Causal buffering and idempotence
- [x] Multi-replica fuzz harness
- [ ] WebSocket server and two-tab sync
- [ ] Version-vector sync and reconnect
- [ ] Offline queue (IndexedDB)
- [ ] Live cursors anchored to character ids
- [ ] Persistence (PostgreSQL) and multi-instance fan-out (Redis)
- [ ] Benchmarks against Yjs, tombstone compaction
- [ ] Demo video and design document

## Tech Stack

**Used so far:** TypeScript, Vitest, fast-check (property-based testing), pnpm workspaces, GitHub Actions

**Planned:** Node.js and `ws`, IndexedDB, CodeMirror 6, PostgreSQL, Redis, Docker Compose

## The problem

Identifying a position by integer index is unstable once other people are editing. Both users start with `ABC`. Alice inserts `X` at index 1; at the same moment Bob deletes the character at index 1 (`B`). Then they exchange operations.

| Design | Alice ends with | Bob ends with | Converged |
| --- | --- | --- | --- |
| Naive (index based) | `ABC` | `AXC` | No, and no error is raised |
| RGA (this project) | `AXC` | `AXC` | Yes |

Bob's "delete index 1" reached Alice after her insert had shifted the text, so it removed `X` instead of `B`. The naive version lives in `packages/crdt/src/naive` with a test that asserts the divergence.

## How it works

- **Every character has a permanent id** `(counter, siteId)`. `siteId` identifies the replica; `counter` is a Lamport clock (incremented on every local operation, and advanced to the largest counter seen from others). Ids are totally ordered: counter first, siteId as the tiebreaker.
- **Operations refer to ids, never indexes.** "Insert Y after character `(2, alice)`" means the same thing on every replica regardless of what else changed.
- **Concurrent inserts after the same character** are ordered by one rule: skip over any following node with a greater id. Every replica applies the same rule, so they agree without talking to each other.
- **Deletes create tombstones.** The node stays in the sequence, marked deleted, so later operations that reference it still resolve.
- **Causal buffering.** An insert is ready when its origin exists; a delete is ready when its target exists. Anything else waits in a pending buffer (deduplicated by operation id) and is applied as soon as its dependency arrives, which can unblock a whole chain.
- **Idempotence.** An insert whose id already exists is ignored; deleting an already deleted character is harmless.

## Verified behaviour

| Scenario | Result |
| --- | --- |
| The `ABC` scenario that breaks the naive version | Both replicas `AXC` |
| Alice inserts `X`, Bob inserts `Y`, both after `A` in `AC` | Both `AYXC` (equal counters, `"bob"` > `"alice"`, so `Y` goes first) |
| Same operations delivered twice | No change, node count unchanged |
| Two replicas delete the same character | Both `ac` |
| Insert arrives before the character it follows | Parked (pending 1), applied when the origin arrives (pending 0) |
| 11 inserts delivered in reverse order | Correct text, pending 0 |
| Delete arrives before the insert it targets | Parked, applied right after the insert lands |
| Same pending operation delivered 3 times | Queued once |
| 100 random delivery orders of a 14 operation history | Identical text every time |
| Fuzz: 3 replicas, up to 100 random actions, 500 runs | All replicas identical |
| Fuzz: 10 replicas, up to 200 random actions, 200 runs | All replicas identical |

## Fuzz testing

`packages/crdt/src/testing/simulate.ts` simulates a small distributed system. Each replica has an inbox standing in for the network. A generated history is a list of actions: either a replica edits locally (the operation is queued for every other replica), or a replica takes a random message from its inbox (so delivery is out of order), optionally leaving it there so it is delivered again (duplicates). At the end everything still undelivered is drained in reverse order. For every replica the test then asserts:

1. identical text,
2. an empty pending buffer,
3. node count equal to the total number of inserts.

fast-check generates and shrinks the histories, so a failure is reported as a minimal list of actions plus a seed that replays it.

## Found by testing

The first run of the id tests failed. The property test for antisymmetry reported the counterexample `{18, "a"}` versus `{18, "a"}`: two identical ids. The comparator was right (it returns 0 both ways); the test was wrong. It compared `Math.sign(0)` with `-Math.sign(0)`, and JavaScript distinguishes `+0` from `-0` under `Object.is`. The fix compares with `===`. The failure is kept as a reminder to ask "code or test?" first when a property test fails.

## Running the tests

```
pnpm install
pnpm test        # 28 tests, runs in under a second
pnpm typecheck
```

CI runs the same two commands on every push.

## Known limitations

- **No networking yet.** Replicas only talk through the in-memory simulator. There is no server, client, persistence, or offline queue.
- **The fuzz harness models delay, reordering and duplication, but not permanent loss or partitions.** Every operation is eventually delivered to every replica. Reconnect and partition behaviour comes with the sync protocol.
- **Linear-time operations.** Lookups scan the node array, local edits filter it, and draining the pending buffer rescans it. Fine for correctness work; the benchmark phase will measure and improve it.
- **Tombstones are never removed**, so memory grows with every deletion. Compaction is planned after it is measured.
- **`siteId` uniqueness is assumed, not enforced.** Two replicas sharing a site id would generate colliding character ids.
- **No input validation yet.** The `char` field is not checked to be a single character, and the pending buffer is unbounded, so an operation whose dependency never arrives waits forever.
- **Interleaving behaviour is not tested yet.** Two users typing at the same position can have their characters interleaved; this will be studied and documented.
- **Plain text only.** Rich text is out of scope.

## Design decisions

- **CRDT, not Operational Transformation.** Operations commute, so convergence is a property of the data structure that can be fuzz tested directly, and offline editing needs no central ordering server.
- **Zero-dependency core.** `packages/crdt` has no I/O, so the same code runs in the browser and on the server.
- **Deletes get their own operation id**, so every operation is identifiable. Version vectors for reconnect sync will rely on this.
- **One code path for local and remote operations.** Local edits go through the same `integrate` method as remote ones, so the fuzz tests exercise what users actually run.
- **Fuzz harness kept outside the test file** so later phases (partitions, offline) can reuse it.
- **Strict TypeScript** with `noUncheckedIndexedAccess`, because index-heavy data structure code is full of "this element might not exist" bugs.

## Project structure

```
packages/
  crdt/
    src/
      id.ts            character ids and total order
      clock.ts         Lamport clock
      rga.ts           the sequence CRDT
      naive/           the index-based version that fails
      testing/         multi-replica simulator
      *.test.ts        unit, property and fuzz tests
  protocol/            (planned) shared message types
apps/
  server/              (planned) WebSocket server
  client/              (planned) editor client
bench/                 (planned) benchmarks
docs/                  (planned) design notes
```
