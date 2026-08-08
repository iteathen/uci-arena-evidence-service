import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { renderInstallerConfiguration } from '../src/installer_integration.mjs';
import {
  REQUIRED_MCGS_TIME_POLICY,
  TIME_POLICY_VERSION,
  sha256Object,
} from '../vendor/time-profile-contract/src/index.mjs';
import { sha256File } from '../src/identity.mjs';

test('installer integration binds Evidence Runtime and generates an exact active target', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'arena-evidence-installer-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  const modelRoot = path.join(root, 'engine', 'models', 'default');
  const engine = path.join(root, 'engine', 'bin', 'uci_arena_engine.exe');
  mkdirSync(path.dirname(engine), { recursive: true });
  mkdirSync(modelRoot, { recursive: true });
  writeFileSync(engine, 'engine-fixture', 'utf8');
  const identity = {
    time_policy_version: TIME_POLICY_VERSION,
    engine: { executable_sha256: `sha256:${sha256File(engine)}` },
    model: { model_id: 'model-1', model_fingerprint: 'model-fingerprint' },
    provider: { hardware_driver_fingerprint: 'cpu-fixture' },
    search: {
      search_core: 'mcgs',
      mcgs: { time_policy: REQUIRED_MCGS_TIME_POLICY },
      threads: 2,
      root_workers: 1,
      split_depth: 4,
      background_search: false,
      nn_speculation: false,
      batch_size_effective: 8,
      batch_wait_us_effective: 100,
      provider_effective: 'cpu',
      extra_engine_options: {},
    },
  };
  const profile = {
    schema: 'uci_time_profile_v3',
    qualified: true,
    gates: { passed: true },
    predictive_controller: { enabled_by_profile: false, default_enabled: false },
    identity,
    identity_sha256: sha256Object(identity),
    calibration: {
      provider_batch_reserve_us: 12000,
      backup_emit_reserve_us: 2000,
      iteration_forecast_scale_permille: 1500,
    },
    applicability: {
      move_overhead_ms: {
        minimum: 250,
        maximum: 1500,
        tested_values: [250, 650, 700, 1500],
      },
    },
  };
  const profilePath = path.join(root, 'timing.json');
  writeFileSync(profilePath, JSON.stringify(profile), 'utf8');
  const runtimeRoot = path.join(root, 'evidence runtime');
  const result = renderInstallerConfiguration({
    schema: 'arena_provider_install_context_v1',
    schema_version: 1,
    workspace,
    enabled: true,
    bindings: {
      evidence_runtime_root: runtimeRoot,
      engine,
      model_root: modelRoot,
      stockfish: path.join(root, 'stockfish.exe'),
      referee: path.join(runtimeRoot, 'bin', 'uci_arena_complete_game_referee.exe'),
    },
    locators: { timing_profile: profilePath },
  });

  assert.equal(result.configuration.runtimeRoot, runtimeRoot);
  assert.equal(result.configuration.referee,
    path.join(runtimeRoot, 'bin', 'uci_arena_complete_game_referee.exe'));
  assert.equal(result.configuration.engine_sha256, `sha256:${sha256File(engine)}`);
  assert.equal(result.generated_documents.length, 1);
  assert.equal(result.generated_documents[0].document.model_id, 'model-1');
  assert.equal(result.generated_documents[0].document.uci_options.SearchCore, 'mcgs');
});

test('installer integration retains timing authority across provenance-only rebuilds', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'arena-evidence-installer-drift-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const profilePath = path.join(root, 'timing.json');
  const identity = {
    time_policy_version: TIME_POLICY_VERSION,
    engine: { executable_sha256: `sha256:${'a'.repeat(64)}` },
    model: { model_id: 'model-1', model_fingerprint: 'fingerprint' },
    provider: {},
    search: {
      search_core: 'minimax', threads: 1, root_workers: 1, split_depth: 1,
      background_search: false, nn_speculation: false, batch_size_effective: 1,
      batch_wait_us_effective: 0, provider_effective: 'cpu', extra_engine_options: {},
    },
  };
  writeFileSync(profilePath, JSON.stringify({
    schema: 'uci_time_profile_v3', qualified: true, gates: { passed: true },
    predictive_controller: { enabled_by_profile: false, default_enabled: false },
    identity, identity_sha256: sha256Object(identity),
    calibration: { provider_batch_reserve_us: 1, backup_emit_reserve_us: 0,
      iteration_forecast_scale_permille: 1000 },
    applicability: { move_overhead_ms: { minimum: 250, maximum: 1500,
      tested_values: [250, 650, 700, 1500] } },
  }), 'utf8');
  const engine = path.join(root, 'engine.exe');
  writeFileSync(engine, 'different', 'utf8');
  const result = renderInstallerConfiguration({
    schema: 'arena_provider_install_context_v1', schema_version: 1,
    workspace: path.join(root, 'workspace'), enabled: true,
    bindings: { evidence_runtime_root: path.join(root, 'runtime'), engine,
      model_root: path.join(root, 'models'), stockfish: path.join(root, 'stockfish'),
      referee: path.join(root, 'runtime', 'referee') },
    locators: { timing_profile: profilePath },
  });
  assert.equal(result.configuration.engine_sha256, `sha256:${sha256File(engine)}`);
  assert.equal(result.configuration.profileImports[0], profilePath);
  assert.equal(result.generated_documents[0].document.engine_sha256,
    `sha256:${sha256File(engine)}`);

  writeFileSync(profilePath, JSON.stringify({
    schema: 'uci_time_profile_v3', qualified: true, gates: { passed: true },
    predictive_controller: { enabled_by_profile: false, default_enabled: false },
    identity, identity_sha256: `sha256:${'0'.repeat(64)}`,
    calibration: { provider_batch_reserve_us: 1, backup_emit_reserve_us: 0,
      iteration_forecast_scale_permille: 1000 },
    applicability: { move_overhead_ms: { minimum: 250, maximum: 1500,
      tested_values: [250, 650, 700, 1500] } },
  }), 'utf8');
  assert.throws(() => renderInstallerConfiguration({
    schema: 'arena_provider_install_context_v1', schema_version: 1,
    workspace: path.join(root, 'workspace'), enabled: true,
    bindings: { evidence_runtime_root: path.join(root, 'runtime'), engine,
      model_root: path.join(root, 'models'), stockfish: path.join(root, 'stockfish'),
      referee: path.join(root, 'runtime', 'referee') },
    locators: { timing_profile: profilePath },
  }), /identity digest mismatch/u);
});
