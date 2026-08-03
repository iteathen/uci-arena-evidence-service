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

import { loadConfig } from "../src/config.mjs";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "arena-evidence-owner-roots-"));
  const ownerRoot = path.join(root, "foreground-owner");
  await mkdir(ownerRoot, { recursive: true });
  return { root, ownerRoot };
}

async function writeRawConfig(root, text, basename = "config.json") {
  const filename = path.join(root, basename);
  await writeFile(filename, text, "utf8");
  return filename;
}

async function writeConfig(root, value) {
  return writeRawConfig(root, `${JSON.stringify({
    schema: "uci_arena_evidence_service_config_v1",
    ...value,
  }, null, 2)}\n`);
}

async function createSymlink(t, target, link, kind) {
  try {
    const type = process.platform === "win32" && kind === "directory" ? "junction" : kind;
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

test("configuration input must be an exact regular file", async (t) => {
  const { root } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "config-directory");
  await mkdir(directory);

  await assert.rejects(
    loadConfig({ configFile: directory, workspace: path.join(root, "workspace") }),
    /exact regular non-symlink file/,
  );
});

test("configuration file symbolic links are rejected where supported", async (t) => {
  const { root } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const realConfig = await writeRawConfig(
    root,
    "{\"schema\":\"uci_arena_evidence_service_config_v1\"}\n",
    "real-config.json",
  );
  const linkedConfig = path.join(root, "linked-config.json");
  if (!await createSymlink(t, realConfig, linkedConfig, "file")) return;

  await assert.rejects(
    loadConfig({ configFile: linkedConfig, workspace: path.join(root, "workspace") }),
    /exact regular non-symlink file/,
  );
});

test("oversized configuration files are rejected before JSON decoding", async (t) => {
  const { root } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const filename = await writeRawConfig(root, "x".repeat(1_048_577));

  await assert.rejects(
    loadConfig({ configFile: filename, workspace: path.join(root, "workspace") }),
    /exceeds 1048576 bytes/,
  );
});

test("configuration input must decode to one JSON object", async (t) => {
  const { root } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  for (const value of [null, [], 7, "text", true]) {
    const filename = await writeRawConfig(root, `${JSON.stringify(value)}\n`);
    await assert.rejects(
      loadConfig({ configFile: filename, workspace: path.join(root, "workspace") }),
      /configuration file must contain one JSON object/,
    );
  }
});

test("configuration rejects prototype-mutating keys at every object depth", async (t) => {
  const { root } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(Object.prototype.polluted, undefined);

  const documents = [
    "{\"schema\":\"uci_arena_evidence_service_config_v1\",\"__proto__\":{\"polluted\":true}}",
    "{\"schema\":\"uci_arena_evidence_service_config_v1\",\"resources\":{\"constructor\":{\"polluted\":true}}}",
    "{\"schema\":\"uci_arena_evidence_service_config_v1\",\"profileImports\":[{\"prototype\":{\"polluted\":true}}]}",
  ];
  for (const document of documents) {
    const filename = await writeRawConfig(root, `${document}\n`);
    await assert.rejects(
      loadConfig({ configFile: filename, workspace: path.join(root, "workspace") }),
      /forbidden object key/,
    );
    assert.equal(Object.prototype.polluted, undefined);
  }
});

test("configuration nesting and visited-value bounds are enforced", async (t) => {
  const { root } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  const nested = {};
  let cursor = nested;
  for (let index = 0; index < 65; index += 1) {
    cursor.next = {};
    cursor = cursor.next;
  }
  let filename = await writeConfig(root, { nested });
  await assert.rejects(
    loadConfig({ configFile: filename, workspace: path.join(root, "workspace") }),
    /exceeds nesting depth 64/,
  );

  filename = await writeConfig(root, { values: Array(10_001).fill(0) });
  await assert.rejects(
    loadConfig({ configFile: filename, workspace: path.join(root, "workspace") }),
    /exceeds 10000 values/,
  );
});

test("configured path fields are strings before path resolution", async (t) => {
  const { root } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const filename = await writeConfig(root, { activeModelPointer: {} });

  await assert.rejects(
    loadConfig({ configFile: filename, workspace: path.join(root, "workspace") }),
    /activeModelPointer must be a non-empty path string/,
  );
});

test("profile imports and priority process names reject non-string values", async (t) => {
  const { root } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  let filename = await writeConfig(root, { profileImports: [7] });
  await assert.rejects(
    loadConfig({ configFile: filename, workspace: path.join(root, "workspace") }),
    /profileImports must contain/,
  );

  filename = await writeConfig(root, {
    resources: { priorityProcessNames: [123] },
  });
  await assert.rejects(
    loadConfig({ configFile: filename, workspace: path.join(root, "workspace") }),
    /priorityProcessNames must contain executable basenames/,
  );
});

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

test("missing optional external owner roots remain ignored", async (t) => {
  const { root } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const filename = await writeConfig(root, {
    externalOwnerRoots: ["not-installed-owner"],
  });

  const config = await loadConfig({ configFile: filename, workspace: path.join(root, "workspace") });

  assert.deepEqual(config.externalOwnerRoots, []);
});

test("external owner-root paths above the declared bound are rejected", async (t) => {
  const { root } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const filename = await writeConfig(root, {
    externalOwnerRoots: ["x".repeat(32_768)],
  });

  await assert.rejects(
    loadConfig({ configFile: filename, workspace: path.join(root, "workspace") }),
    /at most 32767 characters/,
  );
});

test("owner-root inspection failures have bounded diagnostics", async (t) => {
  const { root } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const filename = await writeConfig(root, {
    externalOwnerRoots: ["x".repeat(32_767)],
  });

  await assert.rejects(
    loadConfig({ configFile: filename, workspace: path.join(root, "workspace") }),
    (error) => {
      assert.ok(error.message.length <= 512);
      return true;
    },
  );
});

test("an existing regular file cannot acquire external owner-root authority", async (t) => {
  const { root } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const falseRoot = path.join(root, "not-a-directory");
  await writeFile(falseRoot, "not a directory", "utf8");
  const filename = await writeConfig(root, {
    externalOwnerRoots: [path.basename(falseRoot)],
  });

  await assert.rejects(
    loadConfig({ configFile: filename, workspace: path.join(root, "workspace") }),
    /exact regular non-symlink directory/,
  );
});

test("a symbolic link cannot acquire external owner-root authority", async (t) => {
  const { root, ownerRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const linkedRoot = path.join(root, "linked-owner");
  if (!await createSymlink(t, ownerRoot, linkedRoot, "directory")) return;
  const filename = await writeConfig(root, {
    externalOwnerRoots: [path.basename(linkedRoot)],
  });

  await assert.rejects(
    loadConfig({ configFile: filename, workspace: path.join(root, "workspace") }),
    /exact regular non-symlink directory/,
  );
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
