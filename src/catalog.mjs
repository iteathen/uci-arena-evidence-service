import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const CATALOG_SCHEMA_VERSION = 1;
const JOB_STATES = new Set([
  "queued",
  "waiting_for_target",
  "waiting_for_resources",
  "running",
  "completed",
  "failed",
  "cancelled",
]);

function nowIso() {
  return new Date().toISOString();
}

function parseJson(text, fallback = {}) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function boundedStatusValue(value, depth = 0) {
  if (depth > 8) return "[truncated]";
  if (typeof value === "string") return value.slice(0, 2_048);
  if (Array.isArray(value)) {
    return value.slice(0, 32).map((entry) => boundedStatusValue(entry, depth + 1));
  }
  if (value && typeof value === "object") {
    const result = {};
    for (const [key, entry] of Object.entries(value).slice(0, 64)) {
      result[key] = /token|secret|password|credential|authorization/i.test(key)
        ? "[redacted]"
        : boundedStatusValue(entry, depth + 1);
    }
    return result;
  }
  return value;
}

function jobRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    adapter: row.adapter,
    state: row.state,
    priority: Number(row.priority),
    targetId: row.target_id,
    shardId: row.shard_id,
    datasetId: row.dataset_id,
    fingerprint: row.fingerprint,
    config: parseJson(row.config_json),
    attempts: Number(row.attempts),
    waitReason: row.wait_reason,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function targetRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    label: row.label,
    modelId: row.model_id,
    modelRoot: row.model_root,
    modelFingerprint: row.model_fingerprint,
    enginePath: row.engine_path,
    engineSha256: row.engine_sha256,
    provider: row.provider,
    hardwareDriverFingerprint: row.hardware_driver_fingerprint,
    uciOptions: parseJson(row.uci_options_json),
    createdAt: row.created_at,
  };
}

export class Catalog {
  constructor(config) {
    this.config = config;
    for (const directory of Object.values(config.paths)) {
      if (path.extname(directory)) mkdirSync(path.dirname(directory), { recursive: true });
      else mkdirSync(directory, { recursive: true });
    }
    this.database = new DatabaseSync(config.paths.catalog);
    this.database.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=NORMAL;
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS control (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),
        paused INTEGER NOT NULL DEFAULT 0,
        reason TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS targets (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        model_id TEXT NOT NULL,
        model_root TEXT NOT NULL,
        model_fingerprint TEXT NOT NULL,
        engine_path TEXT NOT NULL,
        engine_sha256 TEXT NOT NULL,
        provider TEXT NOT NULL,
        hardware_driver_fingerprint TEXT NOT NULL,
        uci_options_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS datasets (
        id TEXT PRIMARY KEY,
        schema TEXT NOT NULL,
        campaign TEXT NOT NULL,
        state TEXT NOT NULL,
        target_identity_json TEXT NOT NULL,
        authority_json TEXT NOT NULL,
        observation_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        completed_at TEXT
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        adapter TEXT NOT NULL,
        state TEXT NOT NULL,
        priority INTEGER NOT NULL,
        target_id TEXT REFERENCES targets(id),
        shard_id TEXT NOT NULL,
        dataset_id TEXT NOT NULL REFERENCES datasets(id),
        fingerprint TEXT NOT NULL UNIQUE,
        config_json TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        wait_reason TEXT NOT NULL DEFAULT '',
        last_error TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS jobs_ready_idx
        ON jobs(state,priority DESC,created_at,id);
      CREATE TABLE IF NOT EXISTS attempts (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES jobs(id),
        state TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        exit_code INTEGER,
        reason TEXT NOT NULL DEFAULT '',
        resource_json TEXT NOT NULL DEFAULT '{}',
        stdout_path TEXT NOT NULL DEFAULT '',
        stderr_path TEXT NOT NULL DEFAULT ''
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS attempts_job_idx ON attempts(job_id,started_at);
      CREATE TABLE IF NOT EXISTS artifacts (
        sha256 TEXT PRIMARY KEY,
        schema TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        size_bytes INTEGER NOT NULL,
        created_at TEXT NOT NULL
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS observations (
        id TEXT PRIMARY KEY,
        dataset_id TEXT NOT NULL REFERENCES datasets(id),
        job_id TEXT NOT NULL REFERENCES jobs(id),
        shard_id TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        adapter TEXT NOT NULL,
        source_schema TEXT NOT NULL,
        raw_sha256 TEXT NOT NULL REFERENCES artifacts(sha256),
        target_identity_json TEXT NOT NULL,
        axes_json TEXT NOT NULL,
        metrics_json TEXT NOT NULL,
        outcome_json TEXT NOT NULL,
        resource_json TEXT NOT NULL,
        authority_json TEXT NOT NULL
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS observations_dataset_idx
        ON observations(dataset_id,recorded_at,id);
      CREATE UNIQUE INDEX IF NOT EXISTS observations_job_artifact_idx
        ON observations(job_id,raw_sha256,source_schema);
      CREATE TABLE IF NOT EXISTS daemon_state (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),
        pid INTEGER,
        phase TEXT NOT NULL DEFAULT 'stopped',
        current_job_id TEXT,
        resource_mode TEXT NOT NULL DEFAULT '',
        started_at TEXT,
        heartbeat_at TEXT,
        cycle_started_at TEXT,
        cycle_completed_at TEXT,
        last_error TEXT NOT NULL DEFAULT '',
        last_report_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS prune_audit (
        id TEXT PRIMARY KEY,
        requested_at TEXT NOT NULL,
        before_timestamp TEXT NOT NULL,
        confirmed INTEGER NOT NULL,
        artifact_count INTEGER NOT NULL,
        bytes INTEGER NOT NULL,
        result_json TEXT NOT NULL
      ) WITHOUT ROWID;
    `);
    const version = this.database.prepare("SELECT value FROM metadata WHERE key='schema_version'").get();
    if (!version) {
      this.database.prepare("INSERT INTO metadata(key,value) VALUES('schema_version',?)")
        .run(String(CATALOG_SCHEMA_VERSION));
    } else if (Number(version.value) !== CATALOG_SCHEMA_VERSION) {
      throw new Error(`unsupported evidence catalog schema ${version.value}`);
    }
    this.database.prepare(`
      INSERT OR IGNORE INTO control(singleton,paused,reason,updated_at) VALUES(1,0,'',?)
    `).run(nowIso());
    this.database.prepare(`
      INSERT OR IGNORE INTO daemon_state(singleton,phase,last_report_json) VALUES(1,'stopped','{}')
    `).run();
  }

  close() {
    this.database.close();
  }

  control() {
    const row = this.database.prepare("SELECT paused,reason,updated_at FROM control WHERE singleton=1").get();
    return { paused: Boolean(row.paused), reason: row.reason, updatedAt: row.updated_at };
  }

  setPaused(paused, reason = "") {
    this.database.prepare(`
      UPDATE control SET paused=?,reason=?,updated_at=? WHERE singleton=1
    `).run(paused ? 1 : 0, paused ? String(reason || "operator pause") : "", nowIso());
    return this.control();
  }

  addTarget(target) {
    const required = [
      "modelId",
      "modelRoot",
      "modelFingerprint",
      "enginePath",
      "engineSha256",
      "provider",
    ];
    for (const field of required) {
      if (!String(target[field] ?? "").trim()) throw new Error(`target ${field} is required`);
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(String(target.modelId))) {
      throw new Error("target modelId is unsafe");
    }
    if (!new Set(["auto", "cpu", "directml", "cuda"]).has(String(target.provider))) {
      throw new Error("target provider must be auto, cpu, directml, or cuda");
    }
    if (!/^[a-f0-9]{64}$/i.test(target.engineSha256)) throw new Error("target engineSha256 is invalid");
    if (!target.uciOptions || typeof target.uciOptions !== "object"
        || Array.isArray(target.uciOptions)) {
      throw new Error("target uciOptions must be an object");
    }
    const id = target.id || randomUUID();
    this.database.prepare(`
      INSERT INTO targets(
        id,label,model_id,model_root,model_fingerprint,engine_path,engine_sha256,
        provider,hardware_driver_fingerprint,uci_options_json,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      id,
      String(target.label || target.modelId),
      String(target.modelId),
      path.resolve(target.modelRoot),
      String(target.modelFingerprint),
      path.resolve(target.enginePath),
      target.engineSha256.toLowerCase(),
      String(target.provider),
      String(target.hardwareDriverFingerprint || ""),
      JSON.stringify(target.uciOptions ?? {}),
      nowIso(),
    );
    return this.target(id);
  }

  target(id) {
    return targetRow(this.database.prepare("SELECT * FROM targets WHERE id=?").get(id));
  }

  targets({ limit = null, newestFirst = false } = {}) {
    if (limit !== null && (!Number.isInteger(limit) || limit < 1 || limit > 10_000)) {
      throw new Error("target query limit is invalid");
    }
    const order = newestFirst ? "created_at DESC,id DESC" : "created_at,id";
    const statement = limit === null
      ? this.database.prepare(`SELECT * FROM targets ORDER BY ${order}`)
      : this.database.prepare(`SELECT * FROM targets ORDER BY ${order} LIMIT ?`);
    const rows = limit === null ? statement.all() : statement.all(limit);
    return rows.map(targetRow);
  }

  findExactTarget(target) {
    const expectedOptions = JSON.stringify(target.uciOptions ?? {});
    return this.targets().find((candidate) =>
      candidate.modelId === target.modelId
      && candidate.modelRoot === path.resolve(target.modelRoot)
      && candidate.modelFingerprint === target.modelFingerprint
      && candidate.enginePath === path.resolve(target.enginePath)
      && candidate.engineSha256 === target.engineSha256.toLowerCase()
      && candidate.provider === target.provider
      && candidate.hardwareDriverFingerprint === (target.hardwareDriverFingerprint || "")
      && JSON.stringify(candidate.uciOptions) === expectedOptions) ?? null;
  }

  removeTarget(id) {
    const references = this.database.prepare(`
      SELECT COUNT(*) AS count FROM jobs
      WHERE target_id=? AND state NOT IN ('completed','failed','cancelled')
    `).get(id);
    if (Number(references.count) > 0) throw new Error("target has unfinished jobs");
    return this.database.prepare("DELETE FROM targets WHERE id=?").run(id).changes > 0;
  }

  createDataset({ campaign, targetIdentity = {}, id = randomUUID() }) {
    this.database.prepare(`
      INSERT INTO datasets(
        id,schema,campaign,state,target_identity_json,authority_json,created_at
      ) VALUES(?,'uci_arena_evidence_dataset_v1',?,'collecting',?,'{}',?)
    `).run(id, campaign, JSON.stringify(targetIdentity), nowIso());
    return id;
  }

  enqueueJob({
    adapter,
    priority = 0,
    targetId = null,
    shardId,
    datasetId,
    fingerprint,
    config = {},
  }) {
    if (!String(adapter ?? "").trim()) throw new Error("job adapter is required");
    if (!String(shardId ?? "").trim()) throw new Error("job shardId is required");
    if (!String(datasetId ?? "").trim()) throw new Error("job datasetId is required");
    if (!/^[a-f0-9]{64}$/i.test(String(fingerprint ?? ""))) {
      throw new Error("job fingerprint must be SHA-256");
    }
    const id = randomUUID();
    const at = nowIso();
    this.database.prepare(`
      INSERT OR IGNORE INTO jobs(
        id,adapter,state,priority,target_id,shard_id,dataset_id,fingerprint,
        config_json,created_at,updated_at
      ) VALUES(?,?,'queued',?,?,?,?,?,?,?,?)
    `).run(
      id,
      adapter,
      priority,
      targetId,
      shardId,
      datasetId,
      fingerprint.toLowerCase(),
      JSON.stringify(config),
      at,
      at,
    );
    return jobRow(this.database.prepare("SELECT * FROM jobs WHERE fingerprint=?").get(
      fingerprint.toLowerCase(),
    ));
  }

  jobByFingerprint(fingerprint) {
    return jobRow(this.database.prepare("SELECT * FROM jobs WHERE fingerprint=?").get(
      String(fingerprint).toLowerCase(),
    ));
  }

  job(id) {
    return jobRow(this.database.prepare("SELECT * FROM jobs WHERE id=?").get(id));
  }

  jobs({ state, limit = null, activeFirst = false } = {}) {
    if (limit !== null && (!Number.isInteger(limit) || limit < 1 || limit > 10_000)) {
      throw new Error("job query limit is invalid");
    }
    const order = activeFirst
      ? "CASE WHEN state IN ('completed','failed','cancelled') THEN 1 ELSE 0 END,updated_at DESC,id DESC"
      : state
        ? "priority DESC,created_at,id"
        : "created_at,id";
    let query = "SELECT * FROM jobs";
    const parameters = [];
    if (state) {
      query += " WHERE state=?";
      parameters.push(state);
    }
    query += ` ORDER BY ${order}`;
    if (limit !== null) {
      query += " LIMIT ?";
      parameters.push(limit);
    }
    const rows = this.database.prepare(query).all(...parameters);
    return rows.map(jobRow);
  }

  nextJob() {
    return jobRow(this.database.prepare(`
      SELECT * FROM jobs
      WHERE state IN ('queued','waiting_for_target','waiting_for_resources')
      ORDER BY priority DESC,created_at,id LIMIT 1
    `).get());
  }

  runnableJobs() {
    return this.database.prepare(`
      SELECT * FROM jobs
      WHERE state IN ('queued','waiting_for_target','waiting_for_resources')
      ORDER BY priority DESC,created_at,id
    `).all().map(jobRow);
  }

  transitionJob(id, state, { waitReason = "", error = "" } = {}) {
    if (!JOB_STATES.has(state)) throw new Error(`invalid job state ${state}`);
    const existing = this.job(id);
    if (!existing) throw new Error(`unknown job ${id}`);
    this.database.prepare(`
      UPDATE jobs SET state=?,wait_reason=?,last_error=?,updated_at=? WHERE id=?
    `).run(state, String(waitReason), String(error), nowIso(), id);
    return this.job(id);
  }

  cancelJob(id) {
    const job = this.job(id);
    if (!job) throw new Error(`unknown job ${id}`);
    if (job.state === "running") throw new Error("running jobs must be preempted before cancellation");
    if (job.state === "completed") throw new Error("completed jobs cannot be cancelled");
    return this.transitionJob(id, "cancelled");
  }

  retryJob(id) {
    const job = this.job(id);
    if (!job) throw new Error(`unknown job ${id}`);
    if (!new Set(["failed", "cancelled"]).has(job.state)) {
      throw new Error("only failed or cancelled jobs can be retried");
    }
    return this.transitionJob(id, "queued");
  }

  startAttempt(jobId, paths = {}) {
    const attemptId = randomUUID();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        UPDATE jobs
        SET state='running',attempts=attempts+1,wait_reason='',last_error='',updated_at=?
        WHERE id=?
      `).run(nowIso(), jobId);
      this.database.prepare(`
        INSERT INTO attempts(
          id,job_id,state,started_at,stdout_path,stderr_path
        ) VALUES(?,?,'running',?,?,?)
      `).run(attemptId, jobId, nowIso(), paths.stdout || "", paths.stderr || "");
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return attemptId;
  }

  finishAttempt(attemptId, { state, exitCode = null, reason = "", resource = {} }) {
    this.database.prepare(`
      UPDATE attempts SET state=?,completed_at=?,exit_code=?,reason=?,resource_json=? WHERE id=?
    `).run(state, nowIso(), exitCode, String(reason), JSON.stringify(resource), attemptId);
  }

  recoverInterruptedJobs() {
    const running = this.database.prepare("SELECT id FROM jobs WHERE state='running'").all();
    if (running.length === 0) return 0;
    const at = nowIso();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        UPDATE attempts SET state='interrupted',completed_at=?,reason='daemon_restart'
        WHERE state='running'
      `).run(at);
      this.database.prepare(`
        UPDATE jobs SET state='queued',wait_reason='recovered_after_daemon_restart',
          updated_at=? WHERE state='running'
      `).run(at);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return running.length;
  }

  registerArtifact({ sha256, schema, filename, sizeBytes }) {
    this.database.prepare(`
      INSERT OR IGNORE INTO artifacts(sha256,schema,path,size_bytes,created_at)
      VALUES(?,?,?,?,?)
    `).run(sha256, schema, path.resolve(filename), sizeBytes, nowIso());
    return this.database.prepare("SELECT * FROM artifacts WHERE sha256=?").get(sha256);
  }

  addObservation(envelope) {
    if (envelope.schema !== "uci_arena_observation_envelope_v1") {
      throw new Error(`unsupported observation schema ${envelope.schema}`);
    }
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const inserted = this.database.prepare(`
        INSERT OR IGNORE INTO observations(
          id,dataset_id,job_id,shard_id,recorded_at,adapter,source_schema,raw_sha256,
          target_identity_json,axes_json,metrics_json,outcome_json,resource_json,authority_json
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        envelope.observation_id,
        envelope.dataset_id,
        envelope.job_id,
        envelope.shard_id,
        envelope.recorded_at,
        envelope.adapter,
        envelope.source_schema,
        envelope.raw_sha256,
        JSON.stringify(envelope.target_identity),
        JSON.stringify(envelope.axes),
        JSON.stringify(envelope.metrics),
        JSON.stringify(envelope.outcome),
        JSON.stringify(envelope.resource),
        JSON.stringify(envelope.authority),
      );
      if (inserted.changes > 0) {
        this.database.prepare(`
          UPDATE datasets SET observation_count=observation_count+1 WHERE id=?
        `).run(envelope.dataset_id);
      }
      this.database.exec("COMMIT");
      return inserted.changes > 0;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  completeDataset(id, authority) {
    this.database.prepare(`
      UPDATE datasets SET state='completed',authority_json=?,completed_at=? WHERE id=?
    `).run(JSON.stringify(authority), nowIso(), id);
  }

  datasets() {
    return this.database.prepare("SELECT * FROM datasets ORDER BY created_at,id").all().map((row) => ({
      id: row.id,
      schema: row.schema,
      campaign: row.campaign,
      state: row.state,
      targetIdentity: parseJson(row.target_identity_json),
      authority: parseJson(row.authority_json),
      observationCount: Number(row.observation_count),
      createdAt: row.created_at,
      completedAt: row.completed_at,
    }));
  }

  dataset(id) {
    const dataset = this.datasets().find((entry) => entry.id === id);
    if (!dataset) return null;
    const observations = this.database.prepare(`
      SELECT * FROM observations WHERE dataset_id=? ORDER BY recorded_at,id
    `).all(id).map((row) => ({
      schema: "uci_arena_observation_envelope_v1",
      observation_id: row.id,
      dataset_id: row.dataset_id,
      job_id: row.job_id,
      shard_id: row.shard_id,
      recorded_at: row.recorded_at,
      adapter: row.adapter,
      source_schema: row.source_schema,
      raw_sha256: row.raw_sha256,
      target_identity: parseJson(row.target_identity_json),
      axes: parseJson(row.axes_json),
      metrics: parseJson(row.metrics_json),
      outcome: parseJson(row.outcome_json),
      resource: parseJson(row.resource_json),
      authority: parseJson(row.authority_json),
    }));
    return { ...dataset, observations };
  }

  daemonState() {
    const row = this.database.prepare("SELECT * FROM daemon_state WHERE singleton=1").get();
    return {
      pid: row.pid,
      phase: row.phase,
      currentJobId: row.current_job_id,
      resourceMode: row.resource_mode,
      startedAt: row.started_at,
      heartbeatAt: row.heartbeat_at,
      cycleStartedAt: row.cycle_started_at,
      cycleCompletedAt: row.cycle_completed_at,
      lastError: row.last_error,
      lastReport: parseJson(row.last_report_json),
    };
  }

  updateDaemonState(values) {
    const mapping = {
      pid: "pid",
      phase: "phase",
      currentJobId: "current_job_id",
      resourceMode: "resource_mode",
      startedAt: "started_at",
      heartbeatAt: "heartbeat_at",
      cycleStartedAt: "cycle_started_at",
      cycleCompletedAt: "cycle_completed_at",
      lastError: "last_error",
      lastReport: "last_report_json",
    };
    const entries = Object.entries(values).filter(([key]) => Object.hasOwn(mapping, key));
    if (entries.length === 0) return this.daemonState();
    const fields = entries.map(([key]) => `${mapping[key]}=?`);
    const parameters = entries.map(([key, value]) => (
      key === "lastReport" ? JSON.stringify(value) : value
    ));
    this.database.prepare(`UPDATE daemon_state SET ${fields.join(",")} WHERE singleton=1`)
      .run(...parameters);
    return this.daemonState();
  }

  status() {
    const counts = Object.fromEntries(this.database.prepare(`
      SELECT state,COUNT(*) AS count FROM jobs GROUP BY state
    `).all().map((row) => [row.state, Number(row.count)]));
    const daemon = this.daemonState();
    const control = this.control();
    const targetCount = this.targets().length;
    const noTarget = targetCount === 0 && !existsSync(this.config.activeModelPointer);
    return {
      schema: "uci_arena_evidence_status_v1",
      workspace: this.config.workspace,
      control,
      collection: {
        state: control.paused ? "paused" : noTarget ? "waiting_for_target" : "available",
        reason: control.paused
          ? control.reason
          : noTarget ? "no active deployment or explicit target" : "",
      },
      daemon: {
        ...daemon,
        lastError: String(daemon.lastError ?? "").slice(0, 2_048),
        lastReport: boundedStatusValue(daemon.lastReport),
      },
      jobs: counts,
      targets: targetCount,
      datasets: this.datasets().length,
      sampledAt: nowIso(),
    };
  }

  prune({ before, confirm = "" }) {
    const cutoff = Date.parse(before);
    if (!Number.isFinite(cutoff)) throw new Error("prune --before must be an ISO timestamp");
    const rows = this.database.prepare(`
      SELECT a.sha256,a.path,a.size_bytes,a.created_at
      FROM artifacts a
      WHERE a.created_at < ?
        AND NOT EXISTS (
          SELECT 1 FROM observations o
          JOIN datasets d ON d.id=o.dataset_id
          WHERE o.raw_sha256=a.sha256 AND d.state='collecting'
        )
      ORDER BY a.created_at,a.sha256
    `).all(new Date(cutoff).toISOString());
    const bytes = rows.reduce((sum, row) => sum + Number(row.size_bytes), 0);
    const confirmed = confirm === "PRUNE";
    const result = {
      schema: "uci_arena_evidence_prune_result_v1",
      before: new Date(cutoff).toISOString(),
      confirmed,
      artifactCount: rows.length,
      bytes,
      deleted: 0,
    };
    if (confirmed) {
      this.database.exec("BEGIN IMMEDIATE");
      try {
        for (const row of rows) {
          rmSync(row.path, { force: true });
          this.database.prepare("DELETE FROM observations WHERE raw_sha256=?").run(row.sha256);
          this.database.prepare("DELETE FROM artifacts WHERE sha256=?").run(row.sha256);
          result.deleted += 1;
        }
        this.database.exec(`
          UPDATE datasets
          SET observation_count=(
            SELECT COUNT(*) FROM observations WHERE observations.dataset_id=datasets.id
          )
        `);
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }
    this.database.prepare(`
      INSERT INTO prune_audit(
        id,requested_at,before_timestamp,confirmed,artifact_count,bytes,result_json
      ) VALUES(?,?,?,?,?,?,?)
    `).run(
      randomUUID(),
      nowIso(),
      result.before,
      confirmed ? 1 : 0,
      rows.length,
      bytes,
      JSON.stringify(result),
    );
    return result;
  }

  readArtifact(sha256) {
    const row = this.database.prepare("SELECT * FROM artifacts WHERE sha256=?").get(sha256);
    return row ? JSON.parse(readFileSync(row.path, "utf8")) : null;
  }
}
