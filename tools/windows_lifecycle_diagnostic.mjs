#!/usr/bin/env node
// Diagnostic branch only: preserve production deadlines and log primitive errors.
import { execFileSync, execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { promisify } from "node:util";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { probeProcessInstance } from "../src/process_identity.mjs";

const execute = promisify(execFile);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const elapsed = (before) => Number((performance.now() - before).toFixed(2));
const emit = (value) => console.log(JSON.stringify(value));
const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
function primitiveError(error) {
  return {
    code: error.code ?? null,
    killed: error.killed ?? false,
    signal: error.signal ?? null,
    status: error.status ?? null,
    stdout: String(error.stdout ?? "").slice(0, 512),
    stderr: String(error.stderr ?? "").slice(0, 512),
  };
}

const source = readFileSync("src/process_identity.mjs", "utf8");
const exact = source.match(/const WINDOWS_PROBE = String.raw`([\s\S]*?)`;/u)?.[1];
if (!exact) throw new Error("exact production Windows identity primitive unavailable");
if (process.platform !== "win32") throw new Error("Windows-only lifecycle diagnostic");
const primitives = new Map([
  ["exact_identity", exact],
  ["powershell_startup", '[Console]::Out.Write("ready")'],
  ["start_time", '$ErrorActionPreference="Stop"; $p=[System.Diagnostics.Process]::GetProcessById([int]$env:UCI_ARENA_PROCESS_PROBE_PID); [Console]::Out.Write($p.StartTime.ToUniversalTime().Ticks)'],
  ["main_module", '$ErrorActionPreference="Stop"; $p=[System.Diagnostics.Process]::GetProcessById([int]$env:UCI_ARENA_PROCESS_PROBE_PID); [Console]::Out.Write($p.MainModule.FileName)'],
]);
const firstPrimitive = process.argv[2] ?? "exact_identity";
if (!primitives.has(firstPrimitive)) throw new Error("unknown first diagnostic primitive");
const scripts = [
  [firstPrimitive, primitives.get(firstPrimitive)],
  ...[...primitives].filter(([kind]) => kind !== firstPrimitive),
];
for (let round = 0; round < 3; ++round) {
  for (const [kind, script] of scripts) {
    const before = performance.now();
    let outcome;
    try {
      const stdout = execFileSync("powershell.exe", [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script,
      ], {
        encoding: "utf8", windowsHide: true, timeout: 2_000, maxBuffer: 16_384,
        env: { ...process.env, UCI_ARENA_PROCESS_PROBE_PID: String(process.pid) },
      });
      outcome = { ok: true, stdout: stdout.slice(0, 512) };
    } catch (error) {
      outcome = { ok: false, ...primitiveError(error) };
    }
    emit({ kind, first_primitive: firstPrimitive, cold_first: round === 0
      && kind === firstPrimitive, round, elapsed_ms: elapsed(before), ...outcome });
  }
}
const before = performance.now();
emit({ kind: "production_probe", result: probeProcessInstance(process.pid),
  elapsed_ms: elapsed(before) });

// These PIDs come only from this spawned fixture and its private result file.
// Cleanup has its own budget: it never turns a failed 500ms probe into a pass.
async function disposeOwnedFixture(child, identities) {
  const owned = [...new Set([child.pid, identities?.parent, identities?.child]
    .filter((pid) => Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid))];
  const errors = [];
  for (const pid of owned) {
    if (!alive(pid)) continue;
    try {
      await execute("taskkill", ["/PID", String(pid), "/T", "/F"], {
        encoding: "utf8", timeout: 5_000, windowsHide: true, maxBuffer: 262_144,
      });
    } catch (error) {
      if (alive(pid)) errors.push({ pid, ...primitiveError(error) });
    }
  }
  child.stdin?.destroy();
  const deadline = performance.now() + 1_000;
  while (owned.some(alive) && performance.now() < deadline) await delay(25);
  const remaining = owned.filter(alive);
  emit({ kind: "owned_fixture_cleanup", verified: remaining.length === 0,
    remaining_owned_pids: remaining, errors });
  if (remaining.length > 0) throw new Error("owned diagnostic fixture cleanup failed");
}

mkdirSync("build/diagnostic-owned-fixtures", { recursive: true });
for (let round = 0; round < 6; ++round) {
  const filename = path.resolve(`build/diagnostic-owned-fixtures/${randomUUID()}.json`);
  const child = spawn(process.execPath, ["fixtures/process_tree.mjs", "parent", filename], {
    stdio: ["pipe", "ignore", "ignore"], windowsHide: true,
  });
  let spawnError = null;
  child.on("error", (error) => { spawnError = primitiveError(error); });
  let identities = null;
  try {
    const readyBy = performance.now() + 2_000;
    while (!identities && !spawnError && performance.now() < readyBy) {
      if (existsSync(filename)) {
        try {
          const result = JSON.parse(readFileSync(filename, "utf8"));
          if ([result.parent, result.child].every((pid) => Number.isSafeInteger(pid)
              && pid > 0 && pid !== process.pid) && result.parent === child.pid
              && result.parent !== result.child) {
            identities = result;
          }
        } catch { /* Retry a readiness write still in progress. */ }
      }
      if (!identities) await delay(20);
    }
    if (!identities) {
      emit({ kind: "owned_taskkill_tree", round, ok: false,
        reason: "fixture_readiness_failed", spawn_error: spawnError,
        owned_parent_pid: child.pid, exit_code: child.exitCode, signal_code: child.signalCode });
      process.exitCode = 1;
      continue;
    }
    const before = performance.now();
    let outcome;
    try {
      const result = await execute("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        encoding: "utf8", timeout: 500, windowsHide: true, maxBuffer: 262_144,
      });
      outcome = { ok: true, stdout: result.stdout.slice(0, 512),
        stderr: result.stderr.slice(0, 512) };
    } catch (error) {
      outcome = { ok: false, ...primitiveError(error) };
    }
    emit({ kind: "owned_taskkill_tree", round, elapsed_ms: elapsed(before), ...outcome,
      alive_after: { parent: alive(identities.parent), child: alive(identities.child) } });
  } finally {
    await disposeOwnedFixture(child, identities);
  }
}
