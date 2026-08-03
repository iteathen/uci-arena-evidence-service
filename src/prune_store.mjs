import path from "node:path";
import { DatabaseSync } from "node:sqlite";

function safeCount(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`Evidence prune ${label} is not a non-negative safe integer`);
  }
  return number;
}

function parseAuditResult(text, auditId) {
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("result is not an object");
    }
    return value;
  } catch (error) {
    throw new Error(`Evidence prune audit ${auditId} contains invalid JSON: ${error.message}`);
  }
}

function candidateRow(row) {
  return {
    sha256: String(row.sha256).toLowerCase(),
    path: String(row.path),
    sizeBytes: safeCount(row.size_bytes, `artifact ${row.sha256} size`),
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

  candidateStats(cutoff) {
    this.assertOpen();
    const row = this.database.prepare(`
      SELECT COUNT(*) AS artifact_count,COALESCE(SUM(a.size_bytes),0) AS bytes
      FROM artifacts a
      WHERE a.created_at < ?
        AND NOT EXISTS (
          SELECT 1 FROM observations o
          JOIN datasets d ON d.id=o.dataset_id
          WHERE o.raw_sha256=a.sha256 AND d.state='collecting'
        )
    `).get(cutoff);
    return {
      artifactCount: safeCount(row.artifact_count, "candidate count"),
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
