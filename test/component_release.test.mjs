import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  validatedDiscovery,
  validateNodeEntrypointRuntimeClosure,
  validateWindowsRuntimeOwnership,
} from "../tools/release/component_release.mjs";

test('current service release identity retains its owned campaign clock helper',()=>{
 const pkg=JSON.parse(readFileSync(new URL('../package.json',import.meta.url))),lock=JSON.parse(readFileSync(new URL('../package-lock.json',import.meta.url)));
 const contract=JSON.parse(readFileSync(new URL('../contracts/service-contract.json',import.meta.url)));
 assert.match(pkg.version,/^\d+\.\d+\.\d+$/u);assert.equal(contract.component_version,pkg.version);
 assert.equal(lock.version,pkg.version);assert.equal(lock.packages[''].version,pkg.version);
 const definition=JSON.parse(readFileSync(new URL('../release/components/evidence-service.json',import.meta.url)));
 assert.deepEqual(definition.include.find(row=>row.source==='src'),{source:'src',target:'services/evidence-service/src'});
 const helper=readFileSync(new URL('../src/runtime_clock_options.mjs',import.meta.url),'utf8');assert.match(helper,/export function bindCampaignClockOptions/u);
 const adapter=readFileSync(new URL('../src/runtime_v2_adapter.mjs',import.meta.url),'utf8');assert.match(adapter,/from '\.\/runtime_clock_options\.mjs'/u);
});

test("component discovery is role-declared and locator-bounded", () => {
  assert.deepEqual(
    validatedDiscovery(
      [{ kind: "replacement_service", locator: { source: "entrypoint", entrypoint: "cli" } }],
      { cli: "service/cli.mjs" },
      [{ path: "service/cli.mjs" }],
    ),
    [{ kind: "replacement_service", locator: { source: "entrypoint", entrypoint: "cli" } }],
  );
  assert.throws(
    () => validatedDiscovery(
      [{ kind: "replacement_service", locator: { source: "component_path", path: "missing" } }],
      {},
      [{ path: "service/cli.mjs" }],
    ),
    /unlisted/u,
  );
});

test("Windows release closure accepts application-local VC runtimes", () => {
  assert.doesNotThrow(() => validateWindowsRuntimeOwnership([
    { path: "services/evidence-service/native/uci_arena_background_guard.exe" },
    { path: "services/evidence-service/native/msvcp140.dll" },
    { path: "services/evidence-service/native/vcruntime140.dll" },
  ], "windows-x86_64"));
});

test("Windows release closure rejects OS-owned runtime files", () => {
  for (const relative of [
    "services/evidence-service/native/api-ms-win-core-file-l1-1-0.dll",
    "services/evidence-service/native/ext-ms-win-ntuser-window-l1-1-0.dll",
    "services/evidence-service/native/ucrtbase.dll",
    "services/evidence-service/native/System32/kernel32.dll",
  ]) {
    assert.throws(
      () => validateWindowsRuntimeOwnership([{ path: relative }], "windows-x86_64"),
      /OS-owned Windows runtime files/u,
    );
  }
});

test("non-Windows release closure does not apply Windows ownership policy", () => {
  assert.doesNotThrow(() => validateWindowsRuntimeOwnership([
    { path: "fixture/ucrtbase.dll" },
  ], "linux-x86_64"));
});

test("release entrypoints import only from their staged runtime closure", (t) => {
  const staging = mkdtempSync(path.join(tmpdir(), "evidence-release-closure-"));
  t.after(() => rmSync(staging, { recursive: true, force: true }));
  const serviceRoot = path.join(staging, "service");
  mkdirSync(serviceRoot, { recursive: true });
  writeFileSync(
    path.join(serviceRoot, "entrypoint.mjs"),
    'import "./required-contract.mjs";\n',
  );
  const entrypoints = { installer_integration: "service/entrypoint.mjs" };

  assert.throws(
    () => validateNodeEntrypointRuntimeClosure(staging, entrypoints),
    /runtime closure is incomplete/u,
  );

  writeFileSync(path.join(serviceRoot, "required-contract.mjs"), "export {};\n");
  assert.doesNotThrow(
    () => validateNodeEntrypointRuntimeClosure(staging, entrypoints),
  );
});

test("provider release proves independent target-scoped native reproducibility", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/component-release.yml", import.meta.url),
    "utf8",
  );
  const definition = JSON.parse(readFileSync(
    new URL("../release/components/evidence-service.json", import.meta.url),
    "utf8",
  ));
  const nativeCmake = readFileSync(
    new URL("../vendor/background-service-runtime/native/CMakeLists.txt", import.meta.url),
    "utf8",
  );

  assert.deepEqual(Object.keys(definition.native_toolchain_by_target), ["windows-x86_64"]);
  assert.deepEqual(definition.discovery, [
    { kind: "evidence_service", locator: { source: "active_root" } },
  ]);
  assert.equal(
    definition.entrypoints.installer_integration,
    "services/evidence-service/src/installer_integration.mjs",
  );
  assert.equal(
    definition.installer_integration.invocation.runtime_component_id,
    "node_runtime.private",
  );
  assert.equal(definition.installer_integration.workspace_placement, "product_data");
  assert.deepEqual(definition.include.find((mapping) => mapping.source === "src"),
    { source: "src", target: "services/evidence-service/src" });
  // Full recursive src packaging retains the observer loaded as a runtime file.
  const packager = readFileSync(new URL("../tools/release/component_release.mjs", import.meta.url), "utf8");
  assert.match(packager, /if \(entry\.isDirectory\(\)\) rows\.push\(\.\.\.listFiles\(root, normalized\)\)/u);
  assert.match(packager, /for \(const relative of listFiles\(source\)\)/u);
  assert.deepEqual(
    definition.include.find((mapping) => mapping.source === "vendor/time-profile-contract"),
    {
      source: "vendor/time-profile-contract",
      target: "services/evidence-service/vendor/time-profile-contract",
    },
  );
  assert.deepEqual(
    definition.installer_integration.dependency_bindings.map((binding) => binding.name),
    ["engine_configuration", "evidence_runtime_root", "engine_component_manifest", "engine_launch_profile"],
  );
  assert.deepEqual(definition.installer_integration.dependency_bindings[0],
    {name:"engine_configuration",component_id:"uci_arena.vector",source:"configuration",required:false});
  assert.equal(definition.installer_integration.startup_control.entrypoint, "cli");
  assert.equal(
    definition.installer_integration.startup_control.result.envelope,
    "root",
  );
  assert.equal(
    definition.installer_integration.startup_control.result.require_live_on_install,
    true,
  );
  assert.match(workflow, /build\/native-repro/u);
  assert.match(workflow, /ctest --test-dir build\/native -C Release --output-on-failure --no-tests=error/u);
  assert.match(workflow, /ctest --test-dir build\/native-repro -C Release --output-on-failure --no-tests=error/u);
  assert.match(workflow, /provider_stage\/background_service_native_repro/u);
  assert.match(workflow, /native_toolchain_receipt\.mjs/u);
  assert.match(workflow, /dist\/provider-repro/u);
  assert.match(workflow, /Independent component builds differ:/u);
  assert.match(workflow, /first_path=/u);
  assert.match(workflow, /Independent component provider results differ/u);
  assert.match(workflow, /contents:\s*write/u);
  assert.match(workflow, /default:\s*github-hosted/u);
  assert.match(
    workflow,
    /\["self-hosted","Windows","X64","ephemeral","uci-suite","evidence-release"\]/u,
  );
  assert.match(workflow, /ephemeral self-hosted release is Windows-only/u);
  assert.match(workflow, /\('cl\.exe', 'gh\.exe', 'git\.exe', 'msbuild\.exe'\)/u);
  assert.doesNotMatch(workflow, /actions\/(?:upload|download)-artifact/u);
  assert.match(workflow, /Expected exactly three candidate assets/u);
  assert.match(workflow, /gh release create[\s\S]*?--target \$env:GITHUB_SHA/u);
  assert.ok(workflow.indexOf("provider_attestation.mjs verify-bundle")
    < workflow.indexOf("gh release create"));
  assert.match(nativeCmake, /target_link_options\(uci_arena_background_guard PRIVATE \/Brepro\)/u);
  assert.match(nativeCmake, /target_link_options\(uci_arena_service_launcher PRIVATE \/Brepro\)/u);
});
