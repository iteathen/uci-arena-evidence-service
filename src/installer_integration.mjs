import { createHash } from 'node:crypto';
import { lstatSync, openSync, closeSync, readFileSync, readSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateStoredProfile } from '../vendor/time-profile-contract/src/index.mjs';
import { admitRuntimeTarget } from './runtime_v2_binding.mjs';

const MAXIMUM_CONTEXT_BYTES = 1024 * 1024;
const MAXIMUM_PROFILE_BYTES = 16 * 1024 * 1024;

function requireObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requireAbsolutePath(value, label) {
  if (typeof value !== 'string' || !value.trim() || !path.isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path`);
  }
  return path.normalize(value);
}

function sha256File(filename) {
  const digest = createHash('sha256');
  const handle = openSync(filename, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const count = readSync(handle, buffer, 0, buffer.length, null);
      if (count === 0) break;
      digest.update(buffer.subarray(0, count));
    }
  } finally {
    closeSync(handle);
  }
  return `sha256:${digest.digest('hex')}`;
}

function readBoundedJson(filename, maximumBytes, label) {
  const absolute = requireAbsolutePath(filename, label);
  const metadata = lstatSync(absolute);
  if (!metadata.isFile() || metadata.isSymbolicLink()
      || metadata.size < 2 || metadata.size > maximumBytes) {
    throw new Error(`${label} is not a bounded regular file`);
  }
  return JSON.parse(readFileSync(absolute, 'utf8'));
}

function timingProfileConfiguration(profilePath, bindings) {
  const profile = validateStoredProfile(
    readBoundedJson(profilePath, MAXIMUM_PROFILE_BYTES, 'timing profile'),
  );
  const search = requireObject(profile.identity?.search, 'timing profile search identity');
  const model = requireObject(profile.identity?.model, 'timing profile model identity');
  const provider = requireObject(profile.identity?.provider ?? {}, 'timing profile provider identity');
  const engineSha256 = sha256File(bindings.engine);
  const options = { ...(search.extra_engine_options ?? {}) };
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('timing profile extra engine options are invalid');
  }
  Object.assign(options, {
    SearchCore: search.search_core,
    Threads: search.threads,
    RootWorkers: search.root_workers,
    V2SplitDepth: search.split_depth,
    BackgroundSearch: search.background_search,
    NNSpeculation: search.nn_speculation,
    NNBatchSize: search.batch_size_effective,
    NNBatchWaitUs: search.batch_wait_us_effective,
    OnnxProvider: search.provider_effective,
  });
  if (typeof model.model_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(model.model_id)
      || String(model.model_fingerprint ?? '').length === 0
      || typeof search.provider_effective !== 'string'
      || search.provider_effective.length === 0) {
    throw new Error('timing profile runtime identity is incomplete');
  }
  return {
    configuration: {
      profileImports: [profilePath],
      model_id: model.model_id,
      model_fingerprint: String(model.model_fingerprint),
      model_root: bindings.model_root,
      provider: search.provider_effective,
      hardware_driver_fingerprint: String(provider.hardware_driver_fingerprint ?? ''),
      engine_path: bindings.engine,
      engine_sha256: engineSha256,
      uci_options: options,
    },
    pointer: {
      schema: 'arena_installed_active_model_runtime_v1',
      model_id: model.model_id,
      model_root: bindings.model_root,
      model_fingerprint: String(model.model_fingerprint),
      provider: search.provider_effective,
      hardware_driver_fingerprint: String(provider.hardware_driver_fingerprint ?? ''),
      engine_path: bindings.engine,
      engine_sha256: engineSha256,
      uci_options: options,
    },
  };
}

export function renderInstallerConfiguration(context) {
  requireObject(context, 'installer context');
  if (context.schema !== 'arena_provider_install_context_v1'
      || context.schema_version !== 1) {
    throw new Error('unsupported installer context');
  }
  const workspace = requireAbsolutePath(context.workspace, 'workspace');
  const bindings = requireObject(context.bindings, 'bindings');
  const locators = requireObject(context.locators ?? {}, 'locators');
  if(bindings.engine_launch_profile !== undefined) {
    if(locators.timing_profile !== undefined) throw new Error('legacy timing profile cannot be applied to the v2 managed runtime');
    const root=requireAbsolutePath(bindings.evidence_runtime_root,'bindings.evidence_runtime_root');
    const manifestPath=requireAbsolutePath(bindings.engine_component_manifest,'bindings.engine_component_manifest');
    const manifest=readBoundedJson(manifestPath,32*MAXIMUM_CONTEXT_BYTES,'engine component manifest');
    const runtimeBinding={schema:'uci_arena_evidence_runtime_binding_v2',component:{id:manifest.component_id,version:manifest.component_version,
      root,manifest:path.relative(root,manifestPath).replaceAll('\\','/'),manifest_sha256:sha256File(manifestPath).slice(7)},entrypoint:'evidence_runtime_contract'};
    const launchProfilePath=requireAbsolutePath(bindings.engine_launch_profile,'bindings.engine_launch_profile');
    const profile=readBoundedJson(launchProfilePath,MAXIMUM_CONTEXT_BYTES,'managed UCI launch profile');
    if(profile.schema!=='arena_uci_engine_launch_profile_v1'||profile.schema_version!==1||profile.component?.id!==manifest.component_id
      ||profile.component.version!==manifest.component_version||profile.component.root!=='.'||profile.enabled!==true
      ||profile.engine?.adapter!=='standard_uci_v1'||!Array.isArray(profile.engine.arguments))throw new Error('managed UCI profile identity is incompatible');
    const profileRelative=path.relative(root,launchProfilePath).replaceAll('\\','/');
    const profileRow=manifest.files?.find(row=>row.path===profileRelative);
    if(!profileRow||profileRow.sha256!==sha256File(launchProfilePath).slice(7)||profileRow.size_bytes!==lstatSync(launchProfilePath).size)throw new Error('managed UCI profile is absent from exact inventory');
    const target={schema:'uci_arena_evidence_target_v2',label:manifest.component_id,launch:{executable:path.resolve(root,profile.engine.executable),
      arguments:profile.engine.arguments,working_directory:path.resolve(root,profile.engine.working_directory),uci_options:profile.uci_options??{}},runtime_binding:runtimeBinding};
    const admitted=admitRuntimeTarget(target);
    const pointer={schema:'arena_installed_active_evidence_target_v2',target};
    return {schema:'arena_provider_install_result_v1',schema_version:1,configuration:{schema:'uci_arena_evidence_service_config_v1',workspace,
      activeModelPointer:path.join(workspace,'active-evidence-target.json'),profileImports:[],engine:admitted.enginePath},
      generated_documents:[{path:'active-evidence-target.json',document:pointer}]};
  }
  for (const name of ['evidence_runtime_root', 'engine', 'model_root', 'stockfish', 'referee']) {
    bindings[name] = requireAbsolutePath(bindings[name], `bindings.${name}`);
  }
  const activeModelPointer = path.join(workspace, 'runtime-models', 'active_model_runtime.json');
  const configuration = {
    schema: 'uci_arena_evidence_service_config_v1',
    workspace,
    runtimeRoot: bindings.evidence_runtime_root,
    activeModelPointer,
    runtimeModelsRoot: path.join(workspace, 'runtime-models'),
    profileImports: [],
    engine: bindings.engine,
    stockfish: bindings.stockfish,
    referee: bindings.referee,
  };
  const generatedDocuments = [];
  if (locators.timing_profile !== undefined) {
    const profilePath = requireAbsolutePath(locators.timing_profile, 'locators.timing_profile');
    const timing = timingProfileConfiguration(profilePath, bindings);
    Object.assign(configuration, timing.configuration);
    generatedDocuments.push({
      path: 'runtime-models/active_model_runtime.json',
      document: timing.pointer,
    });
  }
  return {
    schema: 'arena_provider_install_result_v1',
    schema_version: 1,
    configuration,
    generated_documents: generatedDocuments,
  };
}

function main(argv) {
  if (argv.length !== 2 || argv[0] !== '--context') {
    throw new Error('usage: installer_integration.mjs --context <absolute-json-file>');
  }
  const context = readBoundedJson(argv[1], MAXIMUM_CONTEXT_BYTES, 'installer context file');
  process.stdout.write(`${JSON.stringify(renderInstallerConfiguration(context))}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`Evidence installer integration failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
