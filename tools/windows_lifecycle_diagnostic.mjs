#!/usr/bin/env node
// Diagnostic branch only: preserve production deadlines and log primitive errors.
import { execFileSync, execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { promisify } from "node:util";
import { performance } from "node:perf_hooks";
import path from "node:path";
import {
  probeProcessInstance, validProcessIdentity, sameProcessInstance,
} from "../src/process_identity.mjs";

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
const jsonOutput = '[Console]::Out.Write(($payload | ConvertTo-Json -Compress -Depth 3))';
if (!exact.includes(jsonOutput)) throw new Error("production serialization primitive changed");
// Preserve the exact same identity collection; change only the serialization.
const consoleFields = exact.replace(jsonOutput, String.raw`
[Console]::Out.Write([string]::Join([string][char]10, [string[]]@(
  $payload.state
  $payload.identity.schema
  $payload.identity.platform
  $payload.identity.pid.ToString([System.Globalization.CultureInfo]::InvariantCulture)
  $payload.identity.start_token
  [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($payload.identity.executable_path))
  $payload.identity.boot_id
)))`);
const serialization = process.argv[2] ?? "convert_to_json";
if (!["convert_to_json", "console_fields"].includes(serialization)) {
  throw new Error("unknown diagnostic serialization arm");
}
const selected = serialization === "console_fields" ? consoleFields : exact;
function decodedIdentity(stdout, arm) {
  if (arm === "convert_to_json") {
    const result = JSON.parse(stdout);
    return result.state === "present" && validProcessIdentity(result.identity, process.pid)
      ? result.identity : null;
  }
  const fields = stdout.split("\n");
  if (fields.length !== 7 || fields[0] !== "present"
      || !/^[1-9][0-9]{0,9}$/u.test(fields[3])
      || !/^[A-Za-z0-9+/]*={0,2}$/u.test(fields[5])) return null;
  const encoded = Buffer.from(fields[5], "base64");
  if (encoded.toString("base64") !== fields[5]) return null;
  const executablePath = encoded.toString("utf8");
  if (!Buffer.from(executablePath, "utf8").equals(encoded)) return null;
  const identity = {
    schema: fields[1], platform: fields[2], pid: Number(fields[3]),
    start_token: fields[4], executable_path: executablePath, boot_id: fields[6],
  };
  return validProcessIdentity(identity, process.pid) ? identity : null;
}
const scripts = [
  ["exact_identity_first", selected],
  ["powershell_startup", '[Console]::Out.Write("ready")'],
  ["start_time", '$ErrorActionPreference="Stop"; $p=[System.Diagnostics.Process]::GetProcessById([int]$env:UCI_ARENA_PROCESS_PROBE_PID); [Console]::Out.Write($p.StartTime.ToUniversalTime().Ticks)'],
  ["main_module", '$ErrorActionPreference="Stop"; $p=[System.Diagnostics.Process]::GetProcessById([int]$env:UCI_ARENA_PROCESS_PROBE_PID); [Console]::Out.Write($p.MainModule.FileName)'],
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
      outcome = { ok: true, stdout: stdout.slice(0, 512),
        ...(kind === "exact_identity_first"
          ? { identity_valid: Boolean(decodedIdentity(stdout, serialization)) } : {}) };
    } catch (error) {
      outcome = { ok: false, ...primitiveError(error) };
    }
    emit({ kind, serialization, round, elapsed_ms: elapsed(before), ...outcome });
  }
}
const observed = {};
for (const [arm, script] of [["convert_to_json", exact], ["console_fields", consoleFields]]) {
  const before = performance.now();
  try {
    const stdout = execFileSync("powershell.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script,
    ], {
      encoding: "utf8", windowsHide: true, timeout: 2_000, maxBuffer: 16_384,
      env: { ...process.env, UCI_ARENA_PROCESS_PROBE_PID: String(process.pid) },
    });
    observed[arm] = decodedIdentity(stdout, arm);
    emit({ kind: "serialization_equivalence", arm, elapsed_ms: elapsed(before),
      ok: Boolean(observed[arm]) });
  } catch (error) {
    emit({ kind: "serialization_equivalence", arm, elapsed_ms: elapsed(before),
      ok: false, ...primitiveError(error) });
  }
}
emit({ kind: "serialization_identity_comparison",
  equivalent: sameProcessInstance(observed.convert_to_json, observed.console_fields),
  fields_equal: Boolean(observed.convert_to_json && observed.console_fields)
    && JSON.stringify(Object.keys(observed.convert_to_json).sort())
      === JSON.stringify(Object.keys(observed.console_fields).sort())
    && Object.keys(observed.convert_to_json).every((field) =>
      observed.convert_to_json[field] === observed.console_fields[field]) });
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
