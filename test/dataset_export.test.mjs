import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Catalog } from "../src/catalog.mjs";
import { exportDataset } from "../src/dataset_export.mjs";
import { DatasetReadStore } from "../src/dataset_read_store.mjs";

function catalogConfig(root) {
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
  const root = await mkdtemp(path.join(os.tmpdir(), "arena-evidence-export-"));
  const config = catalogConfig(root);
  const catalog = new Catalog(config);
  t.after(() => catalog.close());
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, config, catalog };
}

function addObservation(catalog, root, datasetId, jobId, index, recordedAt) {
  const raw = `${JSON.stringify({ index, recordedAt })}\n`;
  const sha256 = createHash("sha256").update(raw).digest("hex");
  const filename = path.join(root, "artifacts", `${sha256}.json`);
  mkdirSync(path.dirname(filename), { recursive: true });
  writeFileSync(filename, raw, "utf8");
  catalog.registerArtifact({
    sha256,
    schema: "fixture_raw_v1",
    filename,
    sizeBytes: Buffer.byteLength(raw),
  });
  const observationId = randomUUID();
  catalog.addObservation({
    schema: "uci_arena_observation_envelope_v1",
    observation_id: observationId,
    dataset_id: datasetId,
    job_id: jobId,
    shard_id: `shard-${index}`,
    recorded_at: recordedAt,
    adapter: "fixture",
    source_schema: "fixture_source_v1",
    raw_sha256: sha256,
    target_identity: { model_id: "fixture" },
    axes: { index },
    metrics: { score: index * 10 },
    outcome: { complete: true },
    resource: { interval_status: "finalized" },
    authority: { diagnostic: true, timing: false, strength: false },
  });
  return observationId;
}

function populatedDataset(catalog, root) {
  const datasetId = catalog.createDataset({
    campaign: "export-test",
    targetIdentity: { model_id: "fixture" },
  });
  const job = catalog.enqueueJob({
    adapter: "fixture",
    shardId: "fixture-shard",
    datasetId,
    fingerprint: "a".repeat(64),
    config: {},
  });
  const ids = [
    addObservation(catalog, root, datasetId, job.id, 2, "2026-01-01T00:00:02.000Z"),
    addObservation(catalog, root, datasetId, job.id, 0, "2026-01-01T00:00:00.000Z"),
    addObservation(catalog, root, datasetId, job.id, 1, "2026-01-01T00:00:01.000Z"),
  ];
  catalog.completeDataset(datasetId, {
    diagnostic: true,
    timing: false,
    strength: false,
    profile_publication: false,
  });
  return { datasetId, ids };
}

function fakeReadStore(root, summary, values) {
  return {
    filename: path.join(root, "catalog.sqlite"),
    async withDatasetSnapshot(datasetId, reader) {
      if (summary === null) return null;
      let index = 0;
      const iterator = {
        [Symbol.iterator]() { return this; },
        next() {
          if (index >= values.length) return { done: true, value: undefined };
          return { done: false, value: values[index++] };
        },
        return() {
          index = values.length;
          return { done: true, value: undefined };
        },
      };
      return reader({ ...summary, id: datasetId }, iterator);
    },
  };
}

function temporaryFiles(directory, destination) {
  const prefix = `${path.basename(destination)}.`;
  return readdirSync(directory).filter((name) => name.startsWith(prefix) && name.endsWith(".tmp"));
}

test("read store uses a read snapshot and a lazy statement iterator", async () => {
  const events = [];
  const summaryRow = {
    id: "dataset",
    schema: "uci_arena_evidence_dataset_v1",
    campaign: "fixture",
    state: "completed",
    target_identity_json: "{}",
    authority_json: "{}",
    observation_count: 1,
    created_at: "2026-01-01T00:00:00.000Z",
    completed_at: "2026-01-01T00:00:01.000Z",
  };
  const observationRow = {
    id: "observation",
    dataset_id: "dataset",
    job_id: "job",
    shard_id: "shard",
    recorded_at: "2026-01-01T00:00:00.000Z",
    adapter: "fixture",
    source_schema: "fixture_v1",
    raw_sha256: "b".repeat(64),
    target_identity_json: "{}",
    axes_json: "{}",
    metrics_json: "{}",
    outcome_json: "{}",
    resource_json: "{}",
    authority_json: "{}",
  };
  class FakeDatabase {
    constructor(filename, options) {
      events.push(["construct", filename, options.readOnly]);
    }
    exec(sql) { events.push(["exec", sql.trim()]); }
    prepare(sql) {
      events.push(["prepare", sql.includes("FROM observations") ? "observations" : "dataset"]);
      if (sql.includes("FROM observations")) {
        return {
          *iterate(datasetId) {
            events.push(["iterate", datasetId]);
            yield observationRow;
          },
        };
      }
      return {
        get(datasetId) {
          events.push(["get", datasetId]);
          return summaryRow;
        },
      };
    }
    close() { events.push(["close"]); }
  }

  const store = new DatasetReadStore("catalog.sqlite", { Database: FakeDatabase });
  const result = await store.withDatasetSnapshot("dataset", async (summary, observations) => ({
    summary,
    rows: [...observations],
  }));
  store.close();

  assert.equal(result.summary.observationCount, 1);
  assert.equal(result.rows[0].observation_id, "observation");
  assert.ok(events.some(([event, value]) => event === "iterate" && value === "dataset"));
  assert.ok(events.some(([event, value]) => event === "exec" && value === "BEGIN"));
  assert.ok(events.some(([event, value]) => event === "exec" && value === "COMMIT"));
  assert.equal(events.some(([event]) => event === "all"), false);
});

test("JSONL export preserves canonical observation order without Catalog.dataset", async (t) => {
  const { root, config, catalog } = await fixture(t);
  const { datasetId } = populatedDataset(catalog, root);
  catalog.dataset = () => { throw new Error("materializing Catalog.dataset must not be used"); };
  const readStore = new DatasetReadStore(config.paths.catalog);
  t.after(() => readStore.close());
  const destination = path.join(root, "exports", "evidence.jsonl");

  const result = await exportDataset(readStore, {
    datasetId,
    out: destination,
    format: "jsonl",
  });

  assert.equal(result.observations, 3);
  const rows = readFileSync(destination, "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(rows.map((row) => row.axes.index), [0, 1, 2]);
  assert.ok(rows.every((row) => row.schema === "uci_arena_observation_envelope_v1"));
});

test("JSON export preserves the dataset object and replaces a prior file only after completion", async (t) => {
  const { root, config, catalog } = await fixture(t);
  const { datasetId } = populatedDataset(catalog, root);
  const readStore = new DatasetReadStore(config.paths.catalog);
  t.after(() => readStore.close());
  const destination = path.join(root, "exports", "evidence.json");
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, "prior\n", "utf8");

  const result = await exportDataset(readStore, {
    datasetId,
    out: destination,
    format: "json",
  });

  assert.equal(result.observations, 3);
  const value = JSON.parse(readFileSync(destination, "utf8"));
  assert.equal(value.id, datasetId);
  assert.equal(value.observationCount, 3);
  assert.deepEqual(value.observations.map((row) => row.axes.index), [0, 1, 2]);
  assert.equal(temporaryFiles(path.dirname(destination), destination).length, 0);
});

test("export workflow accepts an iterator-only replacement read port", async (t) => {
  const { root } = await fixture(t);
  const destination = path.join(root, "iterator-only.jsonl");
  const values = Array.from({ length: 512 }, (_, index) => ({
    schema: "uci_arena_observation_envelope_v1",
    observation_id: `observation-${index}`,
    axes: { index },
  }));
  const readStore = fakeReadStore(root, {
    schema: "uci_arena_evidence_dataset_v1",
    campaign: "substitution",
    state: "completed",
    targetIdentity: {},
    authority: {},
    observationCount: values.length,
    createdAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:01.000Z",
  }, values);

  const result = await exportDataset(readStore, {
    datasetId: "replacement-dataset",
    out: destination,
    format: "jsonl",
  });

  assert.equal(result.observations, values.length);
  assert.equal(readFileSync(destination, "utf8").trim().split("\n").length, values.length);
});

test("count mismatch leaves a prior destination untouched and removes the temporary file", async (t) => {
  const { root } = await fixture(t);
  const destination = path.join(root, "count-mismatch.jsonl");
  writeFileSync(destination, "prior\n", "utf8");
  const readStore = fakeReadStore(root, {
    schema: "uci_arena_evidence_dataset_v1",
    campaign: "mismatch",
    state: "completed",
    targetIdentity: {},
    authority: {},
    observationCount: 2,
    createdAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:01.000Z",
  }, [{ schema: "uci_arena_observation_envelope_v1", observation_id: "only" }]);

  await assert.rejects(
    exportDataset(readStore, {
      datasetId: "dataset",
      out: destination,
      format: "jsonl",
    }),
    /count mismatch/,
  );
  assert.equal(readFileSync(destination, "utf8"), "prior\n");
  assert.equal(temporaryFiles(root, destination).length, 0);
});

test("rename failure cleans the exporter-owned temporary file", async (t) => {
  const { root } = await fixture(t);
  const destination = path.join(root, "existing-directory");
  mkdirSync(destination);
  const readStore = fakeReadStore(root, {
    schema: "uci_arena_evidence_dataset_v1",
    campaign: "rename-failure",
    state: "completed",
    targetIdentity: {},
    authority: {},
    observationCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:01.000Z",
  }, []);

  await assert.rejects(exportDataset(readStore, {
    datasetId: "dataset",
    out: destination,
    format: "jsonl",
  }));
  assert.equal(existsSync(destination), true);
  assert.equal(temporaryFiles(root, destination).length, 0);
});

test("missing datasets and protected catalog paths never create output", async (t) => {
  const { root, config } = await fixture(t);
  const missingDestination = path.join(root, "missing", "dataset.jsonl");
  const readStore = fakeReadStore(root, null, []);
  assert.equal(await exportDataset(readStore, {
    datasetId: "missing",
    out: missingDestination,
    format: "jsonl",
  }), null);
  assert.equal(existsSync(missingDestination), false);

  const realReadStore = new DatasetReadStore(config.paths.catalog);
  t.after(() => realReadStore.close());
  await assert.rejects(
    exportDataset(realReadStore, {
      datasetId: "missing",
      out: config.paths.catalog,
      format: "jsonl",
    }),
    /cannot replace the Evidence catalog/,
  );
});

test("malformed stored JSON fails visibly without publishing an output", async (t) => {
  const { root, config, catalog } = await fixture(t);
  const datasetId = catalog.createDataset({ campaign: "corrupt" });
  catalog.database.prepare("UPDATE datasets SET authority_json='{' WHERE id=?").run(datasetId);
  const readStore = new DatasetReadStore(config.paths.catalog);
  t.after(() => readStore.close());
  const destination = path.join(root, "corrupt.json");

  await assert.rejects(
    exportDataset(readStore, { datasetId, out: destination, format: "json" }),
    /contains invalid JSON/,
  );
  assert.equal(existsSync(destination), false);
});
