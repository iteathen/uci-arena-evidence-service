const MAX_ARGUMENT_COUNT = 128;
const MAX_ARGUMENT_BYTES = 65_536;
const MAX_TOTAL_ARGUMENT_BYTES = 1_048_576;
const MAX_JSON_FLAG_BYTES = 65_536;
const FLAG_NAME = /^[a-z0-9][a-z0-9-]*$/u;
const GLOBAL_VALUE_FLAGS = new Set(["workspace", "config"]);
const GLOBAL_BOOLEAN_FLAGS = new Set(["help"]);
const BOOLEAN_FLAGS = new Set(["once", "json"]);

const JOB_STATES = new Set([
  "queued",
  "waiting_for_target",
  "waiting_for_resources",
  "running",
  "completed",
  "failed",
  "cancelled",
]);

const COMMANDS = new Map([
  ["init", { flags: [] }],
  ["daemon", { flags: ["once"] }],
  ["status", { flags: ["json"] }],
  ["pause", { flags: ["reason"] }],
  ["resume", { flags: [] }],
  ["target add", {
    flags: [
      "model-id",
      "model-root",
      "fingerprint",
      "engine",
      "provider",
      "label",
      "hardware-fingerprint",
      "uci-options-json",
    ],
    required: ["model-id", "model-root", "fingerprint", "engine", "provider"],
  }],
  ["target list", { flags: ["json"] }],
  ["target remove", { flags: ["id"], required: ["id"] }],
  ["job enqueue", {
    flags: ["campaign", "target", "adapter", "shard", "config-json", "priority"],
  }],
  ["job list", { flags: ["state", "json"] }],
  ["job cancel", { flags: ["id"], required: ["id"] }],
  ["job retry", { flags: ["id"], required: ["id"] }],
  ["dataset list", { flags: ["json"] }],
  ["dataset show", { flags: ["id"], required: ["id"] }],
  ["dataset export", { flags: ["id", "out", "format"], required: ["id", "out"] }],
  ["profile list", { flags: ["json"] }],
  ["api describe", { flags: [] }],
  ["api status", { flags: [] }],
  ["api outputs list", { flags: ["cursor"] }],
  ["api outputs inspect", { flags: ["id"], required: ["id"] }],
  ["api config validate", { flags: [] }],
  ["api orchestration status", { flags: [] }],
  ["api target register", {
    flags: [
      "model-id",
      "model-root",
      "model-fingerprint",
      "engine",
      "provider",
      "provider-fingerprint",
      "uci-options-json",
      "label",
    ],
    required: ["model-id", "model-root", "model-fingerprint", "engine", "provider"],
  }],
  ["api campaign enqueue", { flags: ["target"] }],
  ["api job control", { flags: ["id", "action"], required: ["id", "action"] }],
  ["prune", { flags: ["before", "confirm"], required: ["before"] }],
  ["startup install", { flags: [] }],
  ["startup status", { flags: [] }],
  ["startup uninstall", { flags: [] }],
]);

function own(object, name) {
  return Object.hasOwn(object, name);
}

function boundedToken(value, index) {
  if (typeof value !== "string") throw new Error(`argument ${index + 1} must be text`);
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes === 0) throw new Error(`argument ${index + 1} must not be empty`);
  if (bytes > MAX_ARGUMENT_BYTES) {
    throw new Error(`argument ${index + 1} exceeds ${MAX_ARGUMENT_BYTES} bytes`);
  }
  if (value.includes("\0")) throw new Error(`argument ${index + 1} contains NUL`);
  return bytes;
}

function takeValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`--${flag} requires one non-empty value`);
  }
  return value;
}

function setOnce(object, name, value, kind = "flag") {
  if (own(object, name)) throw new Error(`duplicate ${kind} --${name}`);
  object[name] = value;
}

function validateDefinition(command, flags) {
  const definition = COMMANDS.get(command);
  if (!definition) throw new Error(`unknown command: ${command}`);
  const allowed = new Set(definition.flags);
  for (const name of Object.keys(flags)) {
    if (!allowed.has(name)) throw new Error(`command ${command} does not accept --${name}`);
  }
  for (const name of definition.required ?? []) {
    if (!own(flags, name)) throw new Error(`command ${command} requires --${name}`);
  }

  if (command === "job enqueue") {
    if (own(flags, "campaign")) {
      if (flags.campaign !== "first") {
        throw new Error("job enqueue --campaign must be exactly first");
      }
      for (const name of ["adapter", "shard", "config-json", "priority"]) {
        if (own(flags, name)) {
          throw new Error(`job enqueue campaign mode does not accept --${name}`);
        }
      }
    } else {
      for (const name of ["adapter", "shard"]) {
        if (!own(flags, name)) throw new Error(`job enqueue manual mode requires --${name}`);
      }
    }
  }

  if (command === "job list" && own(flags, "state") && !JOB_STATES.has(flags.state)) {
    throw new Error(`job list --state is invalid: ${flags.state}`);
  }
  if (command === "dataset export" && own(flags, "format")
      && !new Set(["json", "jsonl"]).has(flags.format)) {
    throw new Error("dataset export --format must be json or jsonl");
  }
  if (command === "api job control" && !new Set(["cancel", "retry"]).has(flags.action)) {
    throw new Error("api job control --action must be cancel or retry");
  }
}

export function parseCliArguments(argv) {
  if (!Array.isArray(argv)) throw new Error("CLI arguments must be an array");
  if (argv.length > MAX_ARGUMENT_COUNT) {
    throw new Error(`CLI accepts at most ${MAX_ARGUMENT_COUNT} arguments`);
  }
  let totalBytes = 0;
  for (let index = 0; index < argv.length; ++index) {
    totalBytes += boundedToken(argv[index], index);
  }
  if (totalBytes > MAX_TOTAL_ARGUMENT_BYTES) {
    throw new Error(`CLI arguments exceed ${MAX_TOTAL_ARGUMENT_BYTES} bytes in total`);
  }

  const globals = Object.create(null);
  const flags = Object.create(null);
  const positional = [];
  for (let index = 0; index < argv.length; ++index) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    if (token.includes("=")) throw new Error(`equals-form flags are unsupported: ${token}`);
    const name = token.slice(2);
    if (!FLAG_NAME.test(name)) throw new Error(`invalid flag name: ${token}`);
    if (GLOBAL_BOOLEAN_FLAGS.has(name)) {
      setOnce(globals, name, true, "global flag");
      continue;
    }
    if (GLOBAL_VALUE_FLAGS.has(name)) {
      const value = takeValue(argv, index, name);
      setOnce(globals, name, value, "global option");
      ++index;
      continue;
    }
    if (BOOLEAN_FLAGS.has(name)) {
      setOnce(flags, name, true);
      continue;
    }
    const value = takeValue(argv, index, name);
    setOnce(flags, name, value);
    ++index;
  }

  if (positional.length === 0) {
    if (globals.help) return { help: true, command: null, globals, flags };
    throw new Error("a command is required");
  }
  const command = positional.join(" ");
  if (!COMMANDS.has(command)) {
    if (globals.help) return { help: true, command: null, globals, flags };
    throw new Error(`unknown command: ${command}`);
  }
  validateDefinition(command, flags);
  return {
    help: Boolean(globals.help),
    command,
    globals,
    flags,
  };
}

export function parseJsonObjectFlag(flags, name, { defaultValue = {} } = {}) {
  if (!own(flags, name)) return defaultValue;
  const text = flags[name];
  if (Buffer.byteLength(text, "utf8") > MAX_JSON_FLAG_BYTES) {
    throw new Error(`--${name} exceeds ${MAX_JSON_FLAG_BYTES} bytes`);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`--${name} is not valid JSON: ${error.message}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`--${name} must contain one JSON object`);
  }
  return value;
}

export function parseIntegerFlag(
  flags,
  name,
  { defaultValue = 0, minimum = -1_000_000, maximum = 1_000_000 } = {},
) {
  if (!own(flags, name)) return defaultValue;
  const text = flags[name];
  if (!/^-?\d+$/u.test(text)) throw new Error(`--${name} must be a complete decimal integer`);
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`--${name} must be in ${minimum}..${maximum}`);
  }
  return value;
}

export const cliCommandNames = Object.freeze([...COMMANDS.keys()]);
