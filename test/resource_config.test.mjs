import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadConfig } from "../src/config.mjs";

async function writeConfig(root, resources = {}) {
  const filename = path.join(root, "config.json");
  await writeFile(filename, `${JSON.stringify({
    schema: "uci_arena_evidence_service_config_v1",
    resources,
  }, null, 2)}\n`, "utf8");
  return filename;
}

async function loadWithResources(t, resources) {
  const root = await mkdtemp(path.join(os.tmpdir(), "arena-evidence-resource-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return loadConfig({
    configFile: await writeConfig(root, resources),
    workspace: path.join(root, "workspace"),
  });
}

test("canonical resource defaults remain admitted", async (t) => {
  const config = await loadWithResources(t, {});
  assert.equal(config.resources.inputIdleMs, 60_000);
  assert.equal(config.resources.consecutiveIdleSamples, 3);
  assert.equal(config.resources.pollMs, 1_000);
  assert.equal(config.resources.revokeWithinMs, 2_000);
});

test("continuous resource thresholds may be fractional", async (t) => {
  const config = await loadWithResources(t, {
    minimumFreeWorkspaceGb: 75.5,
    pauseAvailableMemoryGb: 6.25,
    maximumUsedMemoryPercent: 70.5,
    maximumUsedCpuPercent: 20.5,
    maximumGpuUtilPercent: 5.5,
  });
  assert.equal(config.resources.minimumFreeWorkspaceGb, 75.5);
  assert.equal(config.resources.maximumUsedCpuPercent, 20.5);
});

test("sample counts and timer milliseconds require safe integers", async (t) => {
  for (const [name, value] of [
    ["inputIdleMs", 60_000.5],
    ["consecutiveIdleSamples", 3.5],
    ["pollMs", 1_000.5],
    ["revokeWithinMs", 1_000.5],
    ["pollMs", "1000"],
    ["revokeWithinMs", null],
    ["inputIdleMs", -1],
    ["consecutiveIdleSamples", 101],
    ["pollMs", 99],
    ["revokeWithinMs", 2_001],
  ]) {
    await assert.rejects(
      loadWithResources(t, { [name]: value }),
      new RegExp(`resources\\.${name} must be an integer`),
    );
  }
});

test("priority process name count is admitted at 64 and rejected at 65", async (t) => {
  const sixtyFour = Array.from({ length: 64 }, (_, index) => `tool-${index}`);
  const config = await loadWithResources(t, { priorityProcessNames: sixtyFour });
  assert.deepEqual(config.resources.priorityProcessNames, sixtyFour);

  await assert.rejects(
    loadWithResources(t, {
      priorityProcessNames: [...sixtyFour, "tool-64"],
    }),
    /at most 64 executable basenames/,
  );
});

test("priority process names are bounded executable basenames", async (t) => {
  const boundary = "x".repeat(128);
  const config = await loadWithResources(t, { priorityProcessNames: [boundary] });
  assert.deepEqual(config.resources.priorityProcessNames, [boundary]);

  await assert.rejects(
    loadWithResources(t, { priorityProcessNames: ["x".repeat(129)] }),
    /at most 128 characters/,
  );
  await assert.rejects(
    loadWithResources(t, { priorityProcessNames: ["../tool"] }),
    /executable basenames/,
  );
  await assert.rejects(
    loadWithResources(t, { priorityProcessNames: ["tool one"] }),
    /executable basenames/,
  );
  await assert.rejects(
    loadWithResources(t, { priorityProcessNames: [""] }),
    /executable basenames/,
  );
});

test("priority process names are unique under case-insensitive matching", async (t) => {
  await assert.rejects(
    loadWithResources(t, { priorityProcessNames: ["Ninja", "ninja"] }),
    /unique ignoring ASCII case/,
  );
  const config = await loadWithResources(t, {
    priorityProcessNames: ["ninja", "cmake", "cl.exe"],
  });
  assert.deepEqual(config.resources.priorityProcessNames, ["ninja", "cmake", "cl.exe"]);
});
