# Transactional Evidence Prune

`arena-evidence prune` is the only ordinary Evidence Service operation that
removes retained raw artifacts. It never removes the workspace, datasets, jobs,
profiles, exports, logs, or externally owned files.

## Dry run

```powershell
node src/cli.mjs prune --before 2026-01-01T00:00:00Z
```

A dry run:

- accepts only a complete UTC timestamp ending in `Z`;
- performs interrupted-prune recovery first;
- counts eligible catalog artifacts and bytes with an aggregate query;
- records an audit row;
- does not enumerate, hash, move, or delete candidate files.

Artifacts still referenced by a collecting dataset are not eligible.

## Confirmed prune

```powershell
node src/cli.mjs prune `
  --before 2026-01-01T00:00:00Z `
  --confirm PRUNE
```

Only the exact `PRUNE` token enables deletion. A confirmed operation:

1. acquires one compare-and-swap lease in the Evidence catalog;
2. recovers any prior quarantine operation;
3. freezes candidate membership in one exclusive SQLite transaction;
4. validates every stored artifact path, regular-file identity, size, and
   SHA-256;
5. atomically renames each candidate into
   `artifacts/.prune-quarantine/<operation-uuid>/`;
6. validates the staged file again before deleting any catalog row for it;
7. deletes matching observation and artifact rows, reconciles dataset counts,
   and inserts the confirmed audit in the same transaction;
8. commits the catalog transaction;
9. deletes the quarantined files, finalizes the audit, and removes the operation
   marker.

A returned `cleanupPending: true` means catalog deletion committed but an owned
quarantine cleanup or final marker step remains. The next prune command recovers
that operation before evaluating new candidates.

## Crash and failure behavior

- A crash before SQLite commit rolls the catalog back. The next prune sees the
  retained artifact rows and restores validated quarantine files to their exact
  catalog paths.
- A crash after commit sees absent artifact rows plus the matching confirmed
  pending audit and finishes quarantine deletion.
- A database or audit failure restores already staged files after rollback.
- An altered staged file is never restored beneath an authoritative catalog
  path. It remains quarantined and the failure is visible.
- A rowless quarantine file is never deleted without a matching confirmed
  pending audit for the same operation UUID.
- Mixed, malformed, symlinked, path-escaping, digest-mismatched, or otherwise
  ambiguous recovery state fails closed and remains untouched.

## Concurrency

Recovery, dry-run audit, destructive mutation, rollback restoration, cleanup,
and final audit update share one catalog-backed operation lease. The lease uses
an immutable PID/nonce owner value and a heartbeat row. A second process cannot
recover or mutate the same quarantine while the first lease is live and fresh.
Stale takeover is serialized by `BEGIN IMMEDIATE`, and every release is
conditioned on the exact owner value.

## Result

The command returns `uci_arena_evidence_prune_result_v2`. Existing fields remain
present:

- `before`
- `confirmed`
- `artifactCount`
- `bytes`
- `deleted`

The v2 result also identifies the operation/audit, staged count, cleanup state,
quarantine marker when pending, and work recovered before the new operation.
