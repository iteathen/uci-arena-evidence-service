#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { isAllowedAdapter } from "./adapters.mjs";
import { Catalog } from "./catalog.mjs";
import { enqueueFirstCampaign, jobFingerprint } from "./campaign.mjs";
import { loadConfig } from "./config.mjs";
import { runDaemon } from "./daemon.mjs";
import { sha256File } from "./identity.mjs";
import {
  apiError,
  controlJobApi,
  describeApi,
  enqueueCampaignApi,
  inspectOutputApi,
  listOutputsApi,
  orchestrationStatusApi,
  statusApi,
  validateConfigApi,
} from "./manager_api.mjs";
import { listQualifiedProfiles } from "./profiles.mjs";
import {
  installStartup,
  startupStatus,
  uninstallStartup,
} from "./platform_startup.mjs";

function takeGlobalOptions(argv) {
  const remaining = [];
  const options = {};
  for (let index = 0; index < argv.length; ++index) {
    const value = argv[index];
    if (value === "--workspace" || value === "--config") {
      if (argv[index + 1] === undefined) throw new Error(`${value} requires a value`);
      options[value.slice(2)] = argv[++index];
    } else {
      remaining.push(value);
    }
  }
  return { remaining, options };
}

function parseFlags(argv) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < argv.length; ++index) {
    const value = argv[index];
    if (!value.startsWith("--")) {
      positional.push(value);
      continue;
    }
    const name = value.slice(2);
    if (new Set(["once", "json", "help"]).has(name)) {
      flags[name] = true;
      continue;
    }
    if (argv[index + 1] === undefined) throw new Error(`${value} requires a value`);
    flags[name] = argv[++index];
  }
  return { positional, flags };
}

function output(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function writeAtomic(filename, body) {
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, body, { encoding: "utf8", flag: "wx" });
  try {
    await rename(temporary, filename);
  } finally {
    await rm(temporary, { force: true });
  }
}

function usage() {
  return `Usage:
  arena-evidence init [--workspace PATH]
  arena-evidence daemon [--once]
  arena-evidence status [--json]
  arena-evidence pause [--reason TEXT]
  arena-evidence resume
  arena-evidence target add --model-id ID --model-root PATH --fingerprint N --engine PATH --provider NAME
  arena-evidence target list
  arena-evidence target remove --id UUID
  arena-evidence job enqueue --campaign first [--target UUID]
  arena-evidence job enqueue --adapter NAME --shard ID [--target UUID] [--config-json JSON]
  arena-evidence job list [--state STATE]
  arena-evidence job cancel|retry --id UUID
  arena-evidence dataset list
  arena-evidence dataset show --id UUID
  arena-evidence dataset export --id UUID --out PATH [--format json|jsonl]
  arena-evidence profile list
  arena-evidence api describe|status
  arena-evidence api outputs list [--cursor SHA256]
  arena-evidence api outputs inspect --id OUTPUT_ID
  arena-evidence api config validate
  arena-evidence api orchestration status
  arena-evidence api campaign enqueue [--target UUID]
  arena-evidence api job control --id UUID --action cancel|retry
  arena-evidence prune --before ISO_TIMESTAMP [--confirm PRUNE]
  arena-evidence startup install|status|uninstall

Global options: --workspace PATH --config FILE`;
}

async function main(argv = process.argv.slice(2)) {
  const { remaining, options } = takeGlobalOptions(argv);
  const { positional, flags } = parseFlags(remaining);
  if (positional.length === 0 || positional[0] === "help" || flags.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  const config = await loadConfig({ configFile: options.config, workspace: options.workspace });
  await mkdir(config.workspace, { recursive: true });
  const catalog = new Catalog(config);
  try {
    const [command, subcommand] = positional;
    if (command === "api" && subcommand === "describe") {
      output(describeApi());
    } else if (command === "api" && subcommand === "status") {
      output(statusApi(catalog));
    } else if (command === "api" && subcommand === "outputs"
        && positional[2] === "list") {
      output(listOutputsApi(catalog, config, flags.cursor || ""));
    } else if (command === "api" && subcommand === "outputs"
        && positional[2] === "inspect") {
      if (!flags.id) throw new Error("api outputs inspect requires --id");
      output(inspectOutputApi(catalog, config, flags.id));
    } else if (command === "api" && subcommand === "config"
        && positional[2] === "validate") {
      output(validateConfigApi(config));
    } else if (command === "api" && subcommand === "orchestration"
        && positional[2] === "status") {
      output(orchestrationStatusApi(catalog));
    } else if (command === "api" && subcommand === "campaign"
        && positional[2] === "enqueue") {
      output(enqueueCampaignApi(catalog, flags.target || null));
    } else if (command === "api" && subcommand === "job"
        && positional[2] === "control") {
      if (!flags.id || !flags.action) {
        throw new Error("api job control requires --id and --action");
      }
      output(controlJobApi(catalog, flags.id, flags.action));
    } else if (command === "init") {
      output({ schema: "uci_arena_evidence_init_v1", workspace: config.workspace, status: catalog.status() });
    } else if (command === "daemon") {
      output(await runDaemon(catalog, config, { once: Boolean(flags.once) }));
    } else if (command === "status") {
      output(catalog.status());
    } else if (command === "pause") {
      output(catalog.setPaused(true, flags.reason || "operator pause"));
    } else if (command === "resume") {
      output(catalog.setPaused(false));
    } else if (command === "target" && subcommand === "add") {
      const required = ["model-id", "model-root", "fingerprint", "engine", "provider"];
      for (const name of required) if (!flags[name]) throw new Error(`target add requires --${name}`);
      if (!existsSync(flags.engine)) throw new Error(`engine is missing: ${flags.engine}`);
      if (!existsSync(flags["model-root"])) throw new Error(`model root is missing: ${flags["model-root"]}`);
      output(catalog.addTarget({
        label: flags.label || flags["model-id"],
        modelId: flags["model-id"],
        modelRoot: flags["model-root"],
        modelFingerprint: flags.fingerprint,
        enginePath: flags.engine,
        engineSha256: sha256File(flags.engine),
        provider: flags.provider,
        hardwareDriverFingerprint: flags["hardware-fingerprint"] || "",
        uciOptions: flags["uci-options-json"] ? JSON.parse(flags["uci-options-json"]) : {},
      }));
    } else if (command === "target" && subcommand === "list") {
      output(catalog.targets());
    } else if (command === "target" && subcommand === "remove") {
      if (!flags.id) throw new Error("target remove requires --id");
      output({ removed: catalog.removeTarget(flags.id), id: flags.id });
    } else if (command === "job" && subcommand === "enqueue") {
      if (flags.campaign === "first") {
        if (flags.target && !catalog.target(flags.target)) {
          throw new Error(`unknown target ${flags.target}`);
        }
        const jobs = enqueueFirstCampaign(catalog, { targetId: flags.target || null });
        output({ campaign: "time_control_curve_v1", jobs });
      } else {
        if (!flags.adapter || !flags.shard) {
          throw new Error("job enqueue requires --adapter and --shard");
        }
        if (!isAllowedAdapter(flags.adapter)) {
          throw new Error(`adapter ${flags.adapter} is not allow-listed`);
        }
        if (flags.target && !catalog.target(flags.target)) {
          throw new Error(`unknown target ${flags.target}`);
        }
        const value = flags["config-json"] ? JSON.parse(flags["config-json"]) : {};
        const fingerprint = jobFingerprint({
          adapter: flags.adapter,
          target: flags.target || "active",
          shard: flags.shard,
          config: value,
        });
        const existing = catalog.jobByFingerprint(fingerprint);
        if (existing) {
          output(existing);
          return 0;
        }
        const datasetId = catalog.createDataset({
          campaign: value.campaign || "manual",
          targetIdentity: flags.target
            ? { target_id: flags.target }
            : { source: "active_model_pointer" },
        });
        output(catalog.enqueueJob({
          adapter: flags.adapter,
          targetId: flags.target || null,
          shardId: flags.shard,
          datasetId,
          priority: Number.parseInt(flags.priority ?? "0", 10),
          config: value,
          fingerprint,
        }));
      }
    } else if (command === "job" && subcommand === "list") {
      output(catalog.jobs({ state: flags.state }));
    } else if (command === "job" && subcommand === "cancel") {
      if (!flags.id) throw new Error("job cancel requires --id");
      output(catalog.cancelJob(flags.id));
    } else if (command === "job" && subcommand === "retry") {
      if (!flags.id) throw new Error("job retry requires --id");
      output(catalog.retryJob(flags.id));
    } else if (command === "dataset" && subcommand === "list") {
      output(catalog.datasets());
    } else if (command === "profile" && subcommand === "list") {
      output(listQualifiedProfiles(config, catalog));
    } else if (command === "dataset" && subcommand === "show") {
      if (!flags.id) throw new Error("dataset show requires --id");
      const dataset = catalog.dataset(flags.id);
      if (!dataset) throw new Error(`unknown dataset ${flags.id}`);
      output(dataset);
    } else if (command === "dataset" && subcommand === "export") {
      if (!flags.id || !flags.out) throw new Error("dataset export requires --id and --out");
      const dataset = catalog.dataset(flags.id);
      if (!dataset) throw new Error(`unknown dataset ${flags.id}`);
      const format = flags.format || "jsonl";
      if (!new Set(["json", "jsonl"]).has(format)) throw new Error("export format must be json or jsonl");
      const filename = path.resolve(flags.out);
      await mkdir(path.dirname(filename), { recursive: true });
      const body = format === "json"
        ? `${JSON.stringify(dataset, null, 2)}\n`
        : `${dataset.observations.map((row) => JSON.stringify(row)).join("\n")}\n`;
      await writeAtomic(filename, body);
      output({ datasetId: flags.id, format, filename, observations: dataset.observations.length });
    } else if (command === "prune") {
      if (!flags.before) throw new Error("prune requires --before");
      output(catalog.prune({ before: flags.before, confirm: flags.confirm || "" }));
    } else if (command === "startup" && subcommand === "install") {
      output(await installStartup(config));
    } else if (command === "startup" && subcommand === "status") {
      output(await startupStatus(config));
    } else if (command === "startup" && subcommand === "uninstall") {
      output(await uninstallStartup(config));
    } else {
      throw new Error(`unknown command: ${positional.join(" ")}\n${usage()}`);
    }
    return 0;
  } finally {
    catalog.close();
  }
}

main().then(
  (code) => { process.exitCode = code; },
  (error) => {
    const apiOperation = process.argv.includes("api")
      ? process.argv.slice(process.argv.indexOf("api") + 1, process.argv.indexOf("api") + 4)
        .filter((value) => value && !value.startsWith("--"))
        .join("_")
      : null;
    process.stderr.write(apiOperation
      ? `${JSON.stringify(apiError(apiOperation, error), null, 2)}\n`
      : `arena evidence service failed: ${error?.stack ?? error}\n`);
    process.exitCode = 1;
  },
);
