import { spawn } from "node:child_process";
import { NativeResourceHelper } from "@uci-arena/background-service-runtime/native-resource-helper";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { open, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  acquireResourceLease,
} from "@uci-arena/background-service-runtime/lease";
import {
  acquireGpuResourceIsolation,
  shutdownChildProcessTree,
} from "@uci-arena/background-service-runtime/resource-isolation";
import { validateStoredProfile } from "@uci-arena/time-profile-contract";
import {
  adapterCommand,
  harvestAdapter,
  profileCandidate,
} from "./adapters.mjs";
import { resolveJobTarget } from "./identity.mjs";
import { ResourceGovernor } from "./resource_governor.mjs";
import {
  timingProfileCanPublish,
  timingProfilePermissions,
} from "./time_profile_policy.mjs";
import {
  configureProcessIdentityProbe,
  currentProcessIdentity,
  probeProcessInstance,
  sameProcessInstance,
  validProcessIdentity,
} from "./process_identity.mjs";

import { daemonOwnerFromRecord, readDaemonRecord } from "./daemon_owner_record.mjs";
const DAEMON_LOCK_SETTLE_MS = 10_000;

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function nowIso() {
  return new Date().toISOString();
}

async function legacyHeartbeatIsFresh(config, lock, now) {
  const heartbeat = await readDaemonRecord(config.daemonHeartbeatFile);
  const heartbeatAt = Date.parse(String(heartbeat?.value?.heartbeat_at ?? ""));
  return heartbeat?.value?.pid === lock?.pid
    && Number.isFinite(heartbeatAt)
    && now - heartbeatAt <= config.daemon.staleMs;
}

async function retireLock(filename, expected) {
  if (typeof expected?.raw !== "string") return false;
  const current = await readDaemonRecord(filename);
  if (typeof current?.raw !== "string" || current.raw !== expected.raw) return false;
  const retired = `${filename}.retired-${process.pid}-${randomUUID()}`;
  try {
    await rename(filename, retired);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  await rm(retired, { force: true });
  return true;
}

export async function acquireDaemonLock(config, {
  identity = currentProcessIdentity(),
  probe = probeProcessInstance,
  now = Date.now,
} = {}) {
  if (!validProcessIdentity(identity, process.pid)) {
    throw new Error("Arena Evidence daemon process identity is invalid");
  }
  const filename = path.join(config.paths.locks, "daemon.lock");
  const nonce = randomUUID();
  let handle;
  for (let attempt = 0; attempt < 3; ++attempt) {
    try {
      handle = await open(filename, "wx", 0o600);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const packet = await readDaemonRecord(filename);
      if (!packet) continue;
      const age = Math.max(0, now() - packet.modifiedMs);
      const owner = daemonOwnerFromRecord(packet);
      const lock = packet.value;
      const recordedIdentity = owner.identity;
      let reclaimable = false;
      if (recordedIdentity || age >= DAEMON_LOCK_SETTLE_MS) {
        const observed = probe(owner.pid);
        const absent = observed?.state === "absent";
        const observedIdentity = observed?.state === "present"
          && validProcessIdentity(observed.identity, owner.pid) ? observed.identity : null;
        if (!absent && !observedIdentity) {
          throw new Error(`another Arena Evidence daemon has unverifiable ownership of ${filename}`);
        }
        reclaimable = absent || (recordedIdentity
          ? !sameProcessInstance(recordedIdentity, observedIdentity)
          : age >= config.daemon.staleMs && !await legacyHeartbeatIsFresh(config, lock, now()));
      }
      if (!reclaimable || age < DAEMON_LOCK_SETTLE_MS || attempt > 1) {
        throw new Error(`another Arena Evidence daemon owns ${filename}`);
      }
      if (!await retireLock(filename, packet)) continue;
    }
  }
  if (!handle) throw new Error(`could not acquire daemon lock ${filename}`);
  const value = {
    schema: "uci_arena_evidence_daemon_lock_v2",
    pid: process.pid,
    nonce,
    started_at: new Date(now()).toISOString(),
    processIdentity: identity,
  };
  const raw = `${JSON.stringify(value)}\n`;
  await handle.writeFile(raw);
  await handle.sync();
  return {
    nonce,
    processIdentity: identity,
    release: async () => {
      await handle.close();
      await retireLock(filename, { raw });
    },
  };
}

async function writeJsonAtomic(filename, value) {
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", flag: "wx" });
  try {
    renameSync(temporary, filename);
  } finally {
    await rm(temporary, { force: true });
  }
}

function commandExit(child) {
  return new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolvePromise({ code, signal }));
  });
}

async function startIdleAdmission(governor, target, config) {
  let permit = null;
  for (let sample = 0; sample < config.resources.consecutiveIdleSamples; ++sample) {
    if (sample > 0) await delay(config.resources.pollMs);
    permit = await governor.permit({
      provider: target.provider,
      enginePath: target.enginePath,
    });
    if (!permit.allowed && !String(permit.reason).startsWith("idle sample ")) return permit;
  }
  return permit;
}

function finalizedDiagnosticResource(reason) {
  return {
    schema: "uci_arena_gpu_resource_isolation_v1",
    interval_status: "finalized",
    interval_id: randomUUID(),
    qualification_scope: "correctness_and_deadline_only",
    performance_authority: false,
    strength_authority: false,
    default_tuning_authority: false,
    problems: [reason],
  };
}

function writeJsonAtomicSync(filename, value) {
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, filename);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try { if (existsSync(temporary)) unlinkSync(temporary); } catch {}
  }
}

function exactTargetStillMatches(job, catalog, config, target) {
  const resolved = resolveJobTarget(job, catalog, config);
  if (!resolved.target) return { matches: false, reason: resolved.reason };
  const fields = [
    ["engine SHA-256", resolved.target.engineSha256, target.engineSha256],
    ["model fingerprint", resolved.target.modelFingerprint, target.modelFingerprint],
    ["provider", resolved.target.provider, target.provider],
    [
      "hardware/driver fingerprint",
      resolved.target.hardwareDriverFingerprint,
      target.hardwareDriverFingerprint,
    ],
    [
      "UCI options",
      JSON.stringify(resolved.target.uciOptions ?? {}),
      JSON.stringify(target.uciOptions ?? {}),
    ],
  ];
  const changed = fields.find(([, current, initial]) => String(current) !== String(initial));
  return changed
    ? { matches: false, reason: `target ${changed[0]} drifted during the shard` }
    : { matches: true, target: resolved.target, reason: "" };
}

function compactReport(report) {
  const resource = report?.resource;
  return {
    state: report?.state ?? "unknown",
    jobId: report?.jobId ?? null,
    reason: String(report?.reason ?? "").slice(0, 2_048),
    observations: Number(report?.observations ?? 0),
    authority: report?.authority ?? null,
    publication: report?.publication
      ? { path: report.publication.path, priorSha256: report.publication.prior?.sha256 ?? null }
      : null,
    resource: resource ? {
      schema: resource.schema,
      intervalId: resource.interval_id ?? null,
      intervalStatus: resource.interval_status ?? null,
      performanceAuthority: Boolean(resource.performance_authority),
      strengthAuthority: Boolean(resource.strength_authority),
      defaultTuningAuthority: Boolean(resource.default_tuning_authority),
      problems: (resource.problems ?? []).slice(0, 32).map(
        (problem) => String(problem).slice(0, 512),
      ),
    } : null,
  };
}

export async function publishQualifiedProfile({
  candidate,
  target,
  job,
  config,
  resource,
}) {
  const validated = validateStoredProfile(candidate);
  const permissions = timingProfilePermissions(validated);
  if (!timingProfileCanPublish(validated)
      || resource?.default_tuning_authority !== true) {
    throw new Error("timing profile candidate lacks publication authority");
  }
  if (String(validated.identity?.model?.model_id ?? "") !== String(target.modelId)
      || String(validated.identity?.model?.model_fingerprint ?? "")
        !== String(target.modelFingerprint)) {
    throw new Error("timing profile candidate identity does not match target");
  }
  const liveDirectory = path.join(config.runtimeModelsRoot, target.modelId, "cache");
  const livePath = path.join(liveDirectory, "uci_time_profile_v3.json");
  const archiveDirectory = path.join(config.paths.profiles, target.modelId);
  mkdirSync(liveDirectory, { recursive: true });
  mkdirSync(archiveDirectory, { recursive: true });
  let prior = null;
  if (existsSync(livePath)) {
    const bytes = readFileSync(livePath);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const archive = path.join(archiveDirectory, `${nowIso().replaceAll(":", "-")}.${digest}.json`);
    copyFileSync(livePath, archive);
    prior = { sha256: digest, path: archive };
  }
  const published = {
    ...validated,
    permissions,
    service_publication: {
      schema: "uci_arena_evidence_profile_publication_v1",
      job_id: job.id,
      dataset_id: job.datasetId,
      resource_interval_id: resource.interval_id,
      published_at: nowIso(),
      previous_profile: prior,
    },
  };
  writeJsonAtomicSync(livePath, published);
  return { path: livePath, prior };
}

async function executeJob({
  catalog,
  config,
  governor,
  job,
  target,
  lease,
  spawnImpl = spawn,
  guardFactory = acquireGpuResourceIsolation,
  shutdownImpl = shutdownChildProcessTree,
}) {
  const attemptDirectory = path.join(
    config.paths.attempts,
    job.id,
    `${String(job.attempts + 1).padStart(4, "0")}-${randomUUID()}`,
  );
  mkdirSync(attemptDirectory, { recursive: true });
  const stdoutPath = path.join(attemptDirectory, "stdout.log");
  const stderrPath = path.join(attemptDirectory, "stderr.log");
  const command = adapterCommand(job, target, config, attemptDirectory);
  const attemptId = catalog.startAttempt(job.id, { stdout: stdoutPath, stderr: stderrPath });
  let guard = null;
  let child = null;
  let preemptReason = "";
  let exit = { code: null, signal: null };
  const stdout = openSync(stdoutPath, "a");
  const stderr = openSync(stderrPath, "a");
  try {
    if (!command.selfGuarded) {
      guard = await guardFactory({
        attestationPath: config.gpuIsolationAttestation,
        restaurantRoots: config.restaurantRoots,
        allowSharedDiagnostic: true,
      });
      if (!guard.snapshot().can_run) {
        const report = await guard.finish();
        catalog.finishAttempt(attemptId, {
          state: "waiting_for_resources",
          reason: report.problems?.join(",") || "GPU resource isolation unavailable",
          resource: report,
        });
        catalog.transitionJob(job.id, "waiting_for_resources", {
          waitReason: report.problems?.join(",") || "GPU resource isolation unavailable",
        });
        return { state: "waiting_for_resources", resource: report };
      }
    }
    child = spawnImpl(command.executable, command.args, {
      cwd: command.workingDirectory ?? config.runtimeRoot,
      env: lease.environment(command.environment),
      stdio: ["pipe", stdout, stderr],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    try {
      os.setPriority(child.pid, os.constants.priority.PRIORITY_LOW);
    } catch {}
    guard?.registerAllowedProcess(child.pid, `${job.adapter} runner`);
    const childExit = commandExit(child);
    while (child.exitCode === null && child.signalCode === null) {
      await Promise.race([childExit, delay(config.resources.pollMs)]);
      if (child.exitCode !== null || child.signalCode !== null) break;
      lease.heartbeat();
      const leaseReason = lease.revocationReason();
      const permit = await governor.permit({
        provider: target.provider,
        enginePath: target.enginePath,
        ownedEngineRunning: true,
        duringRun: true,
      });
      if (leaseReason || !permit.allowed) {
        preemptReason = leaseReason || permit.reason || "resource permission revoked";
        await shutdownImpl(child, {
          label: `${job.adapter} runner`,
          gracefulTimeoutMs: 250,
          forceTimeoutMs: 750,
          ultimateTimeoutMs: config.resources.revokeWithinMs,
        });
        break;
      }
    }
    exit = await childExit;
    guard?.unregisterAllowedProcess(child.pid);
    const resource = command.selfGuarded
      ? finalizedDiagnosticResource("adapter_owns_nested_resource_report")
      : await guard.finish();
    const currentTarget = exactTargetStillMatches(job, catalog, config, target);
    const effectiveResource = exit.code === 0 && currentTarget.matches
      ? resource
      : finalizedDiagnosticResource(
          !currentTarget.matches
            ? `identity_drift:${currentTarget.reason}`
            : `adapter_nonzero_exit:${exit.code ?? exit.signal ?? "unknown"}`,
        );
    let harvested = null;
    try {
      harvested = harvestAdapter(job, target, command, config, catalog, effectiveResource);
    } catch (error) {
      if (!preemptReason) throw error;
    }
    if (preemptReason) {
      catalog.finishAttempt(attemptId, {
        state: "interrupted",
        exitCode: exit.code,
        reason: preemptReason,
        resource,
      });
      catalog.transitionJob(job.id, "queued", { waitReason: `preempted:${preemptReason}` });
      return { state: "preempted", reason: preemptReason, resource };
    }
    if (!currentTarget.matches) {
      catalog.finishAttempt(attemptId, {
        state: "interrupted",
        exitCode: exit.code,
        reason: currentTarget.reason,
        resource: effectiveResource,
      });
      catalog.transitionJob(job.id, "waiting_for_target", {
        waitReason: currentTarget.reason,
      });
      return {
        state: "waiting_for_target",
        reason: currentTarget.reason,
        resource: effectiveResource,
        observations: harvested?.envelopes?.length ?? 0,
      };
    }
    if (exit.code !== 0) {
      const producerFailure = harvested?.producerFailures?.[0];
      const reason = producerFailure
        ? `adapter ${job.adapter} reported failure: ${producerFailure}`
        : `adapter exited with ${exit.code ?? exit.signal ?? "unknown"}`;
      catalog.finishAttempt(attemptId, {
        state: "failed",
        exitCode: exit.code,
        reason,
        resource: effectiveResource,
      });
      catalog.transitionJob(job.id, "failed", { error: reason });
      return {
        state: "failed",
        reason,
        resource: effectiveResource,
        observations: harvested?.envelopes?.length ?? 0,
      };
    }
    let publication = null;
    const candidate = profileCandidate(harvested.records);
    const canPublish = harvested.envelopes.some(
      (envelope) => envelope.authority.profile_publication === true,
    );
    if (candidate && canPublish) {
      publication = await publishQualifiedProfile({
        candidate,
        target,
        job,
        config,
        resource,
      });
    }
    const authority = harvested.envelopes.reduce((summary, envelope) => ({
      diagnostic: true,
      timing: summary.timing || envelope.authority.timing,
      strength: summary.strength || envelope.authority.strength,
      profile_publication: summary.profile_publication
        || envelope.authority.profile_publication,
    }), {
      diagnostic: true,
      timing: false,
      strength: false,
      profile_publication: false,
    });
    catalog.completeDataset(job.datasetId, authority);
    catalog.finishAttempt(attemptId, {
      state: "completed",
      exitCode: exit.code,
      resource,
    });
    catalog.transitionJob(job.id, "completed");
    return {
      state: "completed",
      observations: harvested.envelopes.length,
      authority,
      publication,
      resource,
    };
  } catch (error) {
    let resource = finalizedDiagnosticResource(`job_exception:${error.message}`);
    if (child && child.exitCode === null && child.signalCode === null) {
      try {
        await shutdownImpl(child, {
          label: `${job.adapter} runner`,
          gracefulTimeoutMs: 250,
          forceTimeoutMs: 750,
          ultimateTimeoutMs: config.resources.revokeWithinMs,
        });
      } catch {}
    }
    if (guard) {
      try {
        resource = await guard.finish();
      } catch {}
    }
    catalog.finishAttempt(attemptId, {
      state: "failed",
      exitCode: exit.code,
      reason: error.message,
      resource,
    });
    catalog.transitionJob(job.id, "failed", { error: error.message });
    return { state: "failed", reason: error.message, resource };
  } finally {
    closeSync(stdout);
    closeSync(stderr);
  }
}

export async function runCycle(catalog, config, {
  governor = new ResourceGovernor(config, catalog),
  leaseFactory = acquireResourceLease,
  spawnImpl = spawn,
  guardFactory = acquireGpuResourceIsolation,
  shutdownImpl = shutdownChildProcessTree,
} = {}) {
  const candidates = catalog.runnableJobs();
  if (candidates.length === 0) return { state: "idle", reason: "job queue is empty" };
  let job = null;
  let resolved = null;
  const targetFailures = [];
  for (const candidate of candidates) {
    const candidateTarget = resolveJobTarget(candidate, catalog, config);
    if (candidateTarget.target) {
      job = candidate;
      resolved = candidateTarget;
      break;
    }
    catalog.transitionJob(candidate.id, "waiting_for_target", {
      waitReason: candidateTarget.reason,
    });
    targetFailures.push({ jobId: candidate.id, reason: candidateTarget.reason });
  }
  if (!job || !resolved?.target) {
    return {
      state: "waiting_for_target",
      jobId: targetFailures[0]?.jobId ?? null,
      reason: targetFailures[0]?.reason ?? "no job has a resolvable target",
      waitingJobs: targetFailures.length,
    };
  }
  const permit = await startIdleAdmission(governor, resolved.target, config);
  if (!permit?.allowed) {
    catalog.transitionJob(job.id, "waiting_for_resources", { waitReason: permit?.reason ?? "idle admission failed" });
    return {
      state: "waiting_for_resources",
      jobId: job.id,
      reason: permit?.reason ?? "idle admission failed",
      resource: permit,
    };
  }
  const lease = await leaseFactory({
    producer: "uci_arena_evidence_service",
    priority: "background",
    timeoutMs: 250,
  });
  if (!lease) {
    catalog.transitionJob(job.id, "waiting_for_resources", {
      waitReason: "shared heavy background lease is busy",
    });
    return {
      state: "waiting_for_resources",
      jobId: job.id,
      reason: "shared heavy background lease is busy",
    };
  }
  try {
    return await executeJob({
      catalog,
      config,
      governor,
      job,
      target: resolved.target,
      lease,
      spawnImpl,
      guardFactory,
      shutdownImpl,
    });
  } finally {
    lease.release();
  }
}

export async function runDaemon(catalog, config, {
  once = false,
  dependencies = {},
} = {}) {
  await configureProcessIdentityProbe(dependencies.processIdentityHelper ?? new NativeResourceHelper(config));
  const daemonLock = await acquireDaemonLock(config);
  catalog.recoverInterruptedJobs();
  const governor = dependencies.governor ?? new ResourceGovernor(config, catalog);
  const startedAt = nowIso();
  const heartbeat = async () => {
    const heartbeatAt = nowIso();
    catalog.updateDaemonState({
      pid: process.pid,
      processIdentity: daemonLock.processIdentity,
      startedAt,
      heartbeatAt,
    });
    await writeJsonAtomic(
      config.daemonHeartbeatFile,
      {
        pid: process.pid,
        nonce: daemonLock.nonce,
        process_identity: daemonLock.processIdentity,
        heartbeat_at: heartbeatAt,
      },
    );
  };
  await heartbeat();
  const heartbeatTimer = setInterval(
    () => heartbeat().catch(() => {}),
    config.daemon.heartbeatMs,
  );
  try {
    let report = null;
    do {
      catalog.updateDaemonState({
        phase: "sampling",
        currentJobId: catalog.nextJob()?.id ?? null,
        cycleStartedAt: nowIso(),
        lastError: "",
      });
      report = await runCycle(catalog, config, { ...dependencies, governor });
      catalog.updateDaemonState({
        phase: once ? "stopped" : "sleep",
        currentJobId: null,
        resourceMode: governor.last.mode,
        cycleCompletedAt: nowIso(),
        lastReport: compactReport(report),
      });
      if (!once) await delay(config.daemon.cycleMs);
    } while (!once);
    return report;
  } catch (error) {
    catalog.updateDaemonState({
      phase: "failed",
      heartbeatAt: nowIso(),
      lastError: error.message,
    });
    throw error;
  } finally {
    clearInterval(heartbeatTimer);
    governor.close();
    await daemonLock.release();
  }
}
