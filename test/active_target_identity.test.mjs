import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  resolveActiveTarget,
  resolveJobTarget,
  sha256File,
  targetIdentity,
  validModelId,
} from "../src/identity.mjs";

async function targetFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "arena-evidence-target-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtimeState = path.join(root, "runtime_state");
  const activeModelPointer = path.join(runtimeState, "active_model_runtime.json");
  const runtimeModelsRoot = path.join(runtimeState, "models");
  const modelRoot = path.join(runtimeModelsRoot, "model-v1", "current");
  const engine = path.join(root, "bin", "uci_arena_engine");
  await mkdir(path.dirname(activeModelPointer), { recursive: true });
  await mkdir(modelRoot, { recursive: true });
  await mkdir(path.dirname(engine), { recursive: true });
  await writeFile(engine, "synthetic engine bytes", "utf8");
  return {
    root,
    activeModelPointer,
    runtimeModelsRoot,
    modelRoot,
    engine,
    config: { activeModelPointer, runtimeModelsRoot, engine },
  };
}

async function writePointer(fixture, override = {}) {
  await writeFile(fixture.activeModelPointer, `${JSON.stringify({
    model_id: "model-v1",
    model_fingerprint: "1234",
    provider: "cpu",
    model_root: fixture.modelRoot,
    engine_path: fixture.engine,
    ...override,
  })}\n`, "utf8");
}

test("active target resolution accepts a bounded model id and exact file types", async (t) => {
  const fixture = await targetFixture(t);
  await writePointer(fixture);

  const resolved = resolveActiveTarget(fixture.config);

  assert.equal(resolved.reason, "");
  assert.equal(resolved.target.modelId, "model-v1");
  assert.equal(resolved.target.modelRoot, fixture.modelRoot);
  assert.equal(resolved.target.enginePath, fixture.engine);
  assert.equal(resolved.target.engineSha256, sha256File(fixture.engine));
});

test("active pointer model ids cannot escape the runtime model namespace", async (t) => {
  const fixture = await targetFixture(t);
  await writePointer(fixture, { model_id: "../../outside" });

  const resolved = resolveActiveTarget(fixture.config);

  assert.equal(resolved.target, null);
  assert.match(resolved.reason, /model_id is invalid/);
  assert.equal(validModelId("model-v1"), true);
  assert.equal(validModelId("../model"), false);
});

test("active pointer rejects a file substituted for the model root", async (t) => {
  const fixture = await targetFixture(t);
  const falseModelRoot = path.join(fixture.root, "not-a-model-directory");
  await writeFile(falseModelRoot, "not a directory", "utf8");
  await writePointer(fixture, { model_root: falseModelRoot });

  const resolved = resolveActiveTarget(fixture.config);

  assert.equal(resolved.target, null);
  assert.match(resolved.reason, /active model root has the wrong type/);
});

test("legacy catalog targets are revalidated before job execution", async (t) => {
  const fixture = await targetFixture(t);
  const target = {
    id: "target-id",
    label: "unsafe",
    modelId: "../escape",
    modelRoot: fixture.modelRoot,
    modelFingerprint: "1234",
    enginePath: fixture.engine,
    engineSha256: sha256File(fixture.engine),
    provider: "cpu",
    hardwareDriverFingerprint: "",
    uciOptions: {},
  };
  const catalog = { target: () => target };

  const resolved = resolveJobTarget({ targetId: "target-id" }, catalog, fixture.config);

  assert.equal(resolved.target, null);
  assert.match(resolved.reason, /model id is invalid/);
  assert.throws(() => targetIdentity(target), /model id is invalid/);
});
