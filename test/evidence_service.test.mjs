import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
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
} from "../../../arena/lib/background_resource_lease.mjs";
import { shutdownChildProcessTree } from "../../../arena/lib/gpu_resource_isolation.mjs";
import { canonicalJson } from "../../../engine/tools/qualify_uci_time_profile.mjs";
import { adapterCommand, harvestAdapter } from "../src/adapters.mjs";
import { Catalog } from "../src/catalog.mjs";
import { enqueueFirstCampaign, jobFingerprint } from "../src/campaign.mjs";
import { loadConfig, repositoryRoot } from "../src/config.mjs";
import {
  resolveActiveTarget,
  resolveJobTarget,
  sha256File,
} from "../src/identity.mjs";
import { publishQualifiedProfile, runDaemon } from "../src/daemon.mjs";
import {
  buildLinuxUserUnit,
  buildWindowsTaskXml,
  linuxUnitName,
} from "../src/platform_startup.mjs";
import { listQualifiedProfiles } from "../src/profiles.mjs";
import { ResourceGovernor } from "../src/resource_governor.mjs";

async function workspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), "arena-evidence-test-"));
  const config = await loadConfig({ workspace: root });
  config.resources.consecutiveIdleSamples = 1;
  config.resources.minimumFreeWorkspaceGb = 1;
  return config;
}

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
});

test("first campaign is deterministic and staged after core controls", async (t) => {
  const config = await workspace();
  const catalog = new Catalog(config);
  closeWorkspaceAfter(t, config, catalog);
  const jobs = enqueueFirstCampaign(catalog);
  assert.equal(jobs.length, 46);
  assert.equal(jobs[0].adapter, "timing_profile");
  assert.equal(jobs[0].config.repetitions, 30);
  assert.ok(jobs.some((job) => job.shardId === "curve-40/120+5" && job.priority === 60));
  assert.ok(jobs.some((job) => job.shardId === "stockfish-180+3-depth14"));
  assert.equal(new Set(jobs.map((job) => job.fingerprint)).size, jobs.length);
  const repeated = enqueueFirstCampaign(catalog);
  assert.equal(repeated.length, 46);
  assert.equal(catalog.jobs().length, 46);
  assert.equal(catalog.datasets().length, 46);
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
      candidateOptions: ["TimePolicy=RelativeClockV3"],
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
    schema: "uci_arena_paired_sprt_v1",
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
  const runner = path.join(repositoryRoot, "arena", "run_sprt_match.mjs");
  const mock = path.join(
    repositoryRoot,
    "tools",
    "arena_evidence_service",
    "fixtures",
    "mock_uci_engine.mjs",
  );
  const mockReferee = path.join(
    repositoryRoot,
    "tools",
    "arena_evidence_service",
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
  const candidate = {
    schema: "uci_time_profile_v3",
    qualified: true,
    gates: { passed: true },
    permissions: {
      provider_safety_qualified: true,
      adaptive_play_qualified: false,
    },
    identity: {
      model: {
        model_id: target.modelId,
        model_fingerprint: target.modelFingerprint,
      },
    },
  };
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
});

test("profile list validates and projects explicit qualified imports", async (t) => {
  const config = await workspace();
  const catalog = new Catalog(config);
  closeWorkspaceAfter(t, config, catalog);
  const identity = {
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
      search_core: "v2",
      threads: 2,
      root_workers: 2,
      split_depth: 2,
      batch_size_effective: 64,
      batch_wait_us_effective: 0,
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
    permissions: {
      provider_safety_qualified: true,
      forecast_shadow_qualified: false,
      adaptive_play_qualified: false,
    },
    gates: { passed: true },
    calibration: {
      provider_service_reserve_us: 1000,
      iteration_forecast_scale_permille: 1000,
      iteration_transitions: {
        runtime_p95_ms: Array(48).fill(0),
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

test("platform startup definitions preserve low-priority cleanup contracts", async (t) => {
  const config = await workspace();
  closeWorkspaceAfter(t, config);
  const windows = buildWindowsTaskXml(config, "S-1-5-21-1");
  assert.match(windows, /MultipleInstancesPolicy>IgnoreNew/);
  assert.match(windows, /ExecutionTimeLimit>PT0S/);
  const linux = buildLinuxUserUnit(config);
  assert.match(linux, new RegExp(`Description=UCI Arena Evidence Service`));
  assert.match(linux, /Nice=15/);
  assert.match(linux, /CPUWeight=10/);
  assert.match(linux, /IOWeight=10/);
  assert.match(linux, /KillMode=control-group/);
  assert.equal(linuxUnitName, "uci-arena-evidence.service");
});

test("cross-platform child shutdown removes the owned process tree within two seconds", async (t) => {
  const config = await workspace();
  closeWorkspaceAfter(t, config);
  const pids = path.join(config.workspace, "pids.json");
  const fixture = path.join(repositoryRoot, "tools", "arena_evidence_service", "fixtures", "process_tree.mjs");
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
