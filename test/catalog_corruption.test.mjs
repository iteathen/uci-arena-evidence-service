import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Catalog, CatalogCorruptionError } from "../src/catalog.mjs";
import { jobFingerprint } from "../src/campaign.mjs";
import { loadConfig } from "../src/config.mjs";
import { sha256File } from "../src/identity.mjs";
import { apiError, listOutputsApi, statusApi } from "../src/manager_api.mjs";

const malformedMarker = "malformed-private-catalog-payload";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "evidence-catalog-corruption-"));
  const config = await loadConfig({ workspace: root });
  const catalog = new Catalog(config);
  t.after(() => catalog.close());
  t.after(() => rm(root, { recursive: true, force: true }));
  const modelRoot = path.join(root, "model");
  mkdirSync(modelRoot, { recursive: true });
  const target = catalog.addTarget({
    label: "fixture",
    modelId: "fixture_model",
    modelRoot,
    modelFingerprint: "123456789",
    enginePath: process.execPath,
    engineSha256: sha256File(process.execPath),
    provider: "cpu",
    hardwareDriverFingerprint: "",
    uciOptions: { Threads: 1 },
  });
  const datasetId = catalog.createDataset({
    campaign: "catalog-corruption",
    targetIdentity: { target_id: target.id },
  });
  const job = catalog.enqueueJob({
    adapter: "paired_sprt",
    targetId: target.id,
    shardId: "catalog-corruption",
    datasetId,
    fingerprint: jobFingerprint({ test: "catalog-corruption" }),
    config: { evidenceMode: "curve", control: "30+0" },
  });
  const artifactSha = "a".repeat(64);
  catalog.registerArtifact({
    sha256: artifactSha,
    schema: "fixture",
    filename: path.join(root, "fixture.raw"),
    sizeBytes: 1,
  });
  const observationId = randomUUID();
  catalog.addObservation({
    schema: "uci_arena_observation_envelope_v1",
    observation_id: observationId,
    dataset_id: datasetId,
    job_id: job.id,
    shard_id: job.shardId,
    recorded_at: new Date().toISOString(),
    adapter: job.adapter,
    source_schema: "fixture",
    raw_sha256: artifactSha,
    target_identity: { target_id: target.id },
    axes: { workload: "fixture" },
    metrics: { samples: [1] },
    outcome: { result: null },
    resource: { performance_authority: false },
    authority: { diagnostic: true, timing: false, strength: false },
  });
  catalog.updateDaemonState({ lastReport: { state: "idle" } });
  return { catalog, config, target, datasetId, job, observationId };
}

function requireCorruption(action, domain) {
  assert.throws(action, (error) => {
    assert.equal(error instanceof CatalogCorruptionError, true);
    assert.equal(error.code, "EVIDENCE_CATALOG_CORRUPT");
    assert.equal(error.domain, domain);
    assert.equal(error.message, "Evidence catalog contains incompatible persisted JSON");
    assert.equal(error.message.includes(malformedMarker), false);
    return true;
  });
}

test("every authoritative catalog JSON domain rejects syntax and wrong top-level shape", async (t) => {
  const context = await fixture(t);
  const domains = [
    {
      table: "jobs",
      column: "config_json",
      id: context.job.id,
      domain: "job_configuration",
      read: () => context.catalog.job(context.job.id),
    },
    {
      table: "targets",
      column: "uci_options_json",
      id: context.target.id,
      domain: "target_uci_options",
      read: () => context.catalog.target(context.target.id),
    },
    {
      table: "datasets",
      column: "target_identity_json",
      id: context.datasetId,
      domain: "dataset_target_identity",
      read: () => context.catalog.dataset(context.datasetId),
    },
    {
      table: "datasets",
      column: "authority_json",
      id: context.datasetId,
      domain: "dataset_authority",
      read: () => context.catalog.dataset(context.datasetId),
    },
    ...[
      ["target_identity_json", "observation_target_identity"],
      ["axes_json", "observation_axes"],
      ["metrics_json", "observation_metrics"],
      ["outcome_json", "observation_outcome"],
      ["resource_json", "observation_resource"],
      ["authority_json", "observation_authority"],
    ].map(([column, domain]) => ({
      table: "observations",
      column,
      id: context.observationId,
      domain,
      read: () => context.catalog.dataset(context.datasetId),
    })),
    {
      table: "daemon_state",
      column: "last_report_json",
      id: 1,
      domain: "daemon_report",
      read: () => context.catalog.daemonState(),
    },
  ];

  for (const entry of domains) {
    const identifier = entry.table === "daemon_state" ? "singleton" : "id";
    const statement = context.catalog.database.prepare(
      `UPDATE ${entry.table} SET ${entry.column}=? WHERE ${identifier}=?`,
    );
    const original = context.catalog.database.prepare(
      `SELECT ${entry.column} AS value FROM ${entry.table} WHERE ${identifier}=?`,
    ).get(entry.id).value;
    for (const invalid of [`{${malformedMarker}`, "[]"]) {
      statement.run(invalid, entry.id);
      requireCorruption(entry.read, entry.domain);
      statement.run(original, entry.id);
    }
  }
});

test("corrupt job configuration blocks scheduler admission before defaults", async (t) => {
  const { catalog, job } = await fixture(t);
  catalog.database.prepare("UPDATE jobs SET config_json=? WHERE id=?")
    .run(`{${malformedMarker}`, job.id);

  requireCorruption(() => catalog.runnableJobs(), "job_configuration");
  assert.equal(catalog.database.prepare("SELECT state FROM jobs WHERE id=?").get(job.id).state, "queued");
  assert.equal(catalog.database.prepare("SELECT COUNT(*) AS count FROM attempts").get().count, 0);
});

test("corrupt target and evidence JSON grant no public output authority", async (t) => {
  const { catalog, config, target, datasetId } = await fixture(t);
  catalog.completeDataset(datasetId, {
    diagnostic: true,
    timing: true,
    strength: true,
    profile_publication: true,
  });
  catalog.database.prepare("UPDATE targets SET uci_options_json='[]' WHERE id=?")
    .run(target.id);
  requireCorruption(() => catalog.target(target.id), "target_uci_options");

  catalog.database.prepare("UPDATE datasets SET authority_json='[]' WHERE id=?")
    .run(datasetId);
  requireCorruption(() => listOutputsApi(catalog, config), "dataset_authority");
});

test("daemon report corruption becomes one bounded API health diagnostic", async (t) => {
  const { catalog } = await fixture(t);
  catalog.database.prepare("UPDATE daemon_state SET last_report_json=? WHERE singleton=1")
    .run(`{${malformedMarker}`);
  let failure;
  try {
    statusApi(catalog);
  } catch (error) {
    failure = error;
  }
  assert.ok(failure);
  const projected = apiError("status", failure);
  assert.equal(projected.ok, false);
  assert.equal(projected.error.message, "Evidence catalog contains incompatible persisted JSON");
  assert.equal(JSON.stringify(projected).includes(malformedMarker), false);
});

test("catalog writers refuse wrong-shape JSON before it becomes durable", async (t) => {
  const { catalog, target, datasetId, job, observationId } = await fixture(t);
  assert.throws(() => catalog.enqueueJob({
    adapter: "paired_sprt",
    targetId: target.id,
    shardId: "invalid-json",
    datasetId,
    fingerprint: jobFingerprint({ test: "invalid-json" }),
    config: [],
  }), /refused incompatible JSON input/u);
  assert.throws(() => catalog.createDataset({
    campaign: "invalid-json",
    targetIdentity: [],
  }), /refused incompatible JSON input/u);
  assert.throws(
    () => catalog.completeDataset(datasetId, []),
    /refused incompatible JSON input/u,
  );
  assert.throws(
    () => catalog.updateDaemonState({ lastReport: [] }),
    /refused incompatible JSON input/u,
  );
  assert.throws(
    () => catalog.updateDaemonState({ lastReport: { load: Number.NaN } }),
    /refused incompatible JSON input/u,
  );
  assert.throws(() => catalog.addTarget({
    label: "invalid-json",
    modelId: "invalid_json",
    modelRoot: target.modelRoot,
    modelFingerprint: "123456789",
    enginePath: target.enginePath,
    engineSha256: target.engineSha256,
    provider: "cpu",
    uciOptions: { "invalid=option": true },
  }), /refused incompatible JSON input/u);
  assert.equal(catalog.job(job.id).state, "queued");
  assert.equal(catalog.dataset(datasetId).state, "collecting");
  assert.equal(catalog.database.prepare("SELECT COUNT(*) AS count FROM observations WHERE id=?")
    .get(observationId).count, 1);
});
