import assert from "node:assert/strict";
import test from "node:test";

import {
  cliCommandNames,
  parseCliArguments,
  parseIntegerFlag,
  parseJsonObjectFlag,
} from "../src/cli_contract.mjs";

const minimalInvocations = new Map([
  ["help", ["help"]],
  ["init", ["init"]],
  ["daemon", ["daemon"]],
  ["status", ["status"]],
  ["pause", ["pause"]],
  ["resume", ["resume"]],
  ["target add", [
    "target", "add",
    "--model-id", "model",
    "--model-root", "model-root",
    "--fingerprint", "123",
    "--engine", "engine",
    "--provider", "cpu",
  ]],
  ["target list", ["target", "list"]],
  ["target remove", ["target", "remove", "--id", "target-id"]],
  ["job enqueue", ["job", "enqueue", "--campaign", "first"]],
  ["job list", ["job", "list"]],
  ["job cancel", ["job", "cancel", "--id", "job-id"]],
  ["job retry", ["job", "retry", "--id", "job-id"]],
  ["dataset list", ["dataset", "list"]],
  ["dataset show", ["dataset", "show", "--id", "dataset-id"]],
  ["dataset export", [
    "dataset", "export", "--id", "dataset-id", "--out", "evidence.jsonl",
  ]],
  ["profile list", ["profile", "list"]],
  ["api describe", ["api", "describe"]],
  ["api status", ["api", "status"]],
  ["api outputs list", ["api", "outputs", "list"]],
  ["api outputs inspect", ["api", "outputs", "inspect", "--id", "output-id"]],
  ["api config validate", ["api", "config", "validate"]],
  ["api orchestration status", ["api", "orchestration", "status"]],
  ["api target register", [
    "api", "target", "register",
    "--model-id", "model",
    "--model-root", "model-root",
    "--model-fingerprint", "123",
    "--engine", "engine",
    "--provider", "cpu",
  ]],
  ["api campaign enqueue", ["api", "campaign", "enqueue"]],
  ["api job control", [
    "api", "job", "control", "--id", "job-id", "--action", "cancel",
  ]],
  ["prune", ["prune", "--before", "2026-01-01T00:00:00Z"]],
  ["startup install", ["startup", "install"]],
  ["startup status", ["startup", "status"]],
  ["startup uninstall", ["startup", "uninstall"]],
]);

test("every declared command has a minimal valid invocation", () => {
  assert.deepEqual([...minimalInvocations.keys()], [...cliCommandNames]);
  for (const [expected, argv] of minimalInvocations) {
    const parsed = parseCliArguments(argv);
    assert.equal(parsed.command, expected);
    assert.equal(parsed.help, expected === "help");
  }
});

test("global options may appear around a command exactly once", () => {
  const parsed = parseCliArguments([
    "--workspace", "workspace",
    "status",
    "--json",
    "--config", "config.json",
  ]);
  assert.equal(parsed.command, "status");
  assert.equal(parsed.globals.workspace, "workspace");
  assert.equal(parsed.globals.config, "config.json");
  assert.equal(parsed.flags.json, true);
});

test("help is available without configuration and cannot bypass command syntax", () => {
  assert.equal(parseCliArguments(["--help"]).help, true);
  assert.equal(parseCliArguments(["help"]).help, true);
  assert.deepEqual(
    parseCliArguments(["target", "add", "--help"]).command,
    "target add",
  );
  assert.throws(
    () => parseCliArguments(["--help", "--once"]),
    /help does not accept --once/,
  );
  assert.throws(
    () => parseCliArguments(["target", "add", "--help", "--provider", "cpu"]),
    /help does not accept --provider/,
  );
  assert.throws(
    () => parseCliArguments(["not-a-command", "--help"]),
    /unknown command: not-a-command/,
  );
});

test("unknown commands, extra positionals, and command-specific flags fail closed", () => {
  assert.throws(() => parseCliArguments(["unknown"]), /unknown command: unknown/);
  assert.throws(() => parseCliArguments(["status", "extra"]), /unknown command: status extra/);
  assert.throws(
    () => parseCliArguments(["init", "--json"]),
    /command init does not accept --json/,
  );
  assert.throws(
    () => parseCliArguments(["status", "--unknown", "value"]),
    /command status does not accept --unknown/,
  );
});

test("duplicates, missing values, flag-shaped values, and equals form fail closed", () => {
  assert.throws(
    () => parseCliArguments(["status", "--json", "--json"]),
    /duplicate flag --json/,
  );
  assert.throws(
    () => parseCliArguments([
      "status", "--workspace", "one", "--workspace", "two",
    ]),
    /duplicate global option --workspace/,
  );
  assert.throws(
    () => parseCliArguments(["target", "remove", "--id"]),
    /--id requires one non-empty value/,
  );
  assert.throws(
    () => parseCliArguments(["target", "remove", "--id", "--json"]),
    /--id requires one non-empty value/,
  );
  assert.throws(
    () => parseCliArguments(["pause", "--reason", ""]),
    /argument 3 must not be empty/,
  );
  assert.throws(
    () => parseCliArguments(["status", "--workspace=one"]),
    /equals-form flags are unsupported/,
  );
});

test("job enqueue modes have one authority each", () => {
  const manual = parseCliArguments([
    "job", "enqueue", "--adapter", "paired_sprt", "--shard", "one",
  ]);
  assert.equal(manual.flags.adapter, "paired_sprt");
  assert.throws(
    () => parseCliArguments([
      "job", "enqueue", "--campaign", "first", "--adapter", "paired_sprt",
    ]),
    /campaign mode does not accept --adapter/,
  );
  assert.throws(
    () => parseCliArguments(["job", "enqueue", "--campaign", "other"]),
    /--campaign must be exactly first/,
  );
  assert.throws(
    () => parseCliArguments(["job", "enqueue", "--adapter", "paired_sprt"]),
    /manual mode requires --shard/,
  );
});

test("small enumerations reject unsupported values", () => {
  assert.throws(
    () => parseCliArguments(["job", "list", "--state", "sleeping"]),
    /--state is invalid/,
  );
  assert.throws(
    () => parseCliArguments([
      "dataset", "export", "--id", "id", "--out", "out", "--format", "csv",
    ]),
    /--format must be json or jsonl/,
  );
  assert.throws(
    () => parseCliArguments([
      "api", "job", "control", "--id", "id", "--action", "delete",
    ]),
    /--action must be cancel or retry/,
  );
});

test("integer flags require complete bounded decimal tokens", () => {
  assert.equal(parseIntegerFlag({ priority: "-12" }, "priority"), -12);
  assert.equal(parseIntegerFlag({}, "priority", { defaultValue: 7 }), 7);
  assert.throws(
    () => parseIntegerFlag({ priority: "12junk" }, "priority"),
    /complete decimal integer/,
  );
  assert.throws(
    () => parseIntegerFlag({ priority: "1000001" }, "priority"),
    /must be in -1000000\.\.1000000/,
  );
});

test("JSON flags accept one bounded object only", () => {
  assert.deepEqual(
    parseJsonObjectFlag({ "config-json": '{"campaign":"manual"}' }, "config-json"),
    { campaign: "manual" },
  );
  assert.deepEqual(parseJsonObjectFlag({}, "config-json"), {});
  for (const value of ["[]", "null", '"value"', "17"]) {
    assert.throws(
      () => parseJsonObjectFlag({ "config-json": value }, "config-json"),
      /must contain one JSON object/,
    );
  }
  assert.throws(
    () => parseJsonObjectFlag({ "config-json": "{" }, "config-json"),
    /is not valid JSON/,
  );
  const oversized = `{"value":"${"x".repeat(65_536)}"}`;
  assert.throws(
    () => parseJsonObjectFlag({ "config-json": oversized }, "config-json"),
    /exceeds 65536 bytes/,
  );
});

test("argument count and byte budgets are bounded before command dispatch", () => {
  assert.throws(
    () => parseCliArguments(Array.from({ length: 129 }, () => "x")),
    /at most 128 arguments/,
  );
  assert.throws(
    () => parseCliArguments(["status", "x".repeat(65_537)]),
    /argument 2 exceeds 65536 bytes/,
  );
  assert.throws(
    () => parseCliArguments(Array.from({ length: 17 }, () => "x".repeat(65_536))),
    /arguments exceed 1048576 bytes in total/,
  );
});
