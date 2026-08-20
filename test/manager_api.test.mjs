import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { Catalog } from "../src/catalog.mjs";
import { loadConfig } from "../src/config.mjs";
import {
  controlJobApi,
  describeApi,
  enqueueCampaignApi,
  inspectOutputApi,
  listOutputsApi,
  orchestrationStatusApi,
  registerTargetApi,
  startupRecoverApi,
  statusApi,
  validateConfigApi,
} from "../src/manager_api.mjs";
import { validatedManagerIntegrationApi } from "../tools/release/component_release.mjs";

const execFileAsync = promisify(execFile);

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "evidence-manager-api-"));
  const config = await loadConfig({ workspace: root });
  const catalog = new Catalog(config);
  t.after(async () => {
    catalog.close();
    await rm(root, { recursive: true, force: true });
  });
  return { catalog, config };
}

test("Manager API describes a stable one-way JSON contract", async (t) => {
  const { catalog, config } = await fixture(t);
  const description = describeApi();
  assert.equal(description.schema, "uci_arena_manager_service_api_v1");
  assert.equal(description.api_version, "1.0");
  assert.equal(description.component_id, "uci_arena_evidence.service");
  assert.deepEqual(description.payload.output_kinds, [
    "evidence.dataset",
    "timing_profile.qualified",
  ]);
  const status = statusApi(catalog).payload.status;
  assert.equal(status.schema, "uci_arena_evidence_status_v1");
  assert.equal(status.daemon.active, false);
  assert.equal(status.daemon.processAlive, false);
  assert.equal(status.daemon.stale, true);
  assert.equal(validateConfigApi(config).payload.runtime_component_id, "uci_arena_evidence.runtime");
});

test("Manager API startup recovery preserves the provider-owned operation contract", async (t) => {
  const { config } = await fixture(t);
  const response = await startupRecoverApi(config, async (candidate) => {
    assert.equal(candidate, config);
    return {
      platform: "windows",
      installed: true,
      recoveryRequested: true,
      registrationMutated: false,
    };
  });
  assert.equal(response.operation, "startup_recover");
  assert.equal(response.payload.recovery_requested, true);
  assert.equal(response.payload.registration_mutated, false);
});

test("Manager API projects dataset authority without exposing observations", async (t) => {
  const { catalog, config } = await fixture(t);
  const datasetId = catalog.createDataset({
    campaign: "manager-api",
    targetIdentity: { model_id: "fixture-model" },
  });
  catalog.completeDataset(datasetId, {
    diagnostic: true,
    timing: false,
    strength: false,
    profile_publication: false,
    reasons: ["fixture"],
  });
  const listed = listOutputsApi(catalog, config);
  assert.match(listed.payload.cursor, /^[0-9a-f]{64}$/u);
  assert.equal(listed.payload.outputs.length, 1);
  const output = listed.payload.outputs[0];
  assert.equal(output.output_id, `dataset:${datasetId}`);
  assert.equal(output.authority.diagnostic, true);
  assert.equal(Object.hasOwn(output, "observations"), false);
  assert.deepEqual(
    output.materialization.arguments.slice(0, 4),
    ["dataset", "export", "--id", datasetId],
  );
  const inspected = inspectOutputApi(catalog, config, output.output_id);
  assert.deepEqual(inspected.payload.output, output);
  const unchanged = listOutputsApi(catalog, config, listed.payload.cursor);
  assert.equal(unchanged.payload.unchanged, true);
  assert.deepEqual(unchanged.payload.outputs, []);
});

test("catalog open repairs only unambiguous legacy cancelled dataset state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "evidence-catalog-repair-"));
  const config = await loadConfig({ workspace: root });
  let catalog = new Catalog(config);
  try {
    const datasetId = catalog.createDataset({
      campaign: "legacy-cancelled",
      targetIdentity: { source: "active_model_pointer" },
    });
    const job = catalog.enqueueJob({
      adapter: "timing_profile",
      shardId: "legacy",
      datasetId,
      fingerprint: "a".repeat(64),
    });
    catalog.transitionJob(job.id, "cancelled");
    assert.equal(catalog.dataset(datasetId).state, "collecting");

    catalog.close();
    catalog = null;
    catalog = new Catalog(config);
    const repaired = catalog.dataset(datasetId);
    assert.equal(repaired.state, "cancelled");
    assert.deepEqual(repaired.authority, {});
    assert.match(repaired.completedAt, /^\d{4}-\d{2}-\d{2}T/u);
    assert.equal(repaired.observationCount, 0);
  } finally {
    catalog?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Manager API rejects malformed cursors and output identities", async (t) => {
  const { catalog, config } = await fixture(t);
  assert.throws(
    () => listOutputsApi(catalog, config, "../catalog.sqlite"),
    /cursor is malformed/,
  );
  assert.throws(
    () => inspectOutputApi(catalog, config, "dataset:../catalog.sqlite"),
    /output id is malformed/,
  );
});

test("Manager API exposes bounded orchestration and only built-in campaign controls", async (t) => {
  const { catalog } = await fixture(t);
  const target = catalog.addTarget({
    label: "LatticeKnight",
    modelId: "latticeknight",
    modelRoot: "C:/private/model/root",
    modelFingerprint: "model-fingerprint",
    enginePath: "C:/private/engine.exe",
    engineSha256: "a".repeat(64),
    provider: "directml",
    hardwareDriverFingerprint: "private-driver",
    uciOptions: { SecretLookingInternalOption: "not projected" },
  });
  const enqueued = enqueueCampaignApi(catalog, target.id);
  assert.equal(enqueued.operation, "campaign_enqueue");
  assert.ok(enqueued.payload.jobs.length > 1);

  const projected = orchestrationStatusApi(catalog);
  assert.equal(projected.payload.schema, "uci_arena_evidence_orchestration_v1");
  assert.deepEqual(projected.payload.limits, { targets: 64, jobs: 512 });
  assert.equal(projected.payload.targets_truncated, false);
  assert.equal(projected.payload.jobs_truncated, false);
  assert.equal(projected.payload.targets.length, 1);
  assert.equal(Object.hasOwn(projected.payload.targets[0], "modelRoot"), false);
  assert.equal(Object.hasOwn(projected.payload.targets[0], "enginePath"), false);
  assert.equal(Object.hasOwn(projected.payload.targets[0], "uciOptions"), false);
  assert.equal(Object.hasOwn(projected.payload.jobs[0], "config"), false);
  assert.equal(Object.hasOwn(projected.payload.jobs[0], "fingerprint"), false);

  const jobId = projected.payload.jobs[0].id;
  catalog.transitionJob(jobId, "waiting_for_resources", {
    waitReason: "blocked by C:\\private\\engine.exe and /private/model/root",
    error: "failed at \\\\server\\private\\artifact.bin",
  });
  const redacted = orchestrationStatusApi(catalog).payload.jobs[0];
  assert.equal(redacted.wait_reason.includes("C:\\private"), false);
  assert.equal(redacted.wait_reason.includes("/private/model"), false);
  assert.equal(redacted.last_error.includes("\\\\server\\private"), false);
  assert.match(redacted.wait_reason, /\[path\]/u);
  assert.match(redacted.last_error, /\[path\]/u);
  assert.equal(controlJobApi(catalog, jobId, "cancel").payload.job.state, "cancelled");
  const cancelledDataset = catalog.dataset(projected.payload.jobs[0].dataset_id);
  assert.equal(cancelledDataset.state, "cancelled");
  assert.match(cancelledDataset.completedAt, /^\d{4}-\d{2}-\d{2}T/u);
  assert.equal(controlJobApi(catalog, jobId, "retry").payload.job.state, "queued");
  const retriedDataset = catalog.dataset(projected.payload.jobs[0].dataset_id);
  assert.equal(retriedDataset.state, "collecting");
  assert.equal(retriedDataset.completedAt, null);
  assert.throws(
    () => controlJobApi(catalog, jobId, "delete"),
    /must be cancel or retry/,
  );
  assert.throws(
    () => enqueueCampaignApi(catalog, "not-a-target"),
    /target id is malformed/,
  );
});

test("Manager API registers exact targets idempotently and hashes the engine itself", async (t) => {
  const { catalog, config } = await fixture(t);
  const modelRoot = path.join(config.workspace, "model");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(modelRoot));
  const input = {
    label: "LatticeKnight-4M deployment",
    modelId: "compact_chessformer_gab_v1",
    modelRoot,
    modelFingerprint: "8104116015256418347",
    enginePath: process.execPath,
    provider: "cpu",
    hardwareDriverFingerprint: "5805769137532863231",
    uciOptions: { Threads: 1, Ponder: false },
  };
  const created = registerTargetApi(catalog, input);
  assert.equal(created.operation, "target_register");
  assert.equal(created.payload.created, true);
  assert.match(created.payload.target.id, /^[0-9a-f-]{36}$/u);
  assert.match(created.payload.target.engine_sha256, /^[0-9a-f]{64}$/u);
  assert.equal(catalog.targets().length, 1);

  const reused = registerTargetApi(catalog, {
    ...input,
    uciOptions: { Ponder: false, Threads: 1 },
  });
  assert.equal(reused.payload.created, false);
  assert.equal(reused.payload.target.id, created.payload.target.id);
  assert.equal(catalog.targets().length, 1);

  assert.throws(
    () => registerTargetApi(catalog, { ...input, modelRoot: "relative/model" }),
    /model root path must be absolute/,
  );
  assert.throws(
    () => registerTargetApi(catalog, { ...input, uciOptions: { Bad: { nested: true } } }),
    /invalid value/,
  );
});

test("Manager orchestration status applies exact collection caps", () => {
  const uuid = (index) => `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
  const targets = Array.from({ length: 65 }, (_, index) => ({
    id: uuid(index),
    modelId: `model-${index}`,
  }));
  const jobs = Array.from({ length: 513 }, (_, index) => ({
    id: uuid(index + 1_000),
    state: "queued",
    priority: index,
  }));
  const catalog = {
    targets(options) {
      assert.deepEqual(options, { limit: 65, newestFirst: true });
      return targets;
    },
    jobs(options) {
      assert.deepEqual(options, { limit: 513, activeFirst: true });
      return jobs;
    },
  };

  const projected = orchestrationStatusApi(catalog).payload;

  assert.equal(projected.targets_truncated, true);
  assert.equal(projected.jobs_truncated, true);
  assert.equal(projected.targets.length, 64);
  assert.equal(projected.jobs.length, 512);
});

test("provider definition advertises the same Manager API contract", async () => {
  const packageManifest = JSON.parse(await readFile(
    new URL("../package.json", import.meta.url),
    "utf8",
  ));
  const definition = JSON.parse(await readFile(
    new URL("../release/components/evidence-service.json", import.meta.url),
    "utf8",
  ));
  const serviceContract = JSON.parse(await readFile(
    new URL("../contracts/service-contract.json", import.meta.url),
    "utf8",
  ));
  assert.deepEqual(
    definition.manager_integration_api,
    serviceContract.manager_integration_api,
  );
  assert.equal(
    serviceContract.component_version,
    packageManifest.version,
    "the installed contract must carry the immutable package version",
  );
  assert.equal(definition.manager_integration_api.entrypoint, "cli");
  assert.deepEqual(
    validatedManagerIntegrationApi(
      definition.manager_integration_api,
      definition.entrypoints,
    ),
    serviceContract.manager_integration_api,
  );
});

test("installed CLI API works from an unrelated working directory", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "evidence-manager-cli-"));
  const cwd = await mkdtemp(path.join(os.tmpdir(), "evidence-manager-cwd-"));
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(cwd, { recursive: true, force: true }),
  ]));
  const { stdout } = await execFileAsync(process.execPath, [
    path.resolve("src/cli.mjs"),
    "api",
    "describe",
    "--workspace",
    root,
  ], { cwd });
  const response = JSON.parse(stdout);
  assert.equal(response.schema, "uci_arena_manager_service_api_v1");
  assert.equal(response.operation, "describe");
  assert.equal(response.ok, true);
});
