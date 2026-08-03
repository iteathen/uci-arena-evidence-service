import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import * as fsPromises from "node:fs/promises";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Catalog } from "../src/catalog.mjs";
import { PruneService, normalizePruneCutoff } from "../src/prune_service.mjs";
import { PruneStore } from "../src/prune_store.mjs";

function configFor(root) {
  return {
    workspace: root,
    activeModelPointer: path.join(root, "missing-active-model.json"),
    paths: {
      catalog: path.join(root, "catalog.sqlite"),
      artifacts: path.join(root, "artifacts"),
      attempts: path.join(root, "attempts"),
      exports: path.join(root, "exports"),
      locks: path.join(root, "locks"),
      profiles: path.join(root, "profiles"),
    },
  };
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "arena-evidence-prune-"));
  const config = configFor(root);
  mkdirSync(config.paths.artifacts, { recursive: true });
  const catalog = new Catalog(config);
  const store = new PruneStore(config.paths.catalog);
  t.after(() => store.close());
  t.after(() => catalog.close());
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, config, catalog, store };
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function addArtifact(
  context,
  {
    body = `${randomUUID()}\n`,
    filename = null,
    createdAt = "2025-01-01T00:00:00.000Z",
    datasetState = "completed",
    withObservation = true,
  } = {},
) {
  const sha256 = digest(body);
  const artifactPath = filename ?? path.join(context.config.paths.artifacts, `${sha256}.json`);
  mkdirSync(path.dirname(artifactPath), { recursive: true });
  writeFileSync(artifactPath, body, "utf8");
  context.catalog.registerArtifact({
    sha256,
    schema: "fixture_raw_v1",
    filename: artifactPath,
    sizeBytes: Buffer.byteLength(body),
  });
  context.catalog.database.prepare(`
    UPDATE artifacts SET created_at=? WHERE sha256=?
  `).run(createdAt, sha256);

  let datasetId = null;
  if (withObservation) {
    datasetId = context.catalog.createDataset({ campaign: "prune-test" });
    const job = context.catalog.enqueueJob({
      adapter: "fixture",
      shardId: `shard-${randomUUID()}`,
      datasetId,
      fingerprint: digest(randomUUID()),
      config: {},
    });
    context.catalog.addObservation({
      schema: "uci_arena_observation_envelope_v1",
      observation_id: randomUUID(),
      dataset_id: datasetId,
      job_id: job.id,
      shard_id: "fixture-shard",
      recorded_at: "2025-01-01T00:00:01.000Z",
      adapter: "fixture",
      source_schema: "fixture_source_v1",
      raw_sha256: sha256,
      target_identity: { model_id: "fixture" },
      axes: {},
      metrics: {},
      outcome: {},
      resource: {},
      authority: { diagnostic: true },
    });
    if (datasetState !== "collecting") {
      context.catalog.completeDataset(datasetId, { diagnostic: true });
      if (datasetState !== "completed") {
        context.catalog.database.prepare("UPDATE datasets SET state=? WHERE id=?")
          .run(datasetState, datasetId);
      }
    }
  }
  return {
    sha256,
    artifactPath,
    body,
    sizeBytes: Buffer.byteLength(body),
    datasetId,
  };
}

function quarantineRoot(config) {
  return path.join(config.paths.artifacts, ".prune-quarantine");
}

function quarantineEntries(config) {
  const root = quarantineRoot(config);
  return existsSync(root) ? readdirSync(root) : [];
}

function fsOps(overrides = {}) {
  return {
    lstat: fsPromises.lstat,
    mkdir: fsPromises.mkdir,
    readdir: fsPromises.readdir,
    realpath: fsPromises.realpath,
    rename: fsPromises.rename,
    rm: fsPromises.rm,
    rmdir: fsPromises.rmdir,
    ...overrides,
  };
}

test("prune cutoff accepts only real canonical UTC timestamps", () => {
  assert.equal(
    normalizePruneCutoff("2026-01-01T00:00:00Z"),
    "2026-01-01T00:00:00.000Z",
  );
  assert.equal(
    normalizePruneCutoff("2026-01-01T00:00:00.123Z"),
    "2026-01-01T00:00:00.123Z",
  );
  for (const value of [
    "2026-01-01",
    "2026-01-01T00:00:00+00:00",
    "2026-02-30T00:00:00Z",
    "2026-01-01T00:00:00.12Z",
    "2026-01-01T00:00:00Z trailing",
  ]) {
    assert.throws(() => normalizePruneCutoff(value), /ISO UTC|real ISO UTC/);
  }
});

test("dry run uses aggregate catalog state and preserves files and rows", async (t) => {
  const context = await fixture(t);
  const eligible = addArtifact(context);
  const collecting = addArtifact(context, { datasetState: "collecting" });
  const originalConfirmed = context.store.withConfirmedPrune;
  context.store.withConfirmedPrune = () => {
    throw new Error("dry run must not open the destructive transaction");
  };

  const result = await new PruneService(context.store, context.config).run({
    before: "2026-01-01T00:00:00Z",
  });

  context.store.withConfirmedPrune = originalConfirmed;
  assert.equal(result.confirmed, false);
  assert.equal(result.artifactCount, 1);
  assert.equal(result.bytes, eligible.sizeBytes);
  assert.equal(result.deleted, 0);
  assert.equal(existsSync(eligible.artifactPath), true);
  assert.equal(existsSync(collecting.artifactPath), true);
  assert.ok(context.store.artifact(eligible.sha256));
  assert.ok(context.store.artifact(collecting.sha256));
  assert.equal(context.store.audit(result.auditId).result.confirmed, false);
  assert.deepEqual(quarantineEntries(context.config), []);
});

test("confirmed prune validates stages commits audits and cleans", async (t) => {
  const context = await fixture(t);
  const artifact = addArtifact(context);

  const result = await new PruneService(context.store, context.config).run({
    before: "2026-01-01T00:00:00Z",
    confirm: "PRUNE",
  });

  assert.equal(result.confirmed, true);
  assert.equal(result.artifactCount, 1);
  assert.equal(result.staged, 1);
  assert.equal(result.deleted, 1);
  assert.equal(result.cleanupPending, false);
  assert.equal(existsSync(artifact.artifactPath), false);
  assert.equal(context.store.artifact(artifact.sha256), null);
  assert.equal(context.catalog.dataset(artifact.datasetId).observationCount, 0);
  const audit = context.store.audit(result.auditId);
  assert.equal(audit.confirmed, true);
  assert.equal(audit.result.cleanupPending, false);
  assert.deepEqual(quarantineEntries(context.config), []);
});

test("audit insertion failure rolls back rows and restores staged files", async (t) => {
  const context = await fixture(t);
  const artifact = addArtifact(context);
  const insertAudit = context.store.insertAudit.bind(context.store);
  context.store.insertAudit = (value) => {
    if (value.confirmed) throw new Error("injected audit failure");
    return insertAudit(value);
  };

  await assert.rejects(
    new PruneService(context.store, context.config).run({
      before: "2026-01-01T00:00:00Z",
      confirm: "PRUNE",
    }),
    /injected audit failure/,
  );

  assert.equal(existsSync(artifact.artifactPath), true);
  assert.equal(readFileSync(artifact.artifactPath, "utf8"), artifact.body);
  assert.ok(context.store.artifact(artifact.sha256));
  assert.equal(context.catalog.dataset(artifact.datasetId).observationCount, 1);
  assert.deepEqual(quarantineEntries(context.config), []);
});

test("post-rename identity failure leaves the altered file quarantined and catalog rows intact", async (t) => {
  const context = await fixture(t);
  const artifact = addArtifact(context);
  const service = new PruneService(context.store, context.config, {
    async hashFile(filename) {
      return filename.includes(".prune-quarantine")
        ? "0".repeat(64)
        : artifact.sha256;
    },
  });

  await assert.rejects(
    service.run({
      before: "2026-01-01T00:00:00Z",
      confirm: "PRUNE",
    }),
    AggregateError,
  );
  assert.ok(context.store.artifact(artifact.sha256));
  assert.equal(existsSync(artifact.artifactPath), false);
  assert.equal(quarantineEntries(context.config).length, 1);

  const recovery = await new PruneService(context.store, context.config).run({
    before: "2024-01-01T00:00:00Z",
  });
  assert.equal(recovery.recovered.restored, 1);
  assert.equal(existsSync(artifact.artifactPath), true);
  assert.deepEqual(quarantineEntries(context.config), []);
});

test("rollback restoration failure leaves a recoverable quarantine marker", async (t) => {
  const context = await fixture(t);
  const artifact = addArtifact(context);
  const insertAudit = context.store.insertAudit.bind(context.store);
  context.store.insertAudit = (value) => {
    if (value.confirmed) throw new Error("injected database failure");
    return insertAudit(value);
  };
  let restoreFailed = false;
  const injectedFs = fsOps({
    async rename(from, to) {
      if (from.includes(".prune-quarantine") && to === artifact.artifactPath
          && !restoreFailed) {
        restoreFailed = true;
        throw new Error("injected restore failure");
      }
      return fsPromises.rename(from, to);
    },
  });

  await assert.rejects(
    new PruneService(context.store, context.config, { fsOps: injectedFs }).run({
      before: "2026-01-01T00:00:00Z",
      confirm: "PRUNE",
    }),
    AggregateError,
  );
  assert.ok(context.store.artifact(artifact.sha256));
  assert.equal(existsSync(artifact.artifactPath), false);
  assert.equal(quarantineEntries(context.config).length, 1);

  context.store.insertAudit = insertAudit;
  const recovery = await new PruneService(context.store, context.config).run({
    before: "2024-01-01T00:00:00Z",
  });
  assert.equal(recovery.recovered.restored, 1);
  assert.equal(existsSync(artifact.artifactPath), true);
  assert.ok(context.store.artifact(artifact.sha256));
  assert.deepEqual(quarantineEntries(context.config), []);
});

test("post-commit cleanup failure remains audited and is completed on the next run", async (t) => {
  const context = await fixture(t);
  const artifact = addArtifact(context);
  let failed = false;
  const injectedFs = fsOps({
    async rm(filename, options) {
      if (!failed && filename.endsWith(".artifact")) {
        failed = true;
        throw new Error("injected quarantine cleanup failure");
      }
      return fsPromises.rm(filename, options);
    },
  });
  const result = await new PruneService(context.store, context.config, {
    fsOps: injectedFs,
  }).run({
    before: "2026-01-01T00:00:00Z",
    confirm: "PRUNE",
  });

  assert.equal(result.cleanupPending, true);
  assert.equal(context.store.artifact(artifact.sha256), null);
  assert.equal(existsSync(artifact.artifactPath), false);
  assert.equal(quarantineEntries(context.config).length, 1);
  assert.equal(context.store.audit(result.auditId).result.cleanupPending, true);

  const recovery = await new PruneService(context.store, context.config).run({
    before: "2024-01-01T00:00:00Z",
  });
  assert.equal(recovery.recovered.cleaned, 1);
  assert.deepEqual(quarantineEntries(context.config), []);
  assert.equal(context.store.audit(result.auditId).result.cleanupPending, false);
});

test("rowless quarantine files require a matching confirmed pending audit", async (t) => {
  const context = await fixture(t);
  const body = "forged quarantine file\n";
  const sha256 = digest(body);
  const operation = randomUUID();
  const directory = path.join(quarantineRoot(context.config), operation);
  mkdirSync(directory, { recursive: true });
  const staged = path.join(directory, `${sha256}.artifact`);
  writeFileSync(staged, body, "utf8");

  await assert.rejects(
    new PruneService(context.store, context.config).run({
      before: "2024-01-01T00:00:00Z",
    }),
    /lacks confirmed pending audit authority/,
  );
  assert.equal(existsSync(staged), true);
});

test("unsafe catalog paths size changes and digest changes fail without deletion", async (t) => {
  const context = await fixture(t);
  const outside = path.join(context.root, "outside.json");
  const external = addArtifact(context, { filename: outside });
  await assert.rejects(
    new PruneService(context.store, context.config).run({
      before: "2026-01-01T00:00:00Z",
      confirm: "PRUNE",
    }),
    /escapes owned artifact storage/,
  );
  assert.equal(existsSync(outside), true);
  assert.ok(context.store.artifact(external.sha256));

  context.catalog.database.prepare("UPDATE artifacts SET created_at=? WHERE sha256=?")
    .run("2027-01-01T00:00:00.000Z", external.sha256);
  const changed = addArtifact(context, { body: "original\n" });
  writeFileSync(changed.artifactPath, "modified\n", "utf8");
  await assert.rejects(
    new PruneService(context.store, context.config).run({
      before: "2026-01-01T00:00:00Z",
      confirm: "PRUNE",
    }),
    /size does not match|digest does not match/,
  );
  assert.ok(context.store.artifact(changed.sha256));
  assert.equal(existsSync(changed.artifactPath), true);
});

test("physical symlink escape is rejected before catalog mutation", async (t) => {
  if (process.platform === "win32") {
    t.skip("ordinary Windows test accounts may not have symlink creation rights");
    return;
  }
  const context = await fixture(t);
  const body = "outside target\n";
  const target = path.join(context.root, "outside-target.json");
  writeFileSync(target, body, "utf8");
  const sha256 = digest(body);
  const link = path.join(context.config.paths.artifacts, `${sha256}.json`);
  await symlink(target, link);
  context.catalog.registerArtifact({
    sha256,
    schema: "fixture_raw_v1",
    filename: link,
    sizeBytes: Buffer.byteLength(body),
  });
  context.catalog.database.prepare("UPDATE artifacts SET created_at=? WHERE sha256=?")
    .run("2025-01-01T00:00:00.000Z", sha256);

  await assert.rejects(
    new PruneService(context.store, context.config).run({
      before: "2026-01-01T00:00:00Z",
      confirm: "PRUNE",
    }),
    /physically escapes owned storage|not a regular owned file/,
  );
  assert.equal(existsSync(target), true);
  assert.equal(existsSync(link), true);
  assert.ok(context.store.artifact(sha256));
});

test("recovery classifies a mixed operation before touching either file", async (t) => {
  const context = await fixture(t);
  const retained = addArtifact(context, { withObservation: false });
  const absentBody = "committed candidate\n";
  const absentSha = digest(absentBody);
  const operation = randomUUID();
  const directory = path.join(quarantineRoot(context.config), operation);
  mkdirSync(directory, { recursive: true });
  const retainedStaged = path.join(directory, `${retained.sha256}.artifact`);
  const absentStaged = path.join(directory, `${absentSha}.artifact`);
  await fsPromises.rename(retained.artifactPath, retainedStaged);
  writeFileSync(absentStaged, absentBody, "utf8");

  await assert.rejects(
    new PruneService(context.store, context.config).run({
      before: "2024-01-01T00:00:00Z",
    }),
    /mixed commit state/,
  );
  assert.equal(existsSync(retainedStaged), true);
  assert.equal(existsSync(absentStaged), true);
  assert.equal(existsSync(retained.artifactPath), false);
});

test("zero-candidate confirmed prune finalizes its audit and removes its marker", async (t) => {
  const context = await fixture(t);
  const result = await new PruneService(context.store, context.config).run({
    before: "2024-01-01T00:00:00Z",
    confirm: "PRUNE",
  });
  assert.equal(result.artifactCount, 0);
  assert.equal(result.cleanupPending, false);
  assert.equal(context.store.audit(result.auditId).result.cleanupPending, false);
  assert.deepEqual(quarantineEntries(context.config), []);
});
