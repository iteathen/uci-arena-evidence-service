import path from "node:path";
import { DatabaseSync } from "node:sqlite";

function parseStoredJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Evidence catalog ${label} contains invalid JSON: ${error.message}`);
  }
}

function datasetSummary(row) {
  if (!row) return null;
  const observationCount = Number(row.observation_count);
  if (!Number.isSafeInteger(observationCount) || observationCount < 0) {
    throw new Error(`Evidence catalog dataset ${row.id} has an invalid observation count`);
  }
  return {
    id: row.id,
    schema: row.schema,
    campaign: row.campaign,
    state: row.state,
    targetIdentity: parseStoredJson(
      row.target_identity_json,
      `dataset ${row.id} target identity`,
    ),
    authority: parseStoredJson(row.authority_json, `dataset ${row.id} authority`),
    observationCount,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

function observationEnvelope(row) {
  return {
    schema: "uci_arena_observation_envelope_v1",
    observation_id: row.id,
    dataset_id: row.dataset_id,
    job_id: row.job_id,
    shard_id: row.shard_id,
    recorded_at: row.recorded_at,
    adapter: row.adapter,
    source_schema: row.source_schema,
    raw_sha256: row.raw_sha256,
    target_identity: parseStoredJson(
      row.target_identity_json,
      `observation ${row.id} target identity`,
    ),
    axes: parseStoredJson(row.axes_json, `observation ${row.id} axes`),
    metrics: parseStoredJson(row.metrics_json, `observation ${row.id} metrics`),
    outcome: parseStoredJson(row.outcome_json, `observation ${row.id} outcome`),
    resource: parseStoredJson(row.resource_json, `observation ${row.id} resource`),
    authority: parseStoredJson(row.authority_json, `observation ${row.id} authority`),
  };
}

function mappedObservationIterator(statement, datasetId) {
  const source = statement.iterate(datasetId);
  return (function* iterateObservations() {
    try {
      for (const row of source) yield observationEnvelope(row);
    } finally {
      source.return?.();
    }
  }());
}

export class DatasetReadStore {
  constructor(filename, { Database = DatabaseSync } = {}) {
    if (typeof filename !== "string" || !filename.trim()) {
      throw new Error("DatasetReadStore requires a catalog filename");
    }
    this.filename = path.resolve(filename);
    this.database = new Database(this.filename, {
      readOnly: true,
      timeout: 5_000,
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
    });
    this.database.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=5000;");
    this.closed = false;
  }

  close() {
    if (this.closed) return;
    this.database.close();
    this.closed = true;
  }

  async withDatasetSnapshot(datasetId, reader) {
    if (this.closed) throw new Error("DatasetReadStore is closed");
    if (typeof datasetId !== "string" || !datasetId.trim()) {
      throw new Error("dataset id is required");
    }
    if (typeof reader !== "function") throw new Error("dataset snapshot reader is required");

    this.database.exec("BEGIN");
    let transactionOpen = true;
    let observations = null;
    try {
      const row = this.database.prepare(`
        SELECT
          id,schema,campaign,state,target_identity_json,authority_json,
          observation_count,created_at,completed_at
        FROM datasets
        WHERE id=?
      `).get(datasetId);
      if (!row) {
        this.database.exec("COMMIT");
        transactionOpen = false;
        return null;
      }
      const summary = datasetSummary(row);
      const statement = this.database.prepare(`
        SELECT
          id,dataset_id,job_id,shard_id,recorded_at,adapter,source_schema,
          raw_sha256,target_identity_json,axes_json,metrics_json,outcome_json,
          resource_json,authority_json
        FROM observations
        WHERE dataset_id=?
        ORDER BY recorded_at,id
      `);
      observations = mappedObservationIterator(statement, datasetId);
      const result = await reader(summary, observations);
      observations.return?.();
      observations = null;
      this.database.exec("COMMIT");
      transactionOpen = false;
      return result;
    } catch (error) {
      observations?.return?.();
      if (transactionOpen) {
        try {
          this.database.exec("ROLLBACK");
        } catch {}
      }
      throw error;
    }
  }
}
