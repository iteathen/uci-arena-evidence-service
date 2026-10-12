import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const loadLifecycle = () => import('../src/provider_lifecycle.mjs').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return null;
  throw error;
});
const sha = xml => createHash('sha256').update(xml).digest('hex');
const sid = 'S-1-5-21-1';
const nodeExecutable = 'C:\\owned-node\\node.exe';
const emptyGuids = [];

async function fixture(t) {
  const parent = path.resolve('build/test-fixtures');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'provider-lifecycle-'));
  const previousRoot = path.join(root, 'old319'), replacementRoot = path.join(root, 'new320');
  const workspace = path.join(root, 'workspace'), configFile = path.join(workspace, 'manager-config.json');
  await mkdir(path.join(workspace, 'locks'), { recursive: true });
  for (const componentRoot of [previousRoot, replacementRoot]) {
    await mkdir(componentRoot);
    await writeFile(path.join(componentRoot, 'arena-component.json'), JSON.stringify({
      schema: 'arena_install_component_v1', component_id: 'uci_arena_evidence.service',
      entrypoints: { cli: 'services/evidence-service/src/cli.mjs' },
    }));
  }
  const config = { workspace, configFile, paths: { locks: path.join(workspace, 'locks') },
    daemon: { staleMs: 300000 }, nativeHelper: path.join(previousRoot, 'old-query-only-guard.exe') };
  const action = {
    command: path.join(previousRoot, 'services/evidence-service/native/bin/uci_arena_service_launcher.exe'),
    arguments: `"${nodeExecutable}" "${path.join(previousRoot, 'services/evidence-service/src/cli.mjs')}" daemon --workspace "${workspace}" --config "${configFile}"`,
    working_directory: path.join(previousRoot, 'services/evidence-service'),
  };
  // Windows paths with spaces are reconstructed by the provider's exact quote
  // grammar. Keep this manually supplied action independent from its builder.
  const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const xmlFor = (a, enabled) => `<Task><Principals><Principal><UserId>${sid}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><Enabled>${enabled}</Enabled><Hidden>true</Hidden></Settings><Actions><Exec><Command>${escape(a.command)}</Command><Arguments>${escape(a.arguments)}</Arguments><WorkingDirectory>${escape(a.working_directory)}</WorkingDirectory></Exec></Actions></Task>`;
  let observation = { registered: true, enabled: true, definition_xml: xmlFor(action, true),
    definition_sha256: '', instance_guids: ['{00000000-0000-0000-0000-000000000001}'],
    principal: { current_user_sid: sid, user_sid: sid, logon_type: 3, run_level: 0 }, action };
  observation.definition_sha256 = sha(observation.definition_xml);
  const calls = [];
  let live = true, replacementOwner = false;
  const scheduler = { async perform(request, options) {
    assert.equal(request.task_path, '\\UCI Arena Evidence Service');
    assert.ok(options.timeoutMs > 0 && options.timeoutMs <= 30000);
    calls.push(request.operation);
    if (request.operation !== 'inspect') {
      assert.equal(request.expected_definition_xml, observation.definition_xml);
      assert.equal(request.expected_xml_sha256, observation.definition_sha256);
    }
    if (request.operation === 'set_enabled') {
      observation.enabled = request.enabled;
      observation.definition_xml = observation.definition_xml.replace(/<Settings><Enabled>(true|false)<\/Enabled>/u,
        `<Settings><Enabled>${request.enabled}</Enabled>`);
    } else if (request.operation === 'stop_instances') {
      assert.deepEqual(request.instance_guids, observation.instance_guids);
      observation.instance_guids = emptyGuids;
    } else if (request.operation === 'register') {
      observation.definition_xml = request.definition_xml;
      const decode = name => new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`, 'u').exec(request.definition_xml)[1]
        .replaceAll('&gt;', '>').replaceAll('&lt;', '<').replaceAll('&amp;', '&');
      observation.action = { command: decode('Command'), arguments: decode('Arguments'), working_directory: decode('WorkingDirectory') };
      observation.enabled = /<Settings><Enabled>true<\/Enabled>/u.test(request.definition_xml);
    } else if (request.operation === 'run') {
      assert.equal(observation.enabled, true); live = true;
      observation.instance_guids = ['{00000000-0000-0000-0000-000000000002}'];
    } else if (request.operation === 'delete') {
      observation = { registered: false, enabled: null, definition_xml: null, definition_sha256: null,
        instance_guids: [], principal: null, action: null };
    }
    if (observation.registered) observation.definition_sha256 = sha(observation.definition_xml);
    return { schema: 'uci_arena_windows_task_result_v1', schema_version: 1,
      operation: request.operation, task_path: request.task_path, outcome: 'completed',
      observation: structuredClone(observation), failure: null };
  } };
  const options = {
    scheduler, nodeExecutable,
    identityComposition: async selectedConfig => {
      calls.push('identity');
      assert.notEqual(selectedConfig.nativeHelper, config.nativeHelper, 'staged controller must not select 319 helper from serialized configuration');
      assert.match(selectedConfig.nativeHelper, /native[\\/]bin[\\/]uci_arena_background_guard\.exe$/u);
    },
    operationLockFactory: async () => ({ release: async () => calls.push('unlock') }),
    shutdownFactory: async () => ({
      stop: async () => { calls.push('owned_stop'); live = false; },
      verifyOwner: async () => { if (replacementOwner) throw new Error('ownership changed'); },
      retire: async () => calls.push('retire'),
    }),
    waitForActive: async () => live ? 42 : null,
  };
  const request = operation => ({ operation, previousRoot, replacementRoot });
  let passed = false;
  return { config, root, previousRoot, replacementRoot, scheduler, options, request, calls,
    observation: () => structuredClone(observation), setObservation: value => { observation = value; },
    setReplacementOwner: () => { replacementOwner = true; },
    pass: () => { passed = true; },
    cleanup: async () => { if (passed) await rm(root, { recursive: true, force: true }); else t.diagnostic(`failed lifecycle fixture retained: ${root}`); },
  };
}

test('staged replacement quiesces 319 without invoking its CLI and converges on repeated pre_replace', async t => {
  const lifecycle = await loadLifecycle();
  assert.equal(typeof lifecycle?.runProviderLifecycle, 'function');
  const f = await fixture(t);
  try {
    const result = await lifecycle.runProviderLifecycle(f.config, f.request('pre_replace'), f.options);
    assert.equal(result.disposition, 'ready');
    assert.deepEqual(result.observed, { installation: 'installed', activity: 'inactive', configuration: 'matches', replacement: 'safe' });
    assert.equal(f.observation().enabled, false);
    assert.deepEqual(f.observation().instance_guids, []);
    assert.equal(f.observation().action.command, path.join(f.replacementRoot, 'services/evidence-service/native/bin/uci_arena_service_launcher.exe'));
    assert.ok(f.calls.indexOf('set_enabled') < f.calls.indexOf('owned_stop'));
    assert.equal((await lifecycle.runProviderLifecycle(f.config, f.request('pre_replace'), f.options)).disposition, 'ready');
    f.pass();
  } finally { await f.cleanup(); }
});
