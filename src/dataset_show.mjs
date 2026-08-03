import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import { exportDataset } from "./dataset_export.mjs";

function assertWritable(writable) {
  if (!writable
      || typeof writable.write !== "function"
      || typeof writable.once !== "function"
      || typeof writable.removeListener !== "function") {
    throw new Error("dataset show requires a Node writable stream");
  }
}

function writeChunk(writable, chunk) {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const settle = (error) => {
      if (settled) return;
      settled = true;
      writable.removeListener("error", onError);
      if (error) rejectPromise(error);
      else resolvePromise();
    };
    const onError = (error) => settle(error);
    writable.once("error", onError);
    try {
      writable.write(chunk, (error) => settle(error ?? null));
    } catch (error) {
      settle(error);
    }
  });
}

export async function showDataset(
  readStore,
  {
    datasetId,
    spoolDirectory,
    writable = process.stdout,
  },
) {
  assertWritable(writable);
  if (typeof spoolDirectory !== "string" || !spoolDirectory.trim()) {
    throw new Error("dataset show requires a spool directory");
  }
  const directory = path.resolve(spoolDirectory);
  await mkdir(directory, { recursive: true });
  const spool = path.join(
    directory,
    `.dataset-show-${process.pid}-${randomUUID()}.json`,
  );
  try {
    const result = await exportDataset(readStore, {
      datasetId,
      out: spool,
      format: "json",
    });
    if (result === null) return null;
    const source = createReadStream(spool);
    for await (const chunk of source) await writeChunk(writable, chunk);
    return {
      datasetId: result.datasetId,
      observations: result.observations,
    };
  } finally {
    await rm(spool, { force: true }).catch(() => {});
  }
}
