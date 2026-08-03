import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadConfig } from "../src/config.mjs";
import {
  canonicalDaemonTiming,
  DAEMON_CYCLE_MS,
  DAEMON_HEARTBEAT_MS,
  DAEMON_STALE_MS,
  validateDaemonTiming,
} from "../src/daemon_timing.mjs";

async function writeConfig(root, override = {}) {
  const filename = path.join(root, "config.json");
  await writeFile(filename, `${JSON.stringify({
    schema: "uci_arena_evidence_service_config_v1",
    ...override,
  }, null, 2)}\n`, "utf8");
  return filename;
}

test("canonical daemon timing preserves the service contract", () => {
  assert.deepEqual(canonicalDaemonTiming(), {
    heartbeatMs: 15_000,
    cycleMs: 60_000,
    staleMs: 300_000,
  });
  assert.equal(DAEMON_HEARTBEAT_MS, 15_000);
  assert.equal(DAEMON_CYCLE_MS, 60_000);
  assert.equal(DAEMON_STALE_MS, 300_000);
  assert.doesNotThrow(() => validateDaemonTiming(canonicalDaemonTiming()));
});

test("daemon timing rejects changed values and invalid numeric types", () => {
  for (const daemon of [
    { ...canonicalDaemonTiming(), heartbeatMs: 1 },
    { ...canonicalDaemonTiming(), cycleMs: 1 },
    { ...canonicalDaemonTiming(), staleMs: 1 },
    { ...canonicalDaemonTiming(), heartbeatMs: 15_000.5 },
    { ...canonicalDaemonTiming(), staleMs: "300000" },
  ]) {
    assert.throws(() => validateDaemonTiming(daemon), /must equal/);
  }
});

test("daemon timing projection rejects unknown and missing authority keys", () => {
  assert.throws(
    () => validateDaemonTiming({ ...canonicalDaemonTiming(), retryMs: 1 }),
    /must contain only/,
  );
  const missing = canonicalDaemonTiming();
  delete missing.staleMs;
  assert.throws(() => validateDaemonTiming(missing), /must contain only/);
  assert.throws(() => validateDaemonTiming([]), /must be an object/);
});

test("configuration loader publishes canonical daemon timing", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "arena-evidence-daemon-timing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configFile = await writeConfig(root);

  const config = await loadConfig({
    configFile,
    workspace: path.join(root, "workspace"),
  });

  assert.deepEqual(config.daemon, canonicalDaemonTiming());
});

test("configuration loader normalizes partial canonical timing", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "arena-evidence-daemon-timing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configFile = await writeConfig(root, {
    daemon: { heartbeatMs: DAEMON_HEARTBEAT_MS },
  });

  const config = await loadConfig({
    configFile,
    workspace: path.join(root, "workspace"),
  });

  assert.deepEqual(config.daemon, canonicalDaemonTiming());
});

test("configuration loader rejects daemon timing overrides", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "arena-evidence-daemon-timing-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  for (const daemon of [
    { heartbeatMs: 1 },
    { cycleMs: 1 },
    { staleMs: 1 },
    { extraMs: 1 },
  ]) {
    const configFile = await writeConfig(root, { daemon });
    await assert.rejects(
      loadConfig({ configFile, workspace: path.join(root, "workspace") }),
      /daemon timing|daemon\.(?:heartbeatMs|cycleMs|staleMs)/,
    );
  }
});
