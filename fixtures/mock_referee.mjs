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

function state(extra = {}) {
  process.stdout.write(`${JSON.stringify({
    ok: true,
    terminal: false,
    reason: "ongoing",
    result: "*",
    side_to_move: moves.length % 2 === 0 ? "white" : "black",
    halfmove_clock: 0,
    fullmove_number: Math.floor(moves.length / 2) + 1,
    repetition_count: 1,
    fen: "fixture",
    ...extra,
  })}\n`);
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (raw) => {
  const line = raw.trim();
  if (line === "reset") {
    moves = [];
    state();
  } else if (line === "state") {
    state();
  } else if (line.startsWith("move ")) {
    const move = line.slice(5);
    if (move !== LEGAL_LINE[moves.length]) {
      process.stdout.write(`${JSON.stringify({
        ok: false,
        error: "illegal_move",
        detail: move,
      })}\n`);
      return;
    }
    moves.push(move);
    state({ applied_move: move });
  } else if (line === "quit") {
    input.close();
    process.exit(0);
  } else {
    process.stdout.write(`${JSON.stringify({ ok: false, error: "unknown_command" })}\n`);
  }
});
