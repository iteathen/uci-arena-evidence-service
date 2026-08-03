#!/usr/bin/env node

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sourceRoot = path.join(repositoryRoot, "src");

function sourceFiles(directory) {
  const files = [];
  for (const name of readdirSync(directory)) {
    const filename = path.join(directory, name);
    const info = statSync(filename);
    if (info.isDirectory()) files.push(...sourceFiles(filename));
    else if (name.endsWith(".mjs")) files.push(filename);
  }
  return files;
}

const failures = [];
for (const filename of sourceFiles(sourceRoot)) {
  const relative = path.relative(repositoryRoot, filename).replaceAll("\\", "/");
  const text = readFileSync(filename, "utf8");
  if (relative !== "src/prune_service.mjs" && /\.prune\s*\(/u.test(text)) {
    failures.push(`${relative}: production code calls the legacy Catalog.prune authority`);
  }
  if (relative !== "src/prune_store.mjs"
      && /\b(?:DELETE\s+FROM\s+(?:artifacts|observations)|prune_audit)\b/iu.test(text)
      && relative !== "src/catalog.mjs") {
    failures.push(`${relative}: prune persistence details escaped the PruneStore boundary`);
  }
}

const cli = readFileSync(path.join(sourceRoot, "cli.mjs"), "utf8");
for (const required of [
  'from "./prune_service.mjs"',
  'from "./prune_store.mjs"',
  "new PruneStore(config.paths.catalog)",
  "new PruneService(pruneStore, config)",
]) {
  if (!cli.includes(required)) failures.push(`src/cli.mjs: missing prune composition ${required}`);
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("Evidence prune production authority is isolated.\n");
}
