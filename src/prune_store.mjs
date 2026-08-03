import { randomUUID } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const PRUNE_LOCK_KEY = "prune_operation_lock";
const PRUNE_HEARTBEAT_KEY = "prune_operation_heartbeat";
const PRUNE_HEARTBEAT_STALE_MS = 30_000;
const SHA256 = /^[0-9a-f]{64}$/u;

function safeCount(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`Evidence prune ${label} is not a non-negative safe integer`);
  }
  return number;
}

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function parseObject(text, label) {
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("value is not an object");
    }
    return value;
  } catch (error) {
    throw new Error(`${label} contains invalid JSON: ${error.message}`);
  }
}

function parseAuditResult(text, auditId) {
  return parseObject(text, `Evidence prune audit ${auditId}`);
}

function candidateRow(row) {
  const sha256 = String(row.sha256);
  if (!SHA256.test(sha256)) {
    throw new Error(`Evidence prune artifact identity is noncanonical: ${sha256}`);
  }
  return {
    sha256,
    path: String(row.path),
    sizeBytes: safeCount(row.size_bytes, `artifact ${sha256} size`),
    createdAt: String(row.created_at),
  };
}

export class PruneStore {
  constructor(filename, { Database = DatabaseSync } = {}) {
    if (typeof filename !== "string" || !filename.trim()) {
      throw new Error("PruneStore requires a catalog filename");
    }
    this.filename = path.resolve(filename);
    this.database = new Database(this.filename, {
      timeout: 5_000,
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
    });
    this.database.exec(`
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000;
      CREATE TEMP TABLE IF NOT EXISTS prune_candidates (
        sha256 TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        created_at TEXT NOT NULL
      ) WITHOUT ROWID;
    `);
    this.closed = false;
  }

  close() {
    if (this.closed) return;
    this.database.close();
    this.closed = true;
  }

  assertOpen() {
    if (this.closed) throw new Error("PruneStore is closed");
  }

  acquireOperationLease({
    pid = process.pid,
    processAliveImpl = processAlive,
    nowMs = () => Date.now(),
  } = {}) {
    this.assertOpen();
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      throw new Error("Evidence prune lease pid must be a positive safe integer");
    }
    if (typeof processAliveImpl !== "function" || typeof nowMs !== "function") {
      throw new Error("Evidence prune lease dependencies are invalid");
    }

    const acquiredAtMs = nowMs();
    if (!Number.isSafeInteger(acquiredAtMs) || acquiredAtMs < 0) {
      throw new Error("Evidence prune lease clock is invalid");
    }
    const owner = {
      schema: "uci_arena_evidence_prune_lock_v1",
      pid,
      nonce: randomUUID(),
      acquired_at: new Date(acquiredAtMs).toISOString(),
    };
    const ownerJson = JSON.stringify(owner);
    const heartbeatJson = JSON.stringify({
      schema: "uci_arena_evidence_prune_heartbeat_v1",
      nonce: owner.nonce,
      heartbeat_ms: acquiredAtMs,
    });

    this.database.exec("BEGIN IMMEDIATE");
    try {
      const ownerRow = this.database.prepare(`
        SELECT value FROM metadata WHERE key=?
      `).get(PRUNE_LOCK_KEY);
      const heartbeatRow = this.database.prepare(`
        SELECT value FROM metadata WHERE key=?
      `).get(PRUNE_HEARTBEAT_KEY);
      if (ownerRow) {
        let existingOwner = null;
        let existingHeartbeat = null;
        try {
          existingOwner = parseObject(ownerRow.value, "Evidence prune operation lease");
          existingHeartbeat = heartbeatRow
            ? parseObject(heartbeatRow.value, "Evidence prune operation heartbeat")
            : null;
        } catch {}
        const heartbeatMs = Number(existingHeartbeat?.heartbeat_ms);
        const heartbeatFresh = Number.isSafeInteger(heartbeatMs)
          && heartbeatMs >= 0
          && acquiredAtMs - heartbeatMs <= PRUNE_HEARTBEAT_STALE_MS;
        const sameLease = existingHeartbeat?.nonce === existingOwner?.nonce;
        const alive = processAliveImpl(Number(existingOwner?.pid));
        if (alive && sameLease && heartbeatFresh) {
          throw new Error(
            `another Evidence prune operation is active under pid ${existingOwner.pid}`,
          );
        }
      }
      this.database.prepare(`
        INSERT INTO metadata(key,value) VALUES(?,?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value
      `).run(PRUNE_LOCK_KEY, ownerJson);
      this.database.prepare(`
        INSERT INTO metadata(key,value) VALUES(?,?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value
      `).run(PRUNE_HEARTBEAT_KEY, heartbeatJson);
      this.database.exec("COMMIT");
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {}
      throw error;
    }

    let released = false;
    return {
      owner: { ...owner },
      heartbeat: () => {
        this.assertOpen();
        if (released) throw new Error("Evidence prune operation lease is released");
        const heartbeatMs = nowMs();
        if (!Number.isSafeInteger(heartbeatMs) || heartbeatMs < 0) {
          throw new Error("Evidence prune lease clock is invalid");
        }
        const nextHeartbeat = JSON.stringify({
          schema: "uci_arena_evidence_prune_heartbeat_v1",
          nonce: owner.nonce,
          heartbeat_ms: heartbeatMs,
        });
        const changed = this.database.prepare(`
          UPDATE metadata SET value=?
          WHERE key=?
            AND EXISTS (
              SELECT 1 FROM metadata owner
              WHERE owner.key=? AND owner.value=?
            )
        `).run(
          nextHeartbeat,
          PRUNE_HEARTBEAT_KEY,
          PRUNE_LOCK_KEY,
          ownerJson,
        ).changes;
        if (changed !== 1) {
          throw new Error("Evidence prune operation lease ownership changed during heartbeat");
        }
      },
      release: () => {
        this.assertOpen();
        if (released) return;
        this.database.exec("BEGIN IMMEDIATE");
        try {
          const changed = this.database.prepare(`
            DELETE FROM metadata WHERE key=? AND value=?
          `).run(PRUNE_LOCK_KEY, ownerJson).changes;
          if (changed !== 1) {
            throw new Error("Evidence prune operation lease ownership changed before release");
          }
          this.database.prepare(`
            DELETE FROM metadata WHERE key=?
          `).run(PRUNE_HEARTBEAT_KEY);
          this.database.exec("COMMIT");
          released = true;
        } catch (error) {
          try {
            this.database.exec("ROLLBACK");
          } catch {}
          throw error;
        }
      },
    };
  }

  candidateStats(cutoff) {
    this.assertOpen();
    const row = this.database.prepare(`
      SELECT
        COUNT(*) AS artifact_count,
        COALESCE(SUM(a.size_bytes),0) AS bytes,
        MIN(a.size_bytes) AS minimum_size
      FROM artifacts a
      WHERE a.created_at < ?
        AND NOT EXISTS (
          SELECT 1 FROM observations o
          JOIN datasets d ON d.id=o.dataset_id
          WHERE o.raw_sha256=a.sha256 AND d.state='collecting'
        )
    `).get(cutoff);
    const artifactCount = safeCount(row.artifact_count, "candidate count");
    if (artifactCount > 0) safeCount(row.minimum_size, "minimum candidate size");
    return {
      artifactCount,
      bytes: safeCount(row.bytes, "candidate bytes"),
    };
  }

  audit(id) {
    this.assertOpen();
    const row = this.database.prepare(`
      SELECT id,requested_at,before_timestamp,confirmed,artifact_count,bytes,result_json
      FROM prune_audit WHERE id=?
    `).get(id);
    if (!row) return null;
    return {
      id: row.id,
      requestedAt: row.requested_at,
      before: row.before_timestamp,
      confirmed: Boolean(row.confirmed),
      artifactCount: safeCount(row.artifact_count, `audit ${row.id} artifact count`),
      bytes: safeCount(row.bytes, `audit ${row.id} bytes`),
      result: parseAuditResult(row.result_json, row.id),
    };
  }

  artifact(sha256) {
    this.assertOpen();
    if (!SHA256.test(String(sha256))) return null;
    const row = this.database.prepare(`
      SELECT sha256,path,size_bytes,created_at FROM artifacts WHERE sha256=?
    `).get(sha256);
    return row ? candidateRow(row) : null;
  }

  insertAudit({ id, requestedAt, before, confirmed, artifactCount, bytes, result }) {
    this.assertOpen();
    this.database.prepare(`
      INSERT INTO prune_audit(
        id,requested_at,before_timestamp,confirmed,artifact_count,bytes,result_json
      ) VALUES(?,?,?,?,?,?,?)
    `).run(
      id,
      requestedAt,
      before,
      confirmed ? 1 : 0,
      artifactCount,
      bytes,
      JSON.stringify(result),
    );
  }

  updateAuditResult(id, result) {
    this.assertOpen();
    const changed = this.database.prepare(`
      UPDATE prune_audit SET result_json=? WHERE id=?
    `).run(JSON.stringify(result), id).changes;
    if (changed !== 1) throw new Error(`unknown Evidence prune audit ${id}`);
  }

  async withConfirmedPrune(cutoff, callback) {
    this.assertOpen();
    if (typeof callback !== "function") throw new Error("confirmed prune callback is required");
    this.database.exec("BEGIN IMMEDIATE");
    let transactionOpen = true;
    let iterator = null;
    try {
      this.database.exec("DELETE FROM prune_candidates");
      this.database.prepare(`
        INSERT INTO prune_candidates(sha256,path,size_bytes,created_at)
        SELECT a.sha256,a.path,a.size_bytes,a.created_at
        FROM artifacts a
        WHERE a.created_at < ?
          AND NOT EXISTS (
            SELECT 1 FROM observations o
            JOIN datasets d ON d.id=o.dataset_id
            WHERE o.raw_sha256=a.sha256 AND d.state='collecting'
          )
      `).run(cutoff);
      const statsRow = this.database.prepare(`
        SELECT COUNT(*) AS artifact_count,COALESCE(SUM(size_bytes),0) AS bytes
        FROM prune_candidates
      `).get();
      const stats = {
        artifactCount: safeCount(statsRow.artifact_count, "transaction candidate count"),
        bytes: safeCount(statsRow.bytes, "transaction candidate bytes"),
      };
      const statement = this.database.prepare(`
        SELECT sha256,path,size_bytes,created_at
        FROM prune_candidates
        ORDER BY created_at,sha256
      `);
      const source = statement.iterate();
      iterator = (function* candidates() {
        try {
          for (const row of source) yield candidateRow(row);
        } finally {
          source.return?.();
        }
      }());
      const result = await callback({ stats, candidates: iterator });
      iterator.return?.();
      iterator = null;
      this.database.exec("COMMIT");
      transactionOpen = false;
      return result;
    } catch (error) {
      iterator?.return?.();
      if (transactionOpen) {
        try {
          this.database.exec("ROLLBACK");
        } catch {}
      }
      throw error;
    } finally {
      try {
        this.database.exec("DELETE FROM prune_candidates");
      } catch {}
    }
  }

  deleteCandidate(sha256) {
    this.assertOpen();
    if (!SHA256.test(String(sha256))) {
      throw new Error(`Evidence prune candidate identity is invalid: ${sha256}`);
    }
    const observations = this.database.prepare(`
      DELETE FROM observations WHERE raw_sha256=?
    `).run(sha256).changes;
    const artifacts = this.database.prepare(`
      DELETE FROM artifacts WHERE sha256=?
    `).run(sha256).changes;
    if (artifacts !== 1) {
      throw new Error(`Evidence prune candidate ${sha256} changed during the transaction`);
    }
    return {
      observations: safeCount(observations, `artifact ${sha256} deleted observations`),
      artifacts: safeCount(artifacts, `artifact ${sha256} deleted rows`),
    };
  }

  reconcileDatasetCounts() {
    this.assertOpen();
    this.database.exec(`
      UPDATE datasets
      SET observation_count=(
        SELECT COUNT(*) FROM observations WHERE observations.dataset_id=datasets.id
      )
    `);
  }
}
