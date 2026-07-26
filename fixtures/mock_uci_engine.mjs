#!/usr/bin/env node

import readline from "node:readline";

const LEGAL_LINE = [
  "e2e4",
  "e7e5",
  "g1f3",
  "b8c6",
  "f1b5",
  "a7a6",
  "b5a4",
  "g8f6",
];

let moves = [];

function output(line) {
  process.stdout.write(`${line}\n`);
}

const input = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

input.on("line", (raw) => {
  const line = raw.trim();
  if (line === "uci") {
    output("id name Arena Evidence Mock UCI");
    output("id author OpenAI");
    for (const option of [
      "SearchCore",
      "Threads",
      "RootWorkers",
      "V2SplitDepth",
      "BackgroundSearch",
      "OnnxProvider",
      "NNBatchSize",
      "NNBatchWaitUs",
      "NNSpeculation",
      "ModelRoot",
      "TimePolicy",
      "Hash",
      "Ponder",
    ]) {
      output(`option name ${option} type string default mock`);
    }
    output("uciok");
  } else if (line === "isready") {
    output("readyok");
  } else if (line === "ucinewgame") {
    moves = [];
  } else if (line.startsWith("position startpos")) {
    const marker = " moves ";
    const index = line.indexOf(marker);
    moves = index < 0 ? [] : line.slice(index + marker.length).trim().split(/\s+/);
  } else if (line.startsWith("go ")) {
    const move = LEGAL_LINE[moves.length] ?? "0000";
    output(
      "info depth 8 seldepth 10 nodes 1000 nps 100000 time 10 score cp 0 "
      + "time_limit_ms 25 time_deadline_overshoot_ms 0 "
      + "evaluation_service_provider_batches 1 evaluation_service_provider_rows 1 "
      + "evaluation_service_provider_service_ns 1000",
    );
    output(`bestmove ${move}`);
  } else if (line === "runtime_status") {
    output(`info string runtime_status_v1 ${JSON.stringify({
      schema: "uci_runtime_status_v1",
      model_id: process.env.UCI_ARENA_MODEL_ID ?? "mock",
      model_fingerprint: process.env.UCI_ARENA_MODEL_FINGERPRINT ?? "1",
      provider_effective: process.env.UCI_ARENA_ONNX_PROVIDER ?? "cpu",
    })}`);
  } else if (line === "quit") {
    input.close();
    process.exit(0);
  }
});
