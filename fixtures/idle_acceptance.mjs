import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { shutdownChildProcessTree } from "../../../arena/lib/gpu_resource_isolation.mjs";
import { repositoryRoot } from "../src/config.mjs";

const execFileAsync = promisify(execFile);
const cli = path.join(
  repositoryRoot,
  "tools",
  "arena_evidence_service",
  "src",
  "cli.mjs",
);

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function parseCpuTime(text) {
  const fields = String(text).trim().split(":").map(Number);
  if (fields.some((value) => !Number.isFinite(value))) return 0;
  return fields.reduce((seconds, value) => seconds * 60 + value, 0);
}

async function processSample(pid) {
  if (process.platform === "win32") {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$p=Get-Process -Id ${Number(pid)};`
          + "[Console]::Out.Write(($p.CPU.ToString([Globalization.CultureInfo]::InvariantCulture))"
          + "+','+$p.WorkingSet64)",
      ],
      { windowsHide: true, timeout: 5_000 },
    );
    const [cpuSeconds, rssBytes] = stdout.trim().split(",").map(Number);
    return { cpuSeconds, rssBytes };
  }
  const { stdout } = await execFileAsync(
    "ps",
    ["-p", String(pid), "-o", "time=,rss="],
    { timeout: 5_000 },
  );
  const match = stdout.trim().match(/^(\S+)\s+(\d+)$/);
  if (!match) throw new Error(`could not parse ps sample: ${stdout}`);
  return {
    cpuSeconds: parseCpuTime(match[1]),
    rssBytes: Number(match[2]) * 1024,
  };
}

const workspace = await mkdtemp(path.join(os.tmpdir(), "arena-evidence-idle-"));
const child = spawn(
  process.execPath,
  [cli, "daemon", "--workspace", workspace],
  {
    cwd: repositoryRoot,
    stdio: ["pipe", "ignore", "pipe"],
    windowsHide: true,
  },
);
let stderr = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => { stderr += chunk; });
try {
  await delay(2_000);
  const first = await processSample(child.pid);
  await delay(2_000);
  const second = await processSample(child.pid);
  const elapsedSeconds = 2;
  const cpuPercent = Math.max(
    0,
    (second.cpuSeconds - first.cpuSeconds) / elapsedSeconds / os.cpus().length * 100,
  );
  const rssMiB = Math.max(first.rssBytes, second.rssBytes) / 1024 ** 2;
  assert.ok(cpuPercent < 1, `idle CPU ${cpuPercent.toFixed(3)}% is not below 1%`);
  assert.ok(rssMiB <= 150, `idle RSS ${rssMiB.toFixed(2)} MiB exceeds 150 MiB`);
  process.stdout.write(`${JSON.stringify({
    schema: "uci_arena_evidence_idle_acceptance_v1",
    platform: process.platform,
    cpu_percent: Number(cpuPercent.toFixed(4)),
    rss_mib: Number(rssMiB.toFixed(2)),
    gpu_context_expected: false,
  })}\n`);
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    await shutdownChildProcessTree(child, {
      label: "idle evidence daemon",
      gracefulTimeoutMs: 100,
      forceTimeoutMs: 500,
      ultimateTimeoutMs: 2_000,
    });
  }
  await rm(workspace, { recursive: true, force: true });
}
if (stderr) throw new Error(`idle daemon stderr: ${stderr}`);
