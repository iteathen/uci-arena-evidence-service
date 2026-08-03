#!/usr/bin/env node

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { isAllowedAdapter } from "./adapters.mjs";
import { Catalog } from "./catalog.mjs";
import { enqueueFirstCampaign, jobFingerprint } from "./campaign.mjs";
import {
  parseCliArguments,
  parseIntegerFlag,
  parseJsonObjectFlag,
} from "./cli_contract.mjs";
import { loadConfig } from "./config.mjs";
import { runDaemon } from "./daemon.mjs";
import { exportDataset } from "./dataset_export.mjs";
import { DatasetReadStore } from "./dataset_read_store.mjs";
import { sha256File } from "./identity.mjs";
import {
  apiError,
  controlJobApi,
  describeApi,
  enqueueCampaignApi,
  inspectOutputApi,
  listOutputsApi,
  orchestrationStatusApi,
  registerTargetApi,
  statusApi,
  validateConfigApi,
} from "./manager_api.mjs";
import { listQualifiedProfiles } from "./profiles.mjs";
import {
  installStartup,
  startupStatus,
  uninstallStartup,
} from "./platform_startup.mjs";

function output(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function usage() {
  return `Usage:
  arena-evidence help
  arena-evidence init [--workspace PATH]
  arena-evidence daemon [--once]
  arena-evidence status [--json]
  arena-evidence pause [--reason TEXT]
  arena-evidence resume
  arena-evidence target add --model-id ID --model-root PATH --fingerprint N --engine PATH --provider NAME
  arena-evidence target list [--json]
  arena-evidence target remove --id UUID
  arena-evidence job enqueue --campaign first [--target UUID]
  arena-evidence job enqueue --adapter NAME --shard ID [--target UUID] [--config-json JSON] [--priority N]
  arena-evidence job list [--state STATE] [--json]
  arena-evidence job cancel|retry --id UUID
  arena-evidence dataset list [--json]
  arena-evidence dataset show --id UUID
  arena-evidence dataset export --id UUID --out PATH [--format json|jsonl]
  arena-evidence profile list [--json]
  arena-evidence api describe|status
  arena-evidence api outputs list [--cursor SHA256]
  arena-evidence api outputs inspect --id OUTPUT_ID
  arena-evidence api config validate
  arena-evidence api orchestration status
  arena-evidence api target register --model-id ID --model-root PATH --model-fingerprint N --engine PATH --provider NAME [--provider-fingerprint N] [--uci-options-json JSON]
  arena-evidence api campaign enqueue [--target UUID]
  arena-evidence api job control --id UUID --action cancel|retry
  arena-evidence prune --before ISO_TIMESTAMP [--confirm PRUNE]
  arena-evidence startup install|status|uninstall

Global options: --workspace PATH --config FILE --help`;
}

async function main(argv = process.argv.slice(2)) {
  const parsed = parseCliArguments(argv);
  if (parsed.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  const { command, flags, globals } = parsed;
  const config = await loadConfig({
    configFile: globals.config,
    workspace: globals.workspace,
  });
  await mkdir(config.workspace, { recursive: true });
  const catalog = new Catalog(config);
  try {
    if (command === "api describe") {
      output(describeApi());
    } else if (command === "api status") {
      output(statusApi(catalog));
    } else if (command === "api outputs list") {
      output(listOutputsApi(catalog, config, flags.cursor || ""));
    } else if (command === "api outputs inspect") {
      output(inspectOutputApi(catalog, config, flags.id));
    } else if (command === "api config validate") {
      output(validateConfigApi(config));
    } else if (command === "api orchestration status") {
      output(orchestrationStatusApi(catalog));
    } else if (command === "api target register") {
      output(registerTargetApi(catalog, {
        label: flags.label || flags["model-id"],
        modelId: flags["model-id"],
        modelRoot: flags["model-root"],
        modelFingerprint: flags["model-fingerprint"],
        enginePath: flags.engine,
        provider: flags.provider,
        hardwareDriverFingerprint: flags["provider-fingerprint"] || "",
        uciOptions: parseJsonObjectFlag(flags, "uci-options-json"),
      }));
    } else if (command === "api campaign enqueue") {
      output(enqueueCampaignApi(catalog, flags.target || null));
    } else if (command === "api job control") {
      output(controlJobApi(catalog, flags.id, flags.action));
    } else if (command === "init") {
      output({
        schema: "uci_arena_evidence_init_v1",
        workspace: config.workspace,
        status: catalog.status(),
      });
    } else if (command === "daemon") {
      output(await runDaemon(catalog, config, { once: Boolean(flags.once) }));
    } else if (command === "status") {
      output(catalog.status());
    } else if (command === "pause") {
      output(catalog.setPaused(true, flags.reason || "operator pause"));
    } else if (command === "resume") {
      output(catalog.setPaused(false));
    } else if (command === "target add") {
      if (!existsSync(flags.engine)) throw new Error(`engine is missing: ${flags.engine}`);
      if (!existsSync(flags["model-root"])) {
        throw new Error(`model root is missing: ${flags["model-root"]}`);
      }
      output(catalog.addTarget({
        label: flags.label || flags["model-id"],
        modelId: flags["model-id"],
        modelRoot: flags["model-root"],
        modelFingerprint: flags.fingerprint,
        enginePath: flags.engine,
        engineSha256: sha256File(flags.engine),
        provider: flags.provider,
        hardwareDriverFingerprint: flags["hardware-fingerprint"] || "",
        uciOptions: parseJsonObjectFlag(flags, "uci-options-json"),
      }));
    } else if (command === "target list") {
      output(catalog.targets());
    } else if (command === "target remove") {
      output({ removed: catalog.removeTarget(flags.id), id: flags.id });
    } else if (command === "job enqueue") {
      if (flags.campaign === "first") {
        if (flags.target && !catalog.target(flags.target)) {
          throw new Error(`unknown target ${flags.target}`);
        }
        const jobs = enqueueFirstCampaign(catalog, { targetId: flags.target || null });
        output({ campaign: "time_control_curve_v1", jobs });
      } else {
        if (!isAllowedAdapter(flags.adapter)) {
          throw new Error(`adapter ${flags.adapter} is not allow-listed`);
        }
        if (flags.target && !catalog.target(flags.target)) {
          throw new Error(`unknown target ${flags.target}`);
        }
        const value = parseJsonObjectFlag(flags, "config-json");
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
          priority: parseIntegerFlag(flags, "priority"),
          config: value,
          fingerprint,
        }));
      }
    } else if (command === "job list") {
      output(catalog.jobs({ state: flags.state }));
    } else if (command === "job cancel") {
      output(catalog.cancelJob(flags.id));
    } else if (command === "job retry") {
      output(catalog.retryJob(flags.id));
    } else if (command === "dataset list") {
      output(catalog.datasets());
    } else if (command === "profile list") {
      output(listQualifiedProfiles(config, catalog));
    } else if (command === "dataset show") {
      const dataset = catalog.dataset(flags.id);
      if (!dataset) throw new Error(`unknown dataset ${flags.id}`);
      output(dataset);
    } else if (command === "dataset export") {
      const readStore = new DatasetReadStore(config.paths.catalog);
      try {
        const result = await exportDataset(readStore, {
          datasetId: flags.id,
          out: flags.out,
          format: flags.format || "jsonl",
        });
        if (result === null) throw new Error(`unknown dataset ${flags.id}`);
        output(result);
      } finally {
        readStore.close();
      }
    } else if (command === "prune") {
      output(catalog.prune({ before: flags.before, confirm: flags.confirm || "" }));
    } else if (command === "startup install") {
      output(await installStartup(config));
    } else if (command === "startup status") {
      output(await startupStatus(config));
    } else if (command === "startup uninstall") {
      output(await uninstallStartup(config));
    } else {
      throw new Error(`unreachable CLI command: ${command}`);
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
