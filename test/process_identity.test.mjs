import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { readFileSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { acquireDaemonLock } from "../src/daemon.mjs";
import { readDaemonOwnerPid } from "../src/platform_startup.mjs";
import { validProcessIdentity } from "../src/process_identity.mjs";
import { execFileSync } from "node:child_process";
import { NativeResourceHelper } from "@uci-arena/background-service-runtime/native-resource-helper";
import { Catalog } from "../src/catalog.mjs";
import { loadConfig } from "../src/config.mjs";
import * as processIdentity from "../src/process_identity.mjs";

const identity = {
  schema: "uci_arena_process_instance_identity_v1", platform: "win32", pid: process.pid,
  start_token: "639120000000000000", executable_path: "C:\\provider\\node.exe", boot_id: "",
};
const maximumPath = `C:\\${Array(127).fill("界".repeat(255)).join("\\")}\\${"界".repeat(248)}.exe`;

test("persisted Windows identities admit the complete owned path domain and exact ticks", () => {
  assert.equal(maximumPath.length, 32767);
  assert.equal(validProcessIdentity({ ...identity, executable_path: maximumPath }), true);
  for (const invalid of [
    { start_token: Number(identity.start_token) }, { start_token: "100" },
    { start_token: "3155378976000000000" }, { executable_path: "relative.exe" },
    { executable_path: "C:\\bad\uD800.exe" }, { executable_path: "C:\\bad\u0000.exe" },
    { executable_path: `${maximumPath}x` }, { boot_id: "invented" },
  ]) assert.equal(validProcessIdentity({ ...identity, ...invalid }), false);
});

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "evidence-owner-record-"));
  await mkdir(path.join(root, "locks"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { workspace: root, paths: { locks: path.join(root, "locks") },
    daemonHeartbeatFile: path.join(root, "locks", "daemon.heartbeat.json"), daemon: { staleMs: 300000 } };
}

test("both daemon owner readers preserve a maximum valid Unicode identity record", async (t) => {
  const config = await workspace(t);
  const filename = path.join(config.paths.locks, "daemon.lock");
  const exact = { ...identity, executable_path: maximumPath };
  const packet = { schema: "uci_arena_evidence_daemon_lock_v2", pid: process.pid,
    nonce: "exact-owner", processIdentity: exact };
  const raw = JSON.stringify(packet);
  assert.ok(Buffer.byteLength(raw) > 16384);
  writeFileSync(filename, raw);
  const old = new Date(Date.now() - 400000);
  utimesSync(filename, old, old);
  assert.equal(await readDaemonOwnerPid(config), process.pid);
  await assert.rejects(acquireDaemonLock(config, { identity, probe: () => ({ state: "present", identity: exact }) }),
    /another Arena Evidence daemon owns/);
  assert.equal(readFileSync(filename, "utf8"), raw);
});

for (const [name, raw] of [
  ["malformed v2 identity", JSON.stringify({ schema: "uci_arena_evidence_daemon_lock_v2", pid: process.pid, processIdentity: null })],
  ["missing v2 identity", JSON.stringify({ schema: "uci_arena_evidence_daemon_lock_v2", pid: process.pid })],
  ["unknown schema", JSON.stringify({ schema: "unknown", pid: process.pid })],
  ["unknown legacy fields", JSON.stringify({ pid: process.pid, unexpected: true })],
  ["unknown v2 fields", JSON.stringify({ schema: "uci_arena_evidence_daemon_lock_v2", pid: process.pid, processIdentity: identity, unexpected: true })],
  ["wrong identity field type", JSON.stringify({ schema: "uci_arena_evidence_daemon_lock_v2", pid: process.pid, processIdentity: JSON.stringify(identity) })],
  ["oversized record", Buffer.alloc(262145, 32)],
  ["malformed UTF-8", Buffer.concat([Buffer.from('{"pid":'), Buffer.from(String(process.pid)), Buffer.from(',"nonce":"'), Buffer.from([255]), Buffer.from('"}')])],
  ["corrupt JSON", "{corrupt"],
]) test(`unknown owner record cannot downgrade to stale PID-only migration: ${name}`, async (t) => {
  const config = await workspace(t);
  const filename = path.join(config.paths.locks, "daemon.lock");
  writeFileSync(filename, raw);
  const old = new Date(Date.now() - 400000);
  utimesSync(filename, old, old);
  await assert.rejects(async () => {
    const unexpected = await acquireDaemonLock(config, { identity, probe: () => ({ state: "absent" }) });
    await unexpected.release();
  }, /malformed|unverifiable/);
  await assert.rejects(readDaemonOwnerPid(config), /malformed|unverifiable/);
  assert.deepEqual(readFileSync(filename), Buffer.isBuffer(raw) ? raw : Buffer.from(raw));
});

test("actual legacy PID-only ownership remains reclaimable after the existing stale rule", async (t) => {
  const config = await workspace(t);
  const filename = path.join(config.paths.locks, "daemon.lock");
  writeFileSync(filename, JSON.stringify({ pid: process.pid }));
  const old = new Date(Date.now() - 400000);
  utimesSync(filename, old, old);
  const acquired = await acquireDaemonLock(config, { identity, probe: () => ({ state: "absent" }) });
  await acquired.release();
});

test("pure public description does not require an unavailable identity helper", async (t) => {
  const config = await workspace(t);
  const filename = path.join(config.workspace, "config.json");
  writeFileSync(filename, JSON.stringify({ workspace: config.workspace, nativeHelper: path.join(config.workspace, "missing.exe") }));
  const result = JSON.parse(execFileSync(process.execPath, [path.resolve("src/cli.mjs"),
    "--config", filename, "api", "describe"], { encoding: "utf8", windowsHide: true, timeout: 5000 }));
  assert.equal(result.ok, true);
});

for (const format of ["exact v2", "legacy"]) {
  for (const [name, observed] of [
    ["null present identity", { state: "present", identity: null }],
    ["wrong present PID", { state: "present", identity: { ...identity, pid: process.pid + 1 } }],
    ["malformed present identity", { state: "present", identity: { ...identity, start_token: "malformed" } }],
    ["unverifiable observation", { state: "unverifiable" }],
    ["unknown observation", { state: "unknown" }],
  ]) test(`${format} lock cannot be reclaimed from ${name}`, async (t) => {
    const config = await workspace(t);
    const filename = path.join(config.paths.locks, "daemon.lock");
    const value = { pid: process.pid, nonce: "prior-owner", started_at: "2026-01-01T00:00:00.000Z" };
    if (format === "exact v2") Object.assign(value, {
      schema: "uci_arena_evidence_daemon_lock_v2", processIdentity: identity,
    });
    const raw = JSON.stringify(value);
    writeFileSync(filename, raw);
    const old = new Date(Date.now() - 400000);
    utimesSync(filename, old, old);
    let probes = 0;
    await assert.rejects(async () => {
      const unexpected = await acquireDaemonLock(config, { identity,
        probe: (pid) => { ++probes; assert.equal(pid, process.pid); return observed; } });
      await unexpected.release();
    }, /owns|unverifiable/);
    assert.equal(probes, 1);
    assert.equal(readFileSync(filename, "utf8"), raw);
    assert.deepEqual(await readdir(config.paths.locks), ["daemon.lock"]);
  });
}

test("persisted Linux birth identity retains its procfs token and case-sensitive executable comparison", () => {
  const linux = { ...identity, platform: "linux", start_token: "100", executable_path: "/usr/bin/node", boot_id: "boot-id" };
  assert.equal(validProcessIdentity(linux), true);
  assert.equal(processIdentity.sameProcessInstance(linux, { ...linux }), true);
  assert.equal(processIdentity.sameProcessInstance(linux, { ...linux, start_token: "101" }), false);
  assert.equal(processIdentity.sameProcessInstance(linux, { ...linux, executable_path: "/usr/bin/Node" }), false);
});

test("unsupported selected helper capability rejects identity actions before catalog creation", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows native adapter; Linux uses procfs");
  const fixture = await workspace(t);
  const filename = path.join(fixture.workspace, "config.json");
  writeFileSync(filename, JSON.stringify({ workspace: fixture.workspace, nativeHelper: process.execPath }));
  assert.throws(() => execFileSync(process.execPath, [path.resolve("src/cli.mjs"),
    "--config", filename, "api", "status"], { windowsHide: true, timeout: 5000, stdio: "pipe" }),
  (error) => error.status === 1 && error.stderr.toString().includes("native process instance query capability is unavailable"));
  assert.equal((await import("node:fs")).existsSync(path.join(fixture.workspace, "catalog.sqlite")), false);
});

test("qualified public query preserves default and shrinking budgets without supervisor coupling", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows native adapter; Linux uses procfs");
  const calls = [];
  const helper = { probe: async () => ({ schema: "uci_arena_background_service_native_probe_v1", capabilities: ["process_instance_query_v1"] }),
    queryProcessInstanceSync: (pid, options) => { calls.push({ pid, options }); return {
      schema: "uci_arena_process_instance_query_v1", state: "present", identity: { ...identity, pid } };
    } };
  await processIdentity.configureProcessIdentityProbe(helper);
  assert.equal(processIdentity.probeProcessInstance(42).state, "present");
  assert.equal(processIdentity.probeProcessInstance(42, { timeoutMs: 17 }).state, "present");
  assert.deepEqual(calls.map((call) => call.options.timeoutMs), [2000, 17]);
  assert.equal(processIdentity.probeProcessInstance(42, { timeoutMs: 0 }).state, "unverifiable");
  assert.equal(calls.length, 2);
  await assert.rejects(processIdentity.configureProcessIdentityProbe({ ...helper,
    probe: async () => ({ capabilities: [] }) }), /capability is unavailable/);
  assert.equal(processIdentity.probeProcessInstance(42).state, "unverifiable");
});

for (const command of ["status", "daemon"]) test(`fresh original CLI ${command} uses the selected native identity query without PowerShell`, async (t) => {
  if (process.platform !== "win32") return t.skip("Windows native adapter; Linux uses procfs");
  const fixture = await workspace(t);
  const nativeHelper = path.resolve("native/bin/uci_arena_background_guard.exe");
  const configFile = path.join(fixture.workspace, "config.json");
  writeFileSync(configFile, JSON.stringify({ workspace: fixture.workspace, nativeHelper,
    runtimeRoot: path.join(fixture.workspace, "absent-runtime"), activeModelPointer: path.join(fixture.workspace, "absent-pointer.json") }));
  const config = await loadConfig({ configFile });
  const native = new NativeResourceHelper(config);
  await processIdentity.configureProcessIdentityProbe(native);
  const owner = native.queryProcessInstanceSync(process.pid);
  assert.equal(owner.state, "present");
  const catalog = new Catalog(config);
  if (command === "status") catalog.updateDaemonState({ pid: process.pid, processIdentity: owner.identity,
    phase: "sleep", heartbeatAt: new Date().toISOString() });
  catalog.close();
  const script = `import childProcess from 'node:child_process';
    import {syncBuiltinESMExports} from 'node:module';
    const original=childProcess.execFileSync;
    childProcess.execFileSync=(file,...args)=>{if(/powershell(?:\\.exe)?$/iu.test(file))throw new Error('PowerShell identity fallback forbidden');return original(file,...args);};
    syncBuiltinESMExports();
    process.argv=[process.execPath,${JSON.stringify(path.resolve("src/cli.mjs"))},'--config',${JSON.stringify(configFile)},${JSON.stringify(command)},'--once'];
    await import(${JSON.stringify(new URL("../src/cli.mjs", import.meta.url).href)});`;
  const response = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script],
    { encoding: "utf8", windowsHide: true, timeout: 10000, maxBuffer: 262144 }));
  if (command === "status") assert.equal(response.daemon.active, true);
  else assert.equal(response.state, "idle");
});
