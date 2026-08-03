import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
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

function pointerDocument(fixture, override = {}) {
  return `${JSON.stringify({
    model_id: "model-v1",
    model_fingerprint: "1234",
    provider: "cpu",
    model_root: fixture.modelRoot,
    engine_path: fixture.engine,
    ...override,
  })}\n`;
}

async function writePointer(fixture, override = {}) {
  await writeFile(fixture.activeModelPointer, pointerDocument(fixture, override), "utf8");
}

async function createSymlink(t, target, link, kind) {
  try {
    const type = kind === "directory"
      ? (process.platform === "win32" ? "junction" : "dir")
      : "file";
    await symlink(target, link, type);
    return true;
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP", "UNKNOWN"].includes(error?.code)) {
      t.skip(`${kind} symlink creation is unavailable: ${error.code}`);
      return false;
    }
    throw error;
  }
}

function resolveWithoutThrow(fixture) {
  let resolved;
  assert.doesNotThrow(() => {
    resolved = resolveActiveTarget(fixture.config);
  });
  return resolved;
}

test("a missing active pointer is a healthy waiting state", async (t) => {
  const fixture = await targetFixture(t);

  const resolved = resolveWithoutThrow(fixture);

  assert.equal(resolved.target, null);
  assert.equal(resolved.reason, "active model pointer is missing");
});

test("active target resolution accepts a bounded model id and exact file types", async (t) => {
  const fixture = await targetFixture(t);
  await writePointer(fixture);

  const resolved = resolveWithoutThrow(fixture);

  assert.equal(resolved.reason, "");
  assert.equal(resolved.target.modelId, "model-v1");
  assert.equal(resolved.target.modelRoot, fixture.modelRoot);
  assert.equal(resolved.target.enginePath, fixture.engine);
  assert.equal(resolved.target.engineSha256, sha256File(fixture.engine));
  assert.match(resolved.target.engineSha256, /^[a-f0-9]{64}$/u);
});

test("active pointer model ids cannot escape the runtime model namespace", async (t) => {
  const fixture = await targetFixture(t);
  await writePointer(fixture, { model_id: "../../outside" });

  const resolved = resolveWithoutThrow(fixture);

  assert.equal(resolved.target, null);
  assert.match(resolved.reason, /model_id is invalid/);
  assert.equal(validModelId("model-v1"), true);
  assert.equal(validModelId("../model"), false);
});

test("active pointer must be an exact regular file", async (t) => {
  const fixture = await targetFixture(t);
  await mkdir(fixture.activeModelPointer);

  const resolved = resolveWithoutThrow(fixture);

  assert.equal(resolved.target, null);
  assert.match(resolved.reason, /exact regular non-symlink file/);
});

test("active pointer symbolic links are rejected where supported", async (t) => {
  const fixture = await targetFixture(t);
  const realPointer = path.join(fixture.root, "real-active-pointer.json");
  await writeFile(realPointer, pointerDocument(fixture), "utf8");
  if (!await createSymlink(t, realPointer, fixture.activeModelPointer, "file")) return;

  const resolved = resolveWithoutThrow(fixture);

  assert.equal(resolved.target, null);
  assert.match(resolved.reason, /exact regular non-symlink file/);
});

test("oversized active pointers are rejected before JSON decoding", async (t) => {
  const fixture = await targetFixture(t);
  await writeFile(fixture.activeModelPointer, "x".repeat(65_537), "utf8");

  const resolved = resolveWithoutThrow(fixture);

  assert.equal(resolved.target, null);
  assert.match(resolved.reason, /exceeds 65536 bytes/);
});

test("malformed active pointer JSON returns a bounded reason without throwing", async (t) => {
  const fixture = await targetFixture(t);
  await writeFile(fixture.activeModelPointer, "{not-json", "utf8");

  const resolved = resolveWithoutThrow(fixture);

  assert.equal(resolved.target, null);
  assert.match(resolved.reason, /contains invalid JSON/);
  assert.ok(resolved.reason.length <= 512);
});

test("active pointer JSON must decode to one object", async (t) => {
  const fixture = await targetFixture(t);
  for (const value of [null, [], 7, "text", true]) {
    await writeFile(fixture.activeModelPointer, `${JSON.stringify(value)}\n`, "utf8");

    const resolved = resolveWithoutThrow(fixture);

    assert.equal(resolved.target, null);
    assert.match(resolved.reason, /must contain one JSON object/);
  }
});

test("attacker-sized engine paths return bounded target-resolution reasons", async (t) => {
  const fixture = await targetFixture(t);
  await writePointer(fixture, { engine_path: "x".repeat(60_000) });

  const resolved = resolveWithoutThrow(fixture);

  assert.equal(resolved.target, null);
  assert.ok(resolved.reason.length <= 512);
  assert.doesNotMatch(resolved.reason, /x{1000}/u);
});

test("active pointer rejects a file substituted for the model root", async (t) => {
  const fixture = await targetFixture(t);
  const falseModelRoot = path.join(fixture.root, "not-a-model-directory");
  await writeFile(falseModelRoot, "not a directory", "utf8");
  await writePointer(fixture, { model_root: falseModelRoot });

  const resolved = resolveWithoutThrow(fixture);

  assert.equal(resolved.target, null);
  assert.match(resolved.reason, /active model root has the wrong type/);
});

test("active pointer rejects a symbolic-link model root where supported", async (t) => {
  const fixture = await targetFixture(t);
  const realModelRoot = path.join(fixture.root, "real-model-root");
  const linkedModelRoot = path.join(fixture.root, "linked-model-root");
  await mkdir(realModelRoot);
  if (!await createSymlink(t, realModelRoot, linkedModelRoot, "directory")) return;
  await writePointer(fixture, { model_root: linkedModelRoot });

  const resolved = resolveWithoutThrow(fixture);

  assert.equal(resolved.target, null);
  assert.match(resolved.reason, /must not be a symbolic link/);
});

test("active pointer rejects a symbolic-link engine where supported", async (t) => {
  const fixture = await targetFixture(t);
  const realEngine = path.join(fixture.root, "real-engine");
  const linkedEngine = path.join(fixture.root, "linked-engine");
  await writeFile(realEngine, "synthetic engine bytes", "utf8");
  if (!await createSymlink(t, realEngine, linkedEngine, "file")) return;
  await writePointer(fixture, { engine_path: linkedEngine });

  const resolved = resolveWithoutThrow(fixture);

  assert.equal(resolved.target, null);
  assert.match(resolved.reason, /must not be a symbolic link/);
  assert.throws(() => sha256File(linkedEngine), /must not be a symbolic link/);
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
