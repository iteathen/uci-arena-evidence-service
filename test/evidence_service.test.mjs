import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  acquireResourceLease,
  validateInheritedResourceLease,
} from "@uci-arena/background-service-runtime/lease";
import { shutdownChildProcessTree } from "@uci-arena/background-service-runtime/resource-isolation";
import { canonicalJson } from "@uci-arena/time-profile-contract";
import { adapterCommand, harvestAdapter } from "../src/adapters.mjs";
import { Catalog } from "../src/catalog.mjs";
import { enqueueFirstCampaign, jobFingerprint } from "../src/campaign.mjs";
import { loadConfig, packageRoot, repositoryRoot } from "../src/config.mjs";
import {
  resolveActiveTarget,
  resolveJobTarget,
  sha256File,
} from "../src/identity.mjs";
import { acquireDaemonLock, publishQualifiedProfile, runDaemon } from "../src/daemon.mjs";
import { currentProcessIdentity, probeProcessInstance } from "../src/process_identity.mjs";
import {
  buildLinuxUserUnit,
  buildWindowsTaskXml,
  linuxUnitName,
  recoverStartup,
  waitForProcessExit,
  windowsStartupAction,
  windowsTaskActionFromXml,
  windowsTaskMatchesConfiguration,
} from "../src/platform_startup.mjs";
import { listQualifiedProfiles } from "../src/profiles.mjs";
import { ResourceGovernor } from "../src/resource_governor.mjs";

const runtimeIntegrationRoot = process.env.UCI_ARENA_EVIDENCE_RUNTIME_TEST_ROOT?.trim()
  ? path.resolve(process.env.UCI_ARENA_EVIDENCE_RUNTIME_TEST_ROOT)
  : repositoryRoot;

async function workspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), "arena-evidence-test-"));
  const config = await loadConfig({ workspace: root });
  config.runtimeRoot = path.join(root, "runtime-component");
  for (const relative of [
    "engine/tools/qualify_uci_time_profile.mjs",
    "arena/run_sprt_match.mjs",
    "arena/run_complete_game_matrix.mjs",
    process.platform === "win32"
      ? "bin/uci_arena_complete_game_referee.exe"
      : "bin/uci_arena_complete_game_referee",
  ]) {
    const filename = path.join(config.runtimeRoot, ...relative.split("/"));
    mkdirSync(path.dirname(filename), { recursive: true });
    writeFileSync(filename, "", "utf8");
  }
  const runtimeContract = path.join(
    config.runtimeRoot,
    "contracts",
    "evidence-runtime-contract.json",
  );
  mkdirSync(path.dirname(runtimeContract), { recursive: true });
  writeFileSync(runtimeContract, `${JSON.stringify({
    schema: "uci_arena_evidence_runtime_v1",
    component_id: "uci_arena_evidence.runtime",
    component_version: "0.3.0",
    target_triple:
      process.platform === "win32" ? "windows-x86_64" : "linux-x86_64",
    entrypoints: {
      timing_profile: "engine/tools/qualify_uci_time_profile.mjs",
      paired_sprt: "arena/run_sprt_match.mjs",
      complete_game: "arena/run_complete_game_matrix.mjs",
    },
    native_entrypoints: {
      referee: process.platform === "win32"
        ? "bin/uci_arena_complete_game_referee.exe"
        : "bin/uci_arena_complete_game_referee",
    },
  }, null, 2)}\n`);
  config.resources.consecutiveIdleSamples = 1;
  config.resources.minimumFreeWorkspaceGb = 1;
  return config;
}

test("configuration preserves an explicit external Evidence Runtime root", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "arena-evidence-runtime-root-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configuredRuntime = path.join(root, "external runtime");
  const configFile = path.join(root, "manager-config.json");
  writeFileSync(configFile, `${JSON.stringify({
    schema: "uci_arena_evidence_service_config_v1",
    runtimeRoot: configuredRuntime,
  }, null, 2)}\n`, "utf8");

  const config = await loadConfig({
    configFile,
    workspace: path.join(root, "workspace"),
  });

  assert.equal(config.runtimeRoot, path.resolve(configuredRuntime));
  assert.equal(config.repositoryRoot, path.resolve(configuredRuntime));
  assert.notEqual(config.runtimeRoot, packageRoot);
});

function closeWorkspaceAfter(t, config, catalog) {
  if (catalog) t.after(() => catalog.close());
  t.after(() => rm(config.workspace, { recursive: true, force: true }));
}

function targetFixture(config) {
  const modelRoot = path.join(config.workspace, "model");
  mkdirSync(modelRoot, { recursive: true });
  return {
    label: "fixture",
    modelId: "fixture_model",
    modelRoot,
    modelFingerprint: "123456789",
    enginePath: process.execPath,
    engineSha256: sha256File(process.execPath),
    provider: "cpu",
    hardwareDriverFingerprint: "",
    uciOptions: {},
  };
}

function resourceAuthority() {
  return {
    schema: "uci_arena_gpu_resource_isolation_v1",
    interval_id: randomUUID(),
    interval_status: "finalized",
    performance_authority: true,
    strength_authority: true,
    default_tuning_authority: true,
    problems: [],
  };
}

function currentTimingGates(searchCore = "mcgs") {
  const gates = Object.fromEntries([
    "legal_moves",
    "nonterminal_null_moves",
    "controller_disabled",
    "provider_timing_captured",
    "provider_service_reserve_valid",
    "applied_provider_service_reserve_covered",
    "applied_backup_emit_reserve_covered",
    "p99_deadline_overshoot_passed",
    "maximum_deadline_overshoot_passed",
    "passed",
  ].map((name) => [name, true]));
  if (searchCore === "mcgs") {
    for (const name of [
      "mcgs_root_coverage_passed",
      "mcgs_policy_only_fallback_passed",
      "mcgs_graph_population_passed",
      "mcgs_async_overlap_passed",
      "mcgs_single_owner_passed",
      "mcgs_low_budget_fallback_passed",
      "mcgs_deterministic_fallback_passed",
      "mcgs_completion_integrity_passed",
      "mcgs_temporal_policy_passed",
      "mcgs_deadline_tail_telemetry_passed",
    ]) gates[name] = true;
  }
  return gates;
}

function timingProfileFixture(target, { permissions = undefined } = {}) {
  const options = target.uciOptions ?? {};
  const searchCore = String(options.SearchCore ?? "mcgs");
  const identity = {
    time_policy_version: "persistent_mcgs_relative_clock_temporal_v4",
    engine: {
      executable_sha256: `sha256:${target.engineSha256}`,
      engine_build_fingerprint: `sha256:${"b".repeat(64)}`,
    },
    model: {
      model_id: target.modelId,
      model_fingerprint: String(target.modelFingerprint),
    },
    provider: {
      provider_numeric_fingerprint: "101",
      hardware_driver_fingerprint: target.hardwareDriverFingerprint || "202",
      onnx_runtime_version: "1.24.4",
    },
    search: {
      provider_requested: target.provider,
      provider_effective: target.provider,
      search_core: searchCore,
      threads: Number(options.Threads ?? 3),
      root_workers: Number(options.RootWorkers ?? 1),
      split_depth: Number(options.V2SplitDepth ?? 2),
      batch_size_configured: Number(options.NNBatchSize ?? 32),
      batch_size_effective: Number(options.NNBatchSize ?? 32),
      batch_wait_us_configured: Number(options.NNBatchWaitUs ?? 150),
      batch_wait_us_effective: Number(options.NNBatchWaitUs ?? 150),
      background_search: false,
      nn_speculation: false,
      opening_book: false,
      iterative_time_controller: false,
      extra_engine_options: {},
      mcgs: {
        time_policy: "RelativeClockTemporalV1",
        search_graph_mb: Number(options.SearchGraphMB ?? 64),
        cpuct_permille: Number(options.McgsCpuctPermille ?? 1500),
        outstanding_batches: Number(options.McgsOutstandingBatches ?? 2),
        book_prior_blend_permille: Number(options.McgsBookPriorBlendPermille ?? 0),
      },
    },
  };
  return {
    schema: "uci_time_profile_v3",
    qualified: true,
    published_at: "2026-08-08T00:00:00.000Z",
    identity,
    identity_sha256: `sha256:${createHash("sha256")
      .update(canonicalJson(identity)).digest("hex")}`,
    qualification: { repetitions_per_case: 30 },
    ...(permissions === undefined ? {} : { permissions }),
    predictive_controller: {
      default_enabled: false,
      enabled_by_profile: false,
    },
    gates: currentTimingGates(searchCore),
    calibration: {
      provider_batch_reserve_us: 1000,
      backup_emit_reserve_us: 1000,
      iteration_forecast_scale_permille: 1000,
    },
    applicability: {
      move_overhead_ms: {
        minimum: 250,
        maximum: 1500,
        tested_values: [250, 650, 700, 1500],
      },
    },
  };
}

function runCommand(executable, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, args, {
      ...options,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => resolvePromise({ code, signal, stdout, stderr }));
  });
}

test("catalog recovers running jobs without losing attempt evidence", async (t) => {
  const config = await workspace();
  let catalog = new Catalog(config);
  closeWorkspaceAfter(t, config, { close: () => catalog.close() });
  const target = catalog.addTarget(targetFixture(config));
  const datasetId = catalog.createDataset({ campaign: "test" });
  const job = catalog.enqueueJob({
    adapter: "paired_sprt",
    targetId: target.id,
    shardId: "pair",
    datasetId,
    config: { evidenceMode: "paired_strength", control: "30+0" },
    fingerprint: jobFingerprint({ test: "recovery" }),
  });
  catalog.startAttempt(job.id);
  assert.equal(catalog.job(job.id).state, "running");
  catalog.close();
  catalog = new Catalog(config);
  assert.equal(catalog.job(job.id).state, "running");
  assert.equal(catalog.status().jobs.running, 1);
  assert.equal(catalog.recoverInterruptedJobs(), 1);
  assert.equal(catalog.job(job.id).state, "queued");
  assert.match(catalog.job(job.id).waitReason, /recovered/);
});

test("status is healthy and visibly waiting when no target source exists", async (t) => {
  const config = await workspace();
  config.activeModelPointer = path.join(config.workspace, "missing-active-model.json");
  const catalog = new Catalog(config);
  closeWorkspaceAfter(t, config, catalog);
  const status = catalog.status();
  assert.equal(status.collection.state, "waiting_for_target");
  assert.match(status.collection.reason, /no active deployment/);
  assert.equal(status.control.paused, false);
  assert.equal(status.daemon.active, false);
  assert.equal(status.daemon.processAlive, false);
  assert.equal(status.daemon.stale, true);
});

test("daemon status requires a live process and fresh heartbeat", async (t) => {
  const config = await workspace();
  const catalog = new Catalog(config);
  closeWorkspaceAfter(t, config, catalog);

  catalog.updateDaemonState({
    pid: process.pid,
    processIdentity: currentProcessIdentity(),
    phase: "sleep",
    heartbeatAt: new Date().toISOString(),
  });
  const live = catalog.status().daemon;
  assert.equal(live.processAlive, true);
  assert.equal(live.stale, false);
  assert.equal(live.active, true);

  catalog.updateDaemonState({ pid: 999_999_999 });
  const dead = catalog.status().daemon;
  assert.equal(dead.phase, "sleep");
  assert.equal(dead.processAlive, false);
  assert.equal(dead.stale, false);
  assert.equal(dead.active, false);

  catalog.updateDaemonState({
    pid: process.pid,
    processIdentity: currentProcessIdentity(),
    heartbeatAt: new Date(Date.now() - config.daemon.staleMs - 1_000).toISOString(),
  });
  const stale = catalog.status().daemon;
  assert.equal(stale.processAlive, true);
  assert.equal(stale.stale, true);
  assert.equal(stale.active, false);
});

test("first campaign is deterministic and staged after core controls", async (t) => {
  const config = await workspace();
  const catalog = new Catalog(config);
  closeWorkspaceAfter(t, config, catalog);
  const jobs = enqueueFirstCampaign(catalog);
  assert.equal(jobs.length, 46);
  assert.equal(jobs[0].adapter, "timing_profile");
  assert.equal(jobs[0].config.repetitions, 30);
  assert.deepEqual(jobs[0].config.engineOptions, []);
  assert.ok(jobs.some((job) => (
    job.config.candidateOptions?.includes("McgsTemporalWeightProfile=AdaptiveCurveV1")
    && job.config.controlOptions?.includes("McgsTemporalWeightProfile=EarlyCurrent")
  )));
  assert.ok(jobs.some((job) => job.shardId === "curve-40/120+5" && job.priority === 60));
  assert.ok(jobs.some((job) => job.shardId === "stockfish-180+3-depth14"));
  assert.equal(new Set(jobs.map((job) => job.fingerprint)).size, jobs.length);
  const repeated = enqueueFirstCampaign(catalog);
  assert.equal(repeated.length, 46);
  assert.equal(catalog.jobs().length, 46);
  assert.equal(catalog.datasets().length, 46);
});

test("timing adapter projects the exact MCGS topology without legacy policy injection", async (t) => {
  const config = await workspace();
  const catalog = new Catalog(config);
  closeWorkspaceAfter(t, config, catalog);
  const fixture = targetFixture(config);
  fixture.uciOptions = {
    SearchCore: "mcgs",
    Threads: 3,
    RootWorkers: 3,
    V2SplitDepth: 10,
    SearchGraphMB: 768,
    McgsCpuctPermille: 1_700,
    McgsOutstandingBatches: 3,
    McgsBookPriorBlendPermille: 200,
    McgsTimePolicy: "RelativeClockTemporalV1",
    NNBatchSize: 64,
    NNBatchWaitUs: 25,
  };
  const target = catalog.addTarget(fixture);
  const datasetId = catalog.createDataset({ campaign: "test" });
  const job = catalog.enqueueJob({
    adapter: "timing_profile",
    targetId: target.id,
    shardId: "mcgs-timing",
    datasetId,
    config: { repetitions: 3, engineOptions: [] },
    fingerprint: jobFingerprint({ test: "mcgs-timing-command" }),
  });
  const command = adapterCommand(
    job,
    target,
    config,
    path.join(config.paths.attempts, job.id, "0001"),
  );
  const joined = command.args.join(" ");
  assert.equal(
    command.args[0],
    path.join(
      config.runtimeRoot,
      "engine",
      "tools",
      "qualify_uci_time_profile.mjs",
    ),
  );
  assert.match(joined, /--search-core mcgs/);
  assert.match(joined, /--search-graph-mb 768/);
  assert.match(joined, /--mcgs-cpuct-permille 1700/);
  assert.match(joined, /--mcgs-outstanding-batches 3/);
  assert.match(joined, /--mcgs-book-prior-blend-permille 200/);
  assert.doesNotMatch(joined, /RelativeClockV3|TimePolicy=/);

  mkdirSync(path.dirname(command.outputs[0].filename), { recursive: true });
  const profile = timingProfileFixture(target);
  writeFileSync(command.outputs[0].filename, JSON.stringify(profile));
  const harvested = harvestAdapter(
    job,
    target,
    command,
    config,
    catalog,
    resourceAuthority(),
  );
  assert.equal(harvested.envelopes.length, 1);
  assert.equal(harvested.envelopes[0].authority.timing, true);
  assert.equal(harvested.envelopes[0].authority.profile_publication, true);

  const drifted = structuredClone(profile);
  drifted.identity.search.threads = 4;
  drifted.identity_sha256 = `sha256:${createHash("sha256")
    .update(canonicalJson(drifted.identity)).digest("hex")}`;
  writeFileSync(command.outputs[0].filename, JSON.stringify(drifted));
  assert.throws(
    () => harvestAdapter(job, target, command, config, catalog, resourceAuthority()),
    /timing profile threads expected "3" got "4"/,
  );

  const invalidTarget = {
    ...target,
    uciOptions: { ...target.uciOptions, McgsTimePolicy: "Legacy" },
  };
  assert.throws(
    () => adapterCommand(job, invalidTarget, config, path.join(config.workspace, "invalid")),
    /McgsTimePolicy must be RelativeClockTemporalV1/,
  );
});

test("timing adapter retains a failed qualifier attempt as diagnostic-only evidence", async (t) => {
  const config = await workspace();
  const catalog = new Catalog(config);
  closeWorkspaceAfter(t, config, catalog);
  const target = catalog.addTarget(targetFixture(config));
  const datasetId = catalog.createDataset({ campaign: "timing-failure" });
  const job = catalog.enqueueJob({
    adapter: "timing_profile",
    targetId: target.id,
    shardId: "timing-failure",
    datasetId,
    config: { repetitions: 30 },
    fingerprint: jobFingerprint({ test: "timing-failure-artifact" }),
  });
  const command = adapterCommand(
    job,
    target,
    config,
    path.join(config.paths.attempts, job.id, "0001"),
  );
  assert.equal(command.outputs[0].kind, "json");
  assert.equal(command.outputs[1].kind, "json-directory");
  assert.match(command.args.join(" "), /--publication-mode candidate/);
  assert.match(command.args.join(" "), /--checkpoint .*uci_time_profile_checkpoint\.json/);
  assert.ok(command.args.includes("--resume"));

  mkdirSync(command.outputs[1].filename, { recursive: true });
  const producerError = "forced_response repetition 0 produced illegal bestmove a2a3";
  writeFileSync(path.join(command.outputs[1].filename, "rejected.json"), JSON.stringify({
    schema: "uci_time_profile_attempt_v3",
    phase: "diagnostic",
    outcome: "rejected",
    recorded_at: "2026-08-08T00:00:00.000Z",
    identity: null,
    gates: null,
    calibration: null,
    error: producerError,
    samples: [],
    failed_samples: [{ case_id: "forced_response", error: producerError }],
  }));
  const harvested = harvestAdapter(
    job,
    target,
    command,
    config,
    catalog,
    resourceAuthority(),
  );
  assert.deepEqual(harvested.producerFailures, [producerError]);
  assert.equal(harvested.envelopes.length, 1);
  assert.equal(harvested.envelopes[0].authority.diagnostic, true);
  assert.equal(harvested.envelopes[0].authority.timing, false);
  assert.equal(harvested.envelopes[0].authority.profile_publication, false);
  assert.match(
    harvested.envelopes[0].authority.reasons.join(","),
    /attempt_is_diagnostic_only/,
  );
  assert.equal(harvested.envelopes[0].outcome.failure, producerError);
  assert.equal(catalog.dataset(datasetId).observationCount, 1);
});

test("complete-game adapter keeps deterministic topology activation separate from deadline probing", async (t) => {
  const config = await workspace();
  const catalog = new Catalog(config);
  closeWorkspaceAfter(t, config, catalog);
  const fixture = targetFixture(config);
  fixture.uciOptions = {
    SearchCore: "v2",
    Threads: 4,
    RootWorkers: 4,
    V2SplitDepth: 3,
    NNBatchSize: 64,
  };
  const target = catalog.addTarget(fixture);
  const datasetId = catalog.createDataset({ campaign: "complete-game" });
  const job = catalog.enqueueJob({
    adapter: "complete_game",
    targetId: target.id,
    shardId: "activation-contract",
    datasetId,
    config: {
      activationDepth: 8,
      activationMovetimeMs: 1_500,
      timeMs: ["25"],
    },
    fingerprint: jobFingerprint({ test: "complete-game-activation-command" }),
  });
  const command = adapterCommand(
    job,
    target,
    config,
    path.join(config.paths.attempts, job.id, "0001"),
  );
  const joined = command.args.join(" ");
  assert.match(joined, /--split-depth 3/);
  assert.match(joined, /--activation-depth 8/);
  assert.match(joined, /--activation-movetime-ms 1500/);
  assert.match(joined, /--time-ms 25/);

  assert.throws(
    () => adapterCommand(
      { ...job, config: { ...job.config, activationDepth: 2 } },
      target,
      config,
      path.join(config.workspace, "invalid-activation"),
    ),
    /activationDepth must be in 3\.\.64/,
  );
});

for (const version of [3, 4]) {
  test(`complete-game v${version} harvest preserves runtime diagnostics without qualification authority`, async (t) => {
    const config = await workspace();
    const catalog = new Catalog(config);
    closeWorkspaceAfter(t, config, catalog);
    const target = catalog.addTarget(targetFixture(config));
    const datasetId = catalog.createDataset({ campaign: "complete-game" });
    const job = catalog.enqueueJob({
      adapter: "complete_game", targetId: target.id, shardId: "diagnostic",
      datasetId, config: {}, fingerprint: jobFingerprint({ completeGameVersion: version }),
    });
    const command = adapterCommand(job, target, config,
      path.join(config.paths.attempts, job.id, "0001"));
    const sourceSchema = `uci_arena_complete_game_matrix_v${version}`;
    const record = {
      schema: sourceSchema,
      deployed_model: {
        expected_model_id: target.modelId,
        expected_model_fingerprint: target.modelFingerprint,
        expected_provider: target.provider,
      },
      failures: [], completed: true, qualified: true, gates: { passed: true },
      summary: { games: 2, complete: true },
      runtime_contract: {
        statistical_promotion_authority: false,
        expected_parallel_topology: { search_core: "mcgs", threads: 1 },
        activation_probe: { continuous_focus_valid: true, active_tickets: 4, ticket_capacity: 64 },
      },
    };
    const raw = Buffer.from(`${JSON.stringify(record)}\n`);
    mkdirSync(path.dirname(command.outputs[0].filename), { recursive: true });
    writeFileSync(command.outputs[0].filename, raw);
    for (const resource of [resourceAuthority(), {
      ...resourceAuthority(), performance_authority: false, strength_authority: false,
      default_tuning_authority: false, problems: ["contaminated_interval"],
    }]) {
      const { envelopes } = harvestAdapter(job, target, command, config, catalog, resource);
      assert.equal(envelopes[0].source_schema, sourceSchema);
      assert.deepEqual(envelopes[0].metrics, {
        summary: { games: 2, complete: true },
        runtime_contract: {
          statistical_promotion_authority: false,
          expected_parallel_topology: { search_core: "mcgs", threads: 1 },
          activation_probe: { continuous_focus_valid: true, active_tickets: 4, ticket_capacity: 64 },
        },
        completed: true,
      });
      assert.equal(envelopes[0].authority.diagnostic, true);
      assert.equal(envelopes[0].authority.timing, false);
      assert.equal(envelopes[0].authority.strength, false);
      assert.equal(envelopes[0].authority.profile_publication, false);
      assert.ok(envelopes[0].authority.reasons.includes("complete_game_matrix_is_diagnostic_only"));
    }
    const stored = catalog.dataset(datasetId).observations[0];
    assert.equal(stored.source_schema, sourceSchema);
    assert.equal(stored.raw_sha256, createHash("sha256").update(raw).digest("hex"));
    assert.deepEqual(readFileSync(path.join(config.paths.artifacts,
      stored.raw_sha256.slice(0, 2), `${stored.raw_sha256}.raw`)), raw);
    for (const [changed, diagnostic] of [
      [{ schema: "uci_arena_complete_game_matrix_v5" }, /incompatible schema/],
      [{ deployed_model: { ...record.deployed_model, expected_model_id: "other_model" } }, /complete-game model_id/],
      [{ deployed_model: null, failures: [{ message: "focus verification failed" }] }, /reported failure: focus verification failed/],
    ]) {
      writeFileSync(command.outputs[0].filename, JSON.stringify({ ...record, ...changed }));
      assert.throws(() => harvestAdapter(job, target, command, config, catalog,
        resourceAuthority()), diagnostic);
      assert.equal(catalog.dataset(datasetId).observationCount, 1);
    }
  });
}

test("runtime contract fails closed before adapter subprocess construction", async (t) => {
  const config = await workspace();
  const catalog = new Catalog(config);
  closeWorkspaceAfter(t, config, catalog);
  const target = catalog.addTarget(targetFixture(config));
  const datasetId = catalog.createDataset({ campaign: "contract" });
  const job = catalog.enqueueJob({
    adapter: "paired_sprt",
    targetId: target.id,
    shardId: "contract",
    datasetId,
    config: { evidenceMode: "paired_strength", control: "30+0" },
    fingerprint: jobFingerprint({ test: "runtime-contract" }),
  });
  const contractPath = path.join(
    config.runtimeRoot,
    "contracts",
    "evidence-runtime-contract.json",
  );
  writeFileSync(contractPath, `${JSON.stringify({
    schema: "uci_arena_evidence_runtime_v1",
    component_id: "uci_arena_evidence.runtime",
    component_version: "0.3.0",
    target_triple:
      process.platform === "win32" ? "windows-x86_64" : "linux-x86_64",
    entrypoints: {
      timing_profile: "engine/tools/qualify_uci_time_profile.mjs",
      paired_sprt: "../substituted-runner.mjs",
      complete_game: "arena/run_complete_game_matrix.mjs",
    },
    native_entrypoints: {
      referee: process.platform === "win32"
        ? "bin/uci_arena_complete_game_referee.exe"
        : "bin/uci_arena_complete_game_referee",
    },
  })}\n`);
  assert.throws(
    () => adapterCommand(
      job,
      target,
      config,
      path.join(config.workspace, "attempt"),
    ),
    /paired_sprt entrypoint is incompatible/u,
  );
});

test("active and explicit targets fail closed on missing identity and drift", async (t) => {
  const config = await workspace();
  const engine = path.join(config.workspace, "engine.bin");
  const modelRoot = path.join(config.workspace, "active-model", "current");
  mkdirSync(modelRoot, { recursive: true });
  writeFileSync(engine, "engine-v1", "utf8");
  config.engine = engine;
  config.activeModelPointer = path.join(config.workspace, "runtime_state", "active_model_runtime.json");
  mkdirSync(path.dirname(config.activeModelPointer), { recursive: true });
  writeFileSync(config.activeModelPointer, JSON.stringify({
    model_id: "active_model",
    model_fingerprint: "9988",
    provider: "cpu",
    model_root: modelRoot,
    engine_path: engine,
    engine_sha256: sha256File(engine),
    uci_options: { Threads: 2, SearchCore: "legacy" },
  }));
  const active = resolveActiveTarget(config);
  assert.equal(active.target.modelId, "active_model");
  assert.equal(active.target.engineSha256, sha256File(engine));

  const catalog = new Catalog(config);
  closeWorkspaceAfter(t, config, catalog);
  const target = catalog.addTarget({
    ...targetFixture(config),
    enginePath: engine,
    engineSha256: sha256File(engine),
  });
  const datasetId = catalog.createDataset({ campaign: "drift" });
  const job = catalog.enqueueJob({
    adapter: "paired_sprt",
    targetId: target.id,
    shardId: "drift",
    datasetId,
    config: { evidenceMode: "curve", control: "30+0" },
    fingerprint: jobFingerprint({ test: "drift" }),
  });
  writeFileSync(engine, "engine-v2", "utf8");
  assert.match(resolveJobTarget(job, catalog, config).reason, /identity drifted/);
  assert.match(resolveActiveTarget(config).reason, /SHA-256/);
});

test("default target resolution preserves active authority over retained targets", async (t) => {
  const config = await workspace();
  const catalog = new Catalog(config);
  closeWorkspaceAfter(t, config, catalog);
  const activeModelRoot = path.join(config.workspace, "active-model", "current");
  mkdirSync(activeModelRoot, { recursive: true });
  mkdirSync(path.dirname(config.activeModelPointer), { recursive: true });
  writeFileSync(config.activeModelPointer, JSON.stringify({
    model_id: "active_model",
    model_fingerprint: "9988",
    provider: "directml",
    model_root: activeModelRoot,
    engine_path: process.execPath,
    engine_sha256: sha256File(process.execPath),
    uci_options: { SearchCore: "mcgs" },
  }));
  const retainedCpuTarget = catalog.addTarget(targetFixture(config));

  const active = resolveJobTarget({ targetId: null }, catalog, config);
  assert.equal(active.target.id, null);
  assert.equal(active.target.modelId, "active_model");
  assert.equal(active.target.provider, "directml");

  unlinkSync(config.activeModelPointer);
  const soleFallback = resolveJobTarget({ targetId: null }, catalog, config);
  assert.equal(soleFallback.target.id, retainedCpuTarget.id);
  assert.equal(soleFallback.target.provider, "cpu");

  catalog.addTarget({
    ...targetFixture(config),
    label: "second retained target",
    provider: "directml",
  });
  const ambiguous = resolveJobTarget({ targetId: null }, catalog, config);
  assert.equal(ambiguous.target, null);
  assert.match(ambiguous.reason, /multiple explicit targets require a selected target UUID/u);
});

test("shared lease is FIFO and foreground revokes a background holder", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "arena-lease-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const background = await acquireResourceLease({
    producer: "test_background",
    priority: "background",
    root,
    timeoutMs: 0,
  });
  assert.ok(background);
  const foregroundPromise = acquireResourceLease({
    producer: "test_foreground",
    priority: "foreground",
    root,
    timeoutMs: 2_000,
    pollMs: 25,
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.match(background.revocationReason(), /foreground_resource_request/);
  const inherited = validateInheritedResourceLease(background.token, { root });
  assert.equal(inherited.valid, true);
  background.release();
  const foreground = await foregroundPromise;
  assert.ok(foreground);
  foreground.release();
});

test("resource governor admits sustained idle and rejects foreground demand", async (t) => {
  const config = await workspace();
  const catalog = new Catalog(config);
  closeWorkspaceAfter(t, config, catalog);
  const totals = [
    { idle: 1_000, total: 2_000 },
    { idle: 1_900, total: 3_000 },
    { idle: 2_800, total: 4_000 },
  ];
  let index = 0;
  let foreground = false;
  const native = {
    start() {},
    close() {},
    async probe() {
      return {
        input_idle_ms: 120_000,
        on_battery: false,
        battery_saver: false,
        processor_limit_percent: 100,
      };
    },
  };
  const governor = new ResourceGovernor(config, catalog, {
    cpuTotalsImpl: () => totals[Math.min(index++, totals.length - 1)],
    statfsImpl: async () => ({ bavail: 200n * 1024n ** 3n, bsize: 1n }),
    freeMemoryImpl: () => 16 * 1024 ** 3,
    totalMemoryImpl: () => 32 * 1024 ** 3,
    processProbe: async () => [],
    gpuProbe: async () => ({ available: true, utilizationPercent: 0 }),
    ownerProbe: (root) => ({ root, active: false }),
    foregroundProbe: () => foreground,
    nativeHelper: native,
    platformProbe: async () => null,
  });
  t.after(() => governor.close());
  const allowed = await governor.permit({ provider: "cuda" });
  assert.equal(allowed.allowed, true);
  foreground = true;
  const blocked = await governor.permit({ provider: "cuda", duringRun: true });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.mode, "preempt");
});

test("resource governor fails closed when platform idle and power telemetry is absent", async (t) => {
  const config = await workspace();
  const catalog = new Catalog(config);
  closeWorkspaceAfter(t, config, catalog);
  const governor = new ResourceGovernor(config, catalog, {
    cpuTotalsImpl: (() => {
      let value = 0;
      return () => ({ idle: value += 1_000, total: value });
    })(),
    statfsImpl: async () => ({ bavail: 200n * 1024n ** 3n, bsize: 1n }),
    freeMemoryImpl: () => 16 * 1024 ** 3,
    totalMemoryImpl: () => 32 * 1024 ** 3,
    processProbe: async () => [],
    gpuProbe: async () => ({ available: true, utilizationPercent: 0 }),
    ownerProbe: (root) => ({ root, active: false }),
    foregroundProbe: () => false,
    nativeHelper: { start() {}, close() {}, async probe() { return null; } },
    platformProbe: async () => null,
  });
  t.after(() => governor.close());
  const permit = await governor.permit({ provider: "cpu" });
  assert.equal(permit.allowed, false);
  assert.match(permit.reason, /telemetry is unavailable/);
});

test("resource governor blocks Restaurant, engine, battery, thermal, memory, and disk pressure", async (t) => {
  const config = await workspace();
  config.resources.minimumFreeWorkspaceGb = 75;
  config.restaurantRoots = [config.workspace];
  const catalog = new Catalog(config);
  closeWorkspaceAfter(t, config, catalog);
  const base = {
    diskGb: 200,
    freeMemoryGb: 16,
    processes: [],
    ownerActive: false,
    platform: {
      input_idle_ms: 120_000,
      on_battery: false,
      battery_saver: false,
      processor_limit_percent: 100,
      thermal_pressure: false,
    },
  };
  const cases = [
    { name: "Restaurant", override: { ownerActive: true }, pattern: /Restaurant/ },
    {
      name: "unowned engine",
      override: { processes: [path.basename(config.engine)] },
      pattern: /unowned engine/,
    },
    {
      name: "battery",
      override: { platform: { ...base.platform, on_battery: true } },
      pattern: /battery/,
    },
    {
      name: "thermal",
      override: { platform: { ...base.platform, thermal_pressure: true } },
      pattern: /thermal/,
    },
    { name: "memory", override: { freeMemoryGb: 1 }, pattern: /memory pressure/ },
    { name: "disk", override: { diskGb: 1 }, pattern: /free space/ },
  ];
  for (const item of cases) {
    const state = { ...base, ...item.override };
    let cpu = 0;
    const governor = new ResourceGovernor(config, catalog, {
      cpuTotalsImpl: () => ({ idle: cpu += 1_000, total: cpu }),
      statfsImpl: async () => ({
        bavail: BigInt(state.diskGb) * 1024n ** 3n,
        bsize: 1n,
      }),
      freeMemoryImpl: () => state.freeMemoryGb * 1024 ** 3,
      totalMemoryImpl: () => 32 * 1024 ** 3,
      processProbe: async () => state.processes,
      gpuProbe: async () => ({ available: true, utilizationPercent: 0 }),
      ownerProbe: (root) => ({ root, active: state.ownerActive }),
      foregroundProbe: () => false,
      nativeHelper: {
        start() {},
        close() {},
        async probe() { return state.platform; },
      },
      platformProbe: async () => null,
    });
    try {
      const permit = await governor.permit({ provider: "cpu" });
      assert.equal(permit.allowed, false, item.name);
      assert.match(permit.reason, item.pattern, item.name);
    } finally {
      governor.close();
    }
  }
});

test("Node paired adapter normalizes only a complete reversed-color pair as strength evidence", async (t) => {
  const config = await workspace();
  const catalog = new Catalog(config);
  closeWorkspaceAfter(t, config, catalog);
  const target = catalog.addTarget(targetFixture(config));
  const datasetId = catalog.createDataset({ campaign: "test" });
  const job = catalog.enqueueJob({
    adapter: "paired_sprt",
    targetId: target.id,
    shardId: "pair",
    datasetId,
    config: {
      evidenceMode: "paired_strength",
      control: "30+0",
      maxPairs: 1,
      pairIndex: 0,
      candidateOptions: ["McgsTemporalWeightProfile=AdaptiveCurveV1"],
      controlOptions: ["McgsTemporalWeightProfile=EarlyCurrent"],
    },
    fingerprint: jobFingerprint({ test: "normalize" }),
  });
  const attempt = path.join(config.paths.attempts, job.id, "0001");
  const command = adapterCommand(job, target, config, attempt);
  mkdirSync(path.dirname(command.outputs[0].filename), { recursive: true });
  const game = (id, gameIndex, color, result) => ({
    game_id: id,
    game_index: gameIndex,
    pair_index: 0,
    opening_id: "startpos",
    opening_moves: [],
    candidate_color: color,
    result,
    termination: "checkmate",
    complete: true,
    clocks_ms: { white: 1_000, black: 2_000 },
    moves: ["e2e4"],
    records: [{
      ply: 1,
      owner: "candidate",
      move: "e2e4",
      elapsed_ms: 10,
      score: { depth: 8, nodes: 100, nps: 10_000 },
    }],
  });
  const games = [game("pair-0-game-0", 0, "white", "1-0"), game("pair-0-game-1", 1, "black", "0-1")];
  const record = {
    schema: "uci_arena_paired_sprt_v2",
    run_fingerprint: "fixture",
    time_control: { source: "30+0", initial_ms: 30_000, increment_ms: 0 },
    opponent: { kind: "engine" },
    runtime_identity: {
      engine_sha256: target.engineSha256,
      candidate: {
        model_id: target.modelId,
        model_fingerprint: target.modelFingerprint,
        provider_effective: target.provider,
      },
      control: {
        model_id: target.modelId,
        model_fingerprint: target.modelFingerprint,
        provider_effective: target.provider,
      },
    },
    failures: [],
    sprt: {
      pairs: 1,
      games: 2,
      state: { decision: "continue" },
      pentanomial: { ww: 1 },
      pair_records: [{ pair_index: 0, opening_id: "startpos", games }],
    },
  };
  const raw = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
  writeFileSync(command.outputs[0].filename, raw);
  const harvested = harvestAdapter(job, target, command, config, catalog, resourceAuthority());
  assert.equal(harvested.envelopes.length, 1);
  assert.ok(harvested.envelopes.every((row) => row.authority.strength));
  assert.equal(catalog.dataset(datasetId).observations.length, 1);
  const firstRaw = catalog.dataset(datasetId).observations[0];
  assert.equal(
    firstRaw.raw_sha256,
    createHash("sha256").update(raw).digest("hex"),
  );
  assert.deepEqual(readFileSync(
    path.join(config.paths.artifacts, firstRaw.raw_sha256.slice(0, 2), `${firstRaw.raw_sha256}.raw`),
  ), raw);
  const diagnostic = harvestAdapter(job, target, command, config, catalog, {
    ...resourceAuthority(),
    performance_authority: false,
    strength_authority: false,
    default_tuning_authority: false,
    problems: ["attestation_missing_or_contaminated"],
  });
  assert.equal(diagnostic.envelopes[0].authority.timing, false);
  assert.equal(diagnostic.envelopes[0].authority.strength, false);
  assert.match(diagnostic.envelopes[0].authority.reasons.join(","), /attestation/);

  writeFileSync(command.outputs[0].filename, `${JSON.stringify({
    ...record,
    runtime_identity: null,
    failures: [{ message: "candidate.model_id expected fixture_model got other_model" }],
  })}\n`);
  assert.throws(
    () => harvestAdapter(job, target, command, config, catalog, resourceAuthority()),
    /adapter paired_sprt reported failure: candidate\.model_id expected fixture_model got other_model/,
  );

  writeFileSync(command.outputs[0].filename, `${JSON.stringify({ schema: "incompatible_schema_v99" })}\n`);
  assert.throws(
    () => harvestAdapter(job, target, command, config, catalog, resourceAuthority()),
    /incompatible schema/,
  );
  assert.equal(catalog.dataset(datasetId).observationCount, 1);
});

test("Node clocked runner preserves manifest, clocks, colors, telemetry, and resume", async (t) => {
  const config = await workspace();
  closeWorkspaceAfter(t, config);
  const runner = path.join(runtimeIntegrationRoot, "arena", "run_sprt_match.mjs");
  if (!existsSync(runner)) {
    t.skip("requires the pinned uci_arena_evidence.runtime component");
    return;
  }
  const mock = path.join(
    packageRoot,
    "fixtures",
    "mock_uci_engine.mjs",
  );
  const mockReferee = path.join(
    packageRoot,
    "fixtures",
    "mock_referee.mjs",
  );
  const referee = existsSync(config.referee) ? config.referee : process.execPath;
  const refereeArgs = existsSync(config.referee) ? [] : ["--referee-arg", mockReferee];
  const output = path.join(config.workspace, "clocked.json");
  const args = [
    runner,
    "--engine", process.execPath,
    "--engine-arg", mock,
    "--stockfish", process.execPath,
    "--stockfish-arg", mock,
    "--referee", referee,
    ...refereeArgs,
    "--output", output,
    "--mode", "sprt",
    "--time-control", "1+0",
    "--max-pairs", "1",
    "--max-plies", "4",
    "--adjudication-cp", "0",
    "--evidence-only",
    "--resume",
  ];
  const first = await runCommand(process.execPath, args, { cwd: repositoryRoot });
  assert.equal(first.code, 0, first.stderr);
  const artifact = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(artifact.runtime, "nodejs");
  assert.equal(artifact.time_control.source, "1+0");
  assert.equal(artifact.manifest.games.length, 2);
  assert.equal(artifact.option_activation.candidate.passed, true);
  assert.equal(artifact.option_activation.control.passed, true);
  const games = artifact.sprt.pair_records[0].games;
  assert.deepEqual(games.map((game) => game.candidate_color), ["white", "black"]);
  assert.equal(games.every((game) => game.records.length > 0), true);
  assert.equal(games.every((game) => game.records[0].go_command.includes("wtime")), true);
  assert.equal(games[0].records[0].score.nodes, 1000);

  const firstGeneratedAt = artifact.generated_at;
  const second = await runCommand(process.execPath, args, { cwd: repositoryRoot });
  assert.equal(second.code, 0, second.stderr);
  const resumed = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(resumed.generated_at, firstGeneratedAt);
  assert.equal(resumed.sprt.games, 2);
  assert.equal(
    new Set(resumed.sprt.pair_records[0].games.map((game) => game.game_id)).size,
    2,
  );

  const manifestPath = path.join(config.workspace, "single-game-manifest.json");
  const singleOutput = path.join(config.workspace, "single-game.json");
  writeFileSync(manifestPath, `${JSON.stringify({
    schema: "uci_arena_match_manifest_v1",
    games: [{
      game_id: "single-black",
      game_index: 1,
      pair_index: 9,
      opening_id: "king-pawn",
      opening_moves: ["e2e4", "e7e5"],
      candidate_color: "black",
    }],
  })}\n`);
  const singleArgs = [
    runner,
    "--engine", process.execPath,
    "--engine-arg", mock,
    "--stockfish", process.execPath,
    "--stockfish-arg", mock,
    "--referee", referee,
    ...refereeArgs,
    "--output", singleOutput,
    "--mode", "sprt",
    "--time-control", "1+0",
    "--manifest", manifestPath,
    "--max-plies", "4",
    "--adjudication-cp", "0",
    "--evidence-only",
  ];
  const single = await runCommand(process.execPath, singleArgs, { cwd: repositoryRoot });
  assert.equal(single.code, 0, single.stderr);
  const singleArtifact = JSON.parse(readFileSync(singleOutput, "utf8"));
  const singleGame = singleArtifact.sprt.pair_records[0].games[0];
  assert.equal(singleArtifact.sprt.games, 1);
  assert.equal(singleGame.game_id, "single-black");
  assert.deepEqual(singleGame.opening_moves, ["e2e4", "e7e5"]);
  assert.deepEqual(singleGame.moves.slice(0, 2), ["e2e4", "e7e5"]);
});

test("status redacts sensitive fields and audited prune keeps dataset counts consistent", async (t) => {
  const config = await workspace();
  const catalog = new Catalog(config);
  closeWorkspaceAfter(t, config, catalog);
  catalog.updateDaemonState({
    lastReport: {
      token: "do-not-expose",
      nested: { authorization: "private", message: "safe" },
    },
  });
  const status = catalog.status();
  assert.equal(status.daemon.lastReport.token, "[redacted]");
  assert.equal(status.daemon.lastReport.nested.authorization, "[redacted]");

  const target = catalog.addTarget(targetFixture(config));
  const datasetId = catalog.createDataset({ campaign: "prune" });
  const job = catalog.enqueueJob({
    adapter: "paired_sprt",
    targetId: target.id,
    shardId: "prune",
    datasetId,
    config: { evidenceMode: "curve", control: "30+0" },
    fingerprint: jobFingerprint({ test: "prune" }),
  });
  const raw = Buffer.from('{"schema":"fixture"}\n');
  const digest = createHash("sha256").update(raw).digest("hex");
  const artifact = path.join(config.paths.artifacts, `${digest}.raw`);
  writeFileSync(artifact, raw);
  catalog.registerArtifact({
    sha256: digest,
    schema: "fixture",
    filename: artifact,
    sizeBytes: raw.length,
  });
  catalog.addObservation({
    schema: "uci_arena_observation_envelope_v1",
    observation_id: randomUUID(),
    dataset_id: datasetId,
    job_id: job.id,
    shard_id: job.shardId,
    recorded_at: new Date().toISOString(),
    adapter: job.adapter,
    source_schema: "fixture",
    raw_sha256: digest,
    target_identity: {},
    axes: {},
    metrics: {},
    outcome: {},
    resource: {},
    authority: { diagnostic: true },
  });
  catalog.completeDataset(datasetId, { diagnostic: true });
  const dryRun = catalog.prune({
    before: new Date(Date.now() + 60_000).toISOString(),
  });
  assert.equal(dryRun.confirmed, false);
  assert.equal(existsSync(artifact), true);
  const pruned = catalog.prune({
    before: new Date(Date.now() + 60_000).toISOString(),
    confirm: "PRUNE",
  });
  assert.equal(pruned.deleted, 1);
  assert.equal(existsSync(artifact), false);
  assert.equal(catalog.dataset(datasetId).observationCount, 0);
});

test("profile publication is atomic, identity-scoped, archived, and authority-gated", async (t) => {
  const config = await workspace();
  closeWorkspaceAfter(t, config);
  config.runtimeModelsRoot = path.join(config.workspace, "runtime_state", "models");
  const target = { id: "target", ...targetFixture(config) };
  const live = path.join(
    config.runtimeModelsRoot,
    target.modelId,
    "cache",
    "uci_time_profile_v3.json",
  );
  mkdirSync(path.dirname(live), { recursive: true });
  writeFileSync(live, `${JSON.stringify({ schema: "uci_time_profile_v3", prior: true })}\n`);
  const candidate = timingProfileFixture(target);
  const resource = resourceAuthority();
  resource.default_tuning_authority = true;
  const publication = await publishQualifiedProfile({
    candidate,
    target,
    job: { id: "job", datasetId: "dataset" },
    config,
    resource,
  });
  assert.equal(publication.path, live);
  assert.equal(existsSync(publication.prior.path), true);
  const published = JSON.parse(readFileSync(live, "utf8"));
  assert.equal(published.permissions.provider_safety_qualified, true);
  assert.equal(published.permissions.forecast_shadow_qualified, true);
  assert.equal(published.permissions.adaptive_play_qualified, false);
  assert.equal(published.service_publication.resource_interval_id, resource.interval_id);

  await assert.rejects(
    publishQualifiedProfile({
      candidate,
      target,
      job: { id: "job", datasetId: "dataset" },
      config,
      resource: { ...resource, default_tuning_authority: false },
    }),
    /lacks publication authority/,
  );

  await assert.rejects(
    publishQualifiedProfile({
      candidate: {
        ...candidate,
        permissions: {
          provider_safety_qualified: false,
          forecast_shadow_qualified: true,
          adaptive_play_qualified: false,
        },
      },
      target,
      job: { id: "job", datasetId: "dataset" },
      config,
      resource,
    }),
    /lacks publication authority/,
  );
});

test("profile list validates and projects explicit qualified imports", async (t) => {
  const config = await workspace();
  const catalog = new Catalog(config);
  closeWorkspaceAfter(t, config, catalog);
  const identity = {
    time_policy_version: "persistent_mcgs_relative_clock_temporal_v4",
    engine: {
      executable_sha256: `sha256:${"a".repeat(64)}`,
      engine_build_fingerprint: `sha256:${"b".repeat(64)}`,
    },
    model: {
      model_id: "fixture_model",
      model_fingerprint: "123456789",
    },
    provider: {
      provider_numeric_fingerprint: "101",
      hardware_driver_fingerprint: "202",
      onnx_runtime_version: "1.24.4",
    },
    search: {
      provider_effective: "directml",
      search_core: "mcgs",
      threads: 2,
      root_workers: 2,
      split_depth: 2,
      batch_size_effective: 64,
      batch_wait_us_effective: 0,
      mcgs: {
        time_policy: "RelativeClockTemporalV1",
      },
    },
  };
  const profile = {
    schema: "uci_time_profile_v3",
    qualified: true,
    published_at: "2026-07-26T00:00:00.000Z",
    identity,
    identity_sha256: `sha256:${createHash("sha256")
      .update(canonicalJson(identity))
      .digest("hex")}`,
    predictive_controller: {
      default_enabled: false,
      enabled_by_profile: false,
    },
    gates: currentTimingGates(),
    calibration: {
      provider_batch_reserve_us: 1000,
      backup_emit_reserve_us: 1000,
      iteration_forecast_scale_permille: 1000,
      iteration_transitions: {
        runtime_p95_ms: Array(48).fill(0),
      },
    },
    applicability: {
      move_overhead_ms: {
        minimum: 250,
        maximum: 1500,
        tested_values: [250, 650, 700, 1500],
      },
    },
  };
  const imported = path.join(config.workspace, "imported-profile.json");
  writeFileSync(imported, `${JSON.stringify(profile)}\n`);
  config.profileImports = [imported];

  const profiles = listQualifiedProfiles(config, catalog);
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].schema, "uci_arena_evidence_profile_v1");
  assert.equal(profiles[0].source, "explicit_import");
  assert.equal(profiles[0].targetIdentity.model_id, "fixture_model");
  assert.equal(profiles[0].permissions.provider_safety_qualified, true);
  assert.equal(profiles[0].permissions.forecast_shadow_qualified, true);
  assert.equal(profiles[0].permissions.adaptive_play_qualified, false);
  assert.match(profiles[0].sha256, /^[0-9a-f]{64}$/);

  const activeModelRoot = path.join(config.workspace, "active-model");
  mkdirSync(activeModelRoot, { recursive: true });
  config.activeModelPointer = path.join(
    config.workspace,
    "manager-config.json",
  );
  config.runtimeModelsRoot = path.join(
    config.workspace,
    "runtime-models",
  );
  writeFileSync(config.activeModelPointer, `${JSON.stringify({
    model_id: identity.model.model_id,
    model_fingerprint: identity.model.model_fingerprint,
    model_root: activeModelRoot,
    provider: identity.search.provider_effective,
    engine_path: process.execPath,
    engine_sha256: sha256File(process.execPath),
  })}\n`);
  const live = path.join(
    config.runtimeModelsRoot,
    identity.model.model_id,
    "cache",
    "uci_time_profile_v3.json",
  );
  mkdirSync(path.dirname(live), { recursive: true });
  writeFileSync(live, `${JSON.stringify({
    ...profile,
    published_at: "2026-07-27T00:00:00.000Z",
  })}\n`);
  const withLiveProfile = listQualifiedProfiles(config, catalog);
  assert.equal(withLiveProfile.length, 2);
  assert.equal(
    withLiveProfile.filter(
      (candidate) => candidate.source === "service_live_cache",
    ).length,
    1,
  );

  writeFileSync(imported, `${JSON.stringify({ ...profile, qualified: false })}\n`);
  assert.throws(
    () => listQualifiedProfiles(config, catalog),
    /timing profile is not qualified/,
  );
});

test("daemon recovers a stale lock without disturbing an idle queue", async (t) => {
  const config = await workspace();
  const catalog = new Catalog(config);
  closeWorkspaceAfter(t, config, catalog);
  const lock = path.join(config.paths.locks, "daemon.lock");
  writeFileSync(lock, `${JSON.stringify({ pid: 999_999_999 })}\n`);
  const stale = new Date(Date.now() - 60_000);
  utimesSync(lock, stale, stale);
  const report = await runDaemon(catalog, config, { once: true });
  assert.equal(report.state, "idle");
  assert.equal(existsSync(lock), false);
});

test("daemon lock reclaims pid reuse without displacing an exact live owner", async (t) => {
  const config = await workspace();
  const catalog = new Catalog(config);
  closeWorkspaceAfter(t, config, catalog);
  const filename = path.join(config.paths.locks, "daemon.lock");
  const current = currentProcessIdentity();
  const replaced = {
    ...current,
    start_token: current.start_token === "1" ? "2" : "1",
  };
  const stale = new Date(Date.now() - config.daemon.staleMs - 10_000);
  writeFileSync(filename, `${JSON.stringify({
    schema: "uci_arena_evidence_daemon_lock_v2",
    pid: process.pid,
    nonce: "replaced-owner",
    processIdentity: replaced,
  })}\n`);
  utimesSync(filename, stale, stale);
  const acquired = await acquireDaemonLock(config, {
    identity: current,
    probe: () => ({ state: "present", identity: current }),
  });
  await acquired.release();

  writeFileSync(filename, `${JSON.stringify({
    schema: "uci_arena_evidence_daemon_lock_v2",
    pid: process.pid,
    nonce: "exact-owner",
    processIdentity: current,
  })}\n`);
  utimesSync(filename, stale, stale);
  await assert.rejects(
    acquireDaemonLock(config, {
      identity: current,
      probe: () => ({ state: "present", identity: current }),
    }),
    /another Arena Evidence daemon owns/,
  );

  writeFileSync(filename, `${JSON.stringify({ pid: process.pid })}\n`);
  utimesSync(filename, stale, stale);
  const migrated = await acquireDaemonLock(config, {
    identity: current,
    probe: () => ({ state: "present", identity: current }),
  });
  await migrated.release();
});

test("platform startup definitions preserve low-priority cleanup contracts", async (t) => {
  const config = await workspace();
  closeWorkspaceAfter(t, config);
  const windows = buildWindowsTaskXml(config, "S-1-5-21-1");
  assert.match(windows, /MultipleInstancesPolicy>IgnoreNew/);
  assert.match(windows, /ExecutionTimeLimit>PT0S/);
  assert.deepEqual(
    windowsTaskActionFromXml(windows),
    windowsStartupAction(config),
  );
  assert.equal(windowsTaskMatchesConfiguration(windows, config), true);
  assert.equal(
    windowsTaskMatchesConfiguration(
      windows.replace(config.workspace, `${config.workspace}-changed`),
      config,
    ),
    false,
  );
  const linux = buildLinuxUserUnit(config);
  assert.match(linux, new RegExp(`Description=UCI Arena Evidence Service`));
  assert.match(linux, /Nice=15/);
  assert.match(linux, /CPUWeight=10/);
  assert.match(linux, /IOWeight=10/);
  assert.match(linux, /KillMode=control-group/);
  assert.equal(linuxUnitName, "uci-arena-evidence.service");
});

test("startup teardown waits for the exact process with a bounded deadline", async () => {
  let aliveChecks = 0;
  assert.equal(await waitForProcessExit(42, {
    timeoutMs: 100,
    pollMs: 1,
    alive: () => ++aliveChecks < 3,
  }), true);
  assert.ok(aliveChecks >= 3);

  const started = Date.now();
  assert.equal(await waitForProcessExit(42, {
    timeoutMs: 20,
    pollMs: 1,
    alive: () => true,
  }), false);
  assert.ok(Date.now() - started >= 15);
  assert.ok(Date.now() - started < 250);

  const owner = {
    schema: "uci_arena_process_instance_identity_v1",
    platform: "win32",
    pid: 42,
    start_token: "100",
    executable_path: "C:\\provider\\node.exe",
    boot_id: "",
  };
  const reused = { ...owner, start_token: "200" };
  assert.equal(await waitForProcessExit(42, {
    timeoutMs: 20,
    pollMs: 1,
    identity: owner,
    probe: () => ({ state: "present", identity: reused }),
  }), true);
  assert.equal(await waitForProcessExit(42, {
    timeoutMs: 20,
    pollMs: 1,
    identity: owner,
    probe: () => ({ state: "present", identity: owner }),
  }), false);
});

test("startup teardown never treats unverifiable process identity as exit", async () => {
  const identity = {
    schema: "uci_arena_process_instance_identity_v1", platform: "win32", pid: 42,
    start_token: "100", executable_path: "C:\\provider\\node.exe", boot_id: "",
  };
  for (const observed of [
    { state: "unverifiable" },
    { state: "present", identity: null },
    { state: "present", identity: { ...identity, start_token: "malformed" } },
    { state: "unknown" },
  ]) {
    assert.equal(await waitForProcessExit(42, {
      identity, timeoutMs: 20, probe: () => observed,
    }), false);
  }
  assert.equal(await waitForProcessExit(42, {
    identity, timeoutMs: 20, probe: () => ({ state: "absent" }),
  }), true);
});

test("exact identity probes reject zero or expanded lifecycle query budgets", () => {
  for (const timeoutMs of [0, -1, 2_001]) {
    assert.equal(probeProcessInstance(process.pid, { timeoutMs }).state, "unverifiable");
  }
});

test("Windows exact identity subprocess consumes the supplied remaining budget", (t) => {
  if (process.platform !== "win32") return t.skip("Windows subprocess deadline");
  assert.equal(probeProcessInstance(process.pid, { timeoutMs: 1 }).state, "unverifiable");
});

test("startup teardown budgets its synchronous identity probe and never probes after deadline", async () => {
  const identity = {
    schema: "uci_arena_process_instance_identity_v1", platform: "win32", pid: 42,
    start_token: "100", executable_path: "C:\\provider\\node.exe", boot_id: "",
  };
  let monotonic = 10;
  const budgets = [];
  const exited = await waitForProcessExit(42, {
    identity, timeoutMs: 3_000, now: () => monotonic,
    probe: (_pid, options) => {
      budgets.push(options?.timeoutMs);
      monotonic += 2_000;
      return { state: "present", identity };
    },
  });
  assert.equal(exited, false);
  assert.deepEqual(budgets, [2_000]);
});

test("startup teardown shrinks probe budgets and rejects exit evidence observed after its bound", async () => {
  const identity = {
    schema: "uci_arena_process_instance_identity_v1", platform: "win32", pid: 42,
    start_token: "100", executable_path: "C:\\provider\\node.exe", boot_id: "",
  };
  let monotonic = 0;
  const budgets = [];
  assert.equal(await waitForProcessExit(42, {
    identity, timeoutMs: 2_000, pollMs: 1, now: () => monotonic,
    probe: (_pid, options) => {
      budgets.push(options?.timeoutMs);
      monotonic += budgets.length === 1 ? 1_500 : 500;
      return { state: "present", identity };
    },
  }), false);
  assert.deepEqual(budgets, [2_000, 500]);
  monotonic = 0;
  assert.equal(await waitForProcessExit(42, {
    identity, timeoutMs: 2_000, now: () => monotonic,
    probe: () => { monotonic = 2_001; return { state: "absent" }; },
  }), false);
});

test("startup recovery starts only an existing current registration", async () => {
  const calls = [];
  let statusCalls = 0;
  const recovered = await recoverStartup({ workspace: "fixture" }, {
    platform: "win32",
    statusImpl: async () => ({
      installed: true,
      enabled: true,
      active: statusCalls++ > 0,
      matchesCurrentConfiguration: true,
    }),
    executeImpl: async (executable, argumentsList) => calls.push({ executable, argumentsList }),
    waitForActiveImpl: async () => true,
  });
  assert.deepEqual(calls, [{
    executable: "schtasks.exe",
    argumentsList: ["/Run", "/TN", "UCI Arena Evidence Service"],
  }]);
  assert.equal(recovered.recoveryRequested, true);
  assert.equal(recovered.registrationMutated, false);
  await assert.rejects(recoverStartup({}, {
    platform: "win32",
    statusImpl: async () => ({ installed: true, matchesCurrentConfiguration: false }),
    executeImpl: async () => calls.push("unexpected"),
  }), /does not match/);
  assert.equal(calls.length, 1);
});

test("cross-platform child shutdown removes the owned process tree within two seconds", async (t) => {
  const config = await workspace();
  closeWorkspaceAfter(t, config);
  const pids = path.join(config.workspace, "pids.json");
  const fixture = path.join(
    packageRoot,
    "fixtures",
    "process_tree.mjs",
  );
  const child = spawn(process.execPath, [fixture, "parent", pids], {
    stdio: ["pipe", "ignore", "ignore"],
    windowsHide: true,
    detached: process.platform !== "win32",
  });
  t.after(() => {
    try {
      process.kill(child.pid, "SIGKILL");
    } catch {}
  });
  const deadline = Date.now() + 2_000;
  while (!existsSync(pids) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(existsSync(pids));
  const identities = JSON.parse(readFileSync(pids, "utf8"));
  const result = await shutdownChildProcessTree(child, {
    label: "test process tree",
    gracefulTimeoutMs: 100,
    forceTimeoutMs: 500,
    ultimateTimeoutMs: 2_000,
  });
  assert.equal(result.verified, true);
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const reapingDeadline = Date.now() + 1_000;
  while (
    (alive(identities.parent) || alive(identities.child))
    && Date.now() < reapingDeadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(alive(identities.parent), false);
  assert.equal(alive(identities.child), false);
});
