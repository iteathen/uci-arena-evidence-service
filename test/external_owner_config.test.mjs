import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadConfig } from "../src/config.mjs";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "arena-evidence-owner-roots-"));
  const ownerRoot = path.join(root, "foreground-owner");
  await mkdir(ownerRoot, { recursive: true });
  return { root, ownerRoot };
}

async function writeConfig(root, value) {
  const filename = path.join(root, "config.json");
  await writeFile(filename, `${JSON.stringify({
    schema: "uci_arena_evidence_service_config_v1",
    ...value,
  }, null, 2)}\n`, "utf8");
  return filename;
}

test("canonical external owner roots resolve relative to the configuration file", async (t) => {
  const { root, ownerRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const filename = await writeConfig(root, {
    externalOwnerRoots: [path.basename(ownerRoot), path.basename(ownerRoot)],
  });

  const config = await loadConfig({ configFile: filename, workspace: path.join(root, "workspace") });

  assert.deepEqual(config.externalOwnerRoots, [ownerRoot]);
  assert.deepEqual(config.restaurantRoots, [ownerRoot]);
  assert.equal(Object.keys(config).includes("restaurantRoots"), false);
  assert.equal(JSON.stringify(config).includes("restaurantRoots"), false);
});

test("the input-only legacy owner-root key normalizes to the canonical field", async (t) => {
  const { root, ownerRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const filename = await writeConfig(root, {
    restaurantRoots: [path.basename(ownerRoot)],
  });

  const config = await loadConfig({ configFile: filename, workspace: path.join(root, "workspace") });

  assert.deepEqual(config.externalOwnerRoots, [ownerRoot]);
  assert.equal(Object.keys(config).includes("restaurantRoots"), false);
});

test("canonical and legacy owner-root keys cannot compete for authority", async (t) => {
  const { root, ownerRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const filename = await writeConfig(root, {
    externalOwnerRoots: [path.basename(ownerRoot)],
    restaurantRoots: [path.basename(ownerRoot)],
  });

  await assert.rejects(
    loadConfig({ configFile: filename, workspace: path.join(root, "workspace") }),
    /configure only externalOwnerRoots/,
  );
});
