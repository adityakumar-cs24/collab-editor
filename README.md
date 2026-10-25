# collab-editor

A real-time, offline-first collaborative text editor built around a sequence CRDT implemented from scratch.

**Status:** early development.

## Goal

Two or more people edit one document at the same time, see each other's live cursors, keep editing offline, and always converge to identical text.

## Why not just use indexes?

`packages/crdt/src/naive` contains a deliberately naive index-based implementation, and a test showing it diverges when two users edit concurrently. That is the problem the CRDT solves.

## Repo layout

- `packages/crdt`: the CRDT library (no networking)
- `packages/protocol`: shared message types
- `apps/server`: WebSocket server
- `apps/client`: editor client
- `bench`: benchmarks
- `docs`: design notes
