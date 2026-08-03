import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import test from "node:test";

import { showDataset } from "../src/dataset_show.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "arena-evidence-show-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function fakeReadStore(root, summary, values, { failBeforeRead = null } = {}) {
  return {
    filename: path.join(root, "catalog.sqlite"),
    async withDatasetSnapshot(datasetId, reader) {
      if (failBeforeRead) throw failBeforeRead;
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

class CollectingWritable extends Writable {
  constructor({ failAtWrite = null } = {}) {
    super();
    this.chunks = [];
    this.writeCount = 0;
    this.failAtWrite = failAtWrite;
    this.maximumChunkBytes = 0;
  }

  _write(chunk, encoding, callback) {
    ++this.writeCount;
    this.maximumChunkBytes = Math.max(this.maximumChunkBytes, chunk.length);
    if (this.failAtWrite === this.writeCount) {
      callback(new Error("downstream write failed"));
      return;
    }
    this.chunks.push(Buffer.from(chunk));
    callback();
  }

  text() {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

function summary(observationCount) {
  return {
    schema: "uci_arena_evidence_dataset_v1",
    campaign: "show-test",
    state: "completed",
    targetIdentity: { model_id: "fixture" },
    authority: { diagnostic: true },
    observationCount,
    createdAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:01.000Z",
  };
}

function spoolFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter((name) => name.startsWith(".dataset-show-"));
}

test("dataset show preserves the complete JSON document and does not end stdout", async (t) => {
  const root = await fixture(t);
  const spoolDirectory = path.join(root, "exports");
  const observations = [
    {
      schema: "uci_arena_observation_envelope_v1",
      observation_id: "one",
      recorded_at: "2026-01-01T00:00:00.000Z",
      axes: { index: 0 },
    },
    {
      schema: "uci_arena_observation_envelope_v1",
      observation_id: "two",
      recorded_at: "2026-01-01T00:00:01.000Z",
      axes: { index: 1 },
    },
  ];
  const readStore = fakeReadStore(root, summary(observations.length), observations);
  const writable = new CollectingWritable();

  const result = await showDataset(readStore, {
    datasetId: "dataset",
    spoolDirectory,
    writable,
  });

  const value = JSON.parse(writable.text());
  assert.equal(result.datasetId, "dataset");
  assert.equal(result.observations, observations.length);
  assert.equal(value.id, "dataset");
  assert.deepEqual(value.observations.map((row) => row.observation_id), ["one", "two"]);
  assert.equal(writable.writableEnded, false);
  assert.equal(spoolFiles(spoolDirectory).length, 0);
});

test("dataset show streams bounded file chunks", async (t) => {
  const root = await fixture(t);
  const spoolDirectory = path.join(root, "exports");
  const observations = Array.from({ length: 512 }, (_, index) => ({
    schema: "uci_arena_observation_envelope_v1",
    observation_id: `observation-${index}`,
    metrics: { payload: "x".repeat(1024) },
  }));
  const readStore = fakeReadStore(root, summary(observations.length), observations);
  const writable = new CollectingWritable();

  await showDataset(readStore, {
    datasetId: "large",
    spoolDirectory,
    writable,
  });

  assert.ok(writable.writeCount > 1);
  assert.ok(writable.maximumChunkBytes <= 64 * 1024);
  assert.equal(JSON.parse(writable.text()).observations.length, observations.length);
  assert.equal(spoolFiles(spoolDirectory).length, 0);
});

test("missing datasets and pre-validation failures emit no bytes", async (t) => {
  const root = await fixture(t);
  const spoolDirectory = path.join(root, "exports");
  const missingWritable = new CollectingWritable();
  const missing = await showDataset(fakeReadStore(root, null, []), {
    datasetId: "missing",
    spoolDirectory,
    writable: missingWritable,
  });
  assert.equal(missing, null);
  assert.equal(missingWritable.text(), "");

  const corruptWritable = new CollectingWritable();
  await assert.rejects(
    showDataset(fakeReadStore(root, summary(1), [], {
      failBeforeRead: new Error("catalog JSON is corrupt"),
    }), {
      datasetId: "corrupt",
      spoolDirectory,
      writable: corruptWritable,
    }),
    /catalog JSON is corrupt/,
  );
  assert.equal(corruptWritable.text(), "");

  const mismatchWritable = new CollectingWritable();
  await assert.rejects(
    showDataset(fakeReadStore(root, summary(2), [
      { schema: "uci_arena_observation_envelope_v1", observation_id: "only" },
    ]), {
      datasetId: "mismatch",
      spoolDirectory,
      writable: mismatchWritable,
    }),
    /count mismatch/,
  );
  assert.equal(mismatchWritable.text(), "");
  assert.equal(spoolFiles(spoolDirectory).length, 0);
});

test("downstream write failure remains visible and removes the spool", async (t) => {
  const root = await fixture(t);
  const spoolDirectory = path.join(root, "exports");
  const observations = Array.from({ length: 128 }, (_, index) => ({
    schema: "uci_arena_observation_envelope_v1",
    observation_id: `observation-${index}`,
    metrics: { payload: "x".repeat(1024) },
  }));
  const writable = new CollectingWritable({ failAtWrite: 2 });

  await assert.rejects(
    showDataset(fakeReadStore(root, summary(observations.length), observations), {
      datasetId: "broken-pipe",
      spoolDirectory,
      writable,
    }),
    /downstream write failed/,
  );
  assert.equal(writable.writableEnded, false);
  assert.equal(spoolFiles(spoolDirectory).length, 0);
});
