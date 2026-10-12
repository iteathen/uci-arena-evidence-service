import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { configureProcessIdentityProbe } from '../src/process_identity.mjs';
import { NativeResourceHelper } from '@uci-arena/background-service-runtime/native-resource-helper';

// Only the OS command boundary is substituted. The owner record reader and
// startup lifecycle execute unchanged; no installed task or process is touched.
test('Windows uninstall actively stops an exact owner after Task End leaves it alive', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows startup lifecycle');
  const workspace = path.resolve('build/test-fixtures/windows-stop-regression');
  const locks = path.join(workspace, 'locks');
  await mkdir(locks, { recursive: true });
  const identity = { schema: 'uci_arena_process_instance_identity_v1', platform: 'win32',
    pid: 42, start_token: '639120000000000000', executable_path: 'C:\\provider\\node.exe', boot_id: '' };
  const raw = JSON.stringify({ schema: 'uci_arena_evidence_daemon_lock_v2', pid: 42,
    nonce: 'retained-owned-fixture', processIdentity: identity });
  await writeFile(path.join(locks, 'daemon.lock'), raw);
  await writeFile(path.join(workspace, 'startup-task.json'), '{"retained":true}');
  let live = true;
  const commands = [];
  const executeImpl = async (executable, args, options) => {
    assert.equal(executable, 'schtasks.exe');
    assert.equal(options.windowsHide, true);
    commands.push(args[0]);
    assert.ok(['/End', '/Delete'].includes(args[0]));
    return { stdout: '', stderr: '' };
  };
  await configureProcessIdentityProbe({
    probe: async () => ({ capabilities: ['process_instance_query_v1', 'process_instance_stop_v1'] }),
    queryProcessInstanceSync: () => ({ schema: 'uci_arena_process_instance_query_v1',
      state: live ? 'present' : 'absent', ...(live ? { identity } : {}) }),
    stopProcessInstanceSync: (expected) => {
      assert.deepEqual(expected, identity);
      live = false;
      return { schema: 'uci_arena_process_instance_stop_v1', state: 'stopped' };
    },
  });
  const { uninstallStartup } = await import('../src/platform_startup.mjs?stop-regression');
  let passed = false;
  try {
    const result = await uninstallStartup({ workspace, paths: { locks } }, { executeImpl });
    assert.equal(result.installed, false);
    assert.equal(live, false, 'Task End alone is not daemon shutdown authority');
    assert.deepEqual(commands, ['/End', '/Delete']);
    await assert.rejects(readFile(path.join(locks, 'daemon.lock')), { code: 'ENOENT' });
    passed = true;
  } finally {
    // Failed RED fixture is evidence; successful runs own bounded cleanup.
    if (passed) await rm(workspace, { recursive: true, force: true });
  }
});

let importId = 0;
const exact = { schema: 'uci_arena_process_instance_identity_v1', platform: 'win32',
  pid: 42, start_token: '639120000000000000', executable_path: 'C:\\provider\\node.exe', boot_id: '' };
const stopSchema = 'uci_arena_process_instance_stop_v1';
const presenceSchema = 'uci_arena_evidence_startup_presence_v1';

async function withFixture(t, options, verify) {
  const parent = path.resolve('build/test-fixtures');
  await mkdir(parent, { recursive: true });
  const workspace = await mkdtemp(path.join(parent, 'owned-stop-'));
  const locks = path.join(workspace, 'locks');
  await mkdir(locks);
  const record = options.owner === undefined
    ? { schema: 'uci_arena_evidence_daemon_lock_v2', pid: 42, nonce: 'exact-owner', processIdentity: exact }
    : options.owner;
  const raw = JSON.stringify(record);
  if (record !== null) await writeFile(path.join(locks, 'daemon.lock'), raw);
  await writeFile(path.join(workspace, 'startup-task.json'), '{"retained":true}');
  const calls = [], budgets = [];
  let clock = 0, stopped = false;
  const executeImpl = async (executable, args, execOptions) => {
    assert.equal(execOptions.windowsHide, true);
    if (executable === 'schtasks.exe') {
      assert.equal(args[1], '/TN'); assert.equal(args[2], 'UCI Arena Evidence Service');
      calls.push(args[0]);
      const failure = args[0] === '/End' ? options.endError : options.deleteError;
      if (failure) throw failure;
      return { stdout: '', stderr: '' };
    } else {
      assert.equal(executable, 'powershell.exe');
      calls.push('presence');
      return {
        stdout: Buffer.from(JSON.stringify({ schema: presenceSchema, state: options.presenceState ?? 'unverifiable' })),
        stderr: Buffer.alloc(0),
      };
    }
  };
  await configureProcessIdentityProbe({
    probe: async () => ({ capabilities: options.missingStopCapability
      ? ['process_instance_query_v1'] : ['process_instance_query_v1', 'process_instance_stop_v1'] }),
    queryProcessInstanceSync: (_pid, { timeoutMs }) => {
      calls.push('query'); budgets.push(timeoutMs);
      clock += options.queryCost ?? 0;
      const observation = options.observed ?? (stopped ? { state: 'absent' } : { state: 'present', identity: exact });
      return { schema: 'uci_arena_process_instance_query_v1', ...observation };
    },
    stopProcessInstanceSync: (identity, { timeoutMs }) => {
      calls.push('stop'); budgets.push(timeoutMs);
      assert.deepEqual(identity, exact);
      assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 2000);
      clock += options.stopCost ?? 0;
      stopped = true;
      if (options.replaceRecord) {
        // A concurrent provider may publish a replacement owner while the old
        // handle exits. This record must survive teardown of the old owner.
        writeFileSync(path.join(locks, 'daemon.lock'), JSON.stringify(options.replaceRecord));
      }
      return Object.hasOwn(options, 'stopResult') ? options.stopResult : { schema: stopSchema, state: 'stopped' };
    },
  });
  const { uninstallStartup } = await import(`../src/platform_startup.mjs?owned-stop-${++importId}`);
  const config = { workspace, paths: { locks } };
  const fixture = { workspace, locks, raw, calls, budgets,
    uninstall: () => uninstallStartup(config, { now: () => clock, executeImpl }),
    lock: () => readFile(path.join(locks, 'daemon.lock'), 'utf8'),
    startup: () => readFile(path.join(workspace, 'startup-task.json'), 'utf8') };
  let passed = false;
  try { await verify(fixture); passed = true; }
  finally {
    if (passed) await rm(workspace, { recursive: true, force: true });
    else t.diagnostic(`failed ownership fixture retained: ${workspace}`);
  }
}

const windowsOnly = { skip: process.platform !== 'win32' ? 'Windows startup lifecycle' : false };

test('owned stop and independent exit observation share one shrinking two-second budget', windowsOnly, async t => {
  await withFixture(t, { stopCost: 1500 }, async f => {
    assert.equal((await f.uninstall()).installed, false);
    assert.deepEqual(f.budgets, [2000, 500]);
    assert.deepEqual(f.calls, ['/End', 'stop', 'query', '/Delete']);
    await assert.rejects(f.lock(), { code: 'ENOENT' });
  });
});

for (const state of ['absent', 'reused']) test(`native ${state} owner disposition still requires a positive observation`, windowsOnly, async t => {
  const observed = state === 'absent' ? { state: 'absent' }
    : { state: 'present', identity: { ...exact, start_token: '639120000000000001' } };
  await withFixture(t, { stopResult: { schema: stopSchema, state }, observed }, async f => {
    assert.equal((await f.uninstall()).installed, false);
    await assert.rejects(f.lock(), { code: 'ENOENT' });
  });
});

for (const stopResult of [
  { schema: stopSchema, state: 'unverifiable' }, { schema: stopSchema, state: 'deferred' },
  { schema: stopSchema, state: 'stopped', extra: true }, { schema: 'unknown', state: 'stopped' }, null,
]) test(`uncertain or malformed stop disposition preserves owner and registration: ${JSON.stringify(stopResult)}`, windowsOnly, async t => {
  await withFixture(t, { stopResult, observed: { state: 'absent' } }, async f => {
    await assert.rejects(f.uninstall());
    assert.equal(await f.lock(), f.raw);
    assert.equal(await f.startup(), '{"retained":true}');
    assert.ok(!f.calls.includes('/Delete'));
  });
});

for (const observed of [
  { state: 'unverifiable' }, { state: 'present', identity: null },
  { state: 'present', identity: { ...exact, pid: 43 } },
]) test('claimed native stop never replaces independent exit proof for an unverifiable owner', windowsOnly, async t => {
  await withFixture(t, { observed }, async f => {
    await assert.rejects(f.uninstall());
    assert.equal(await f.lock(), f.raw);
    assert.ok(!f.calls.includes('/Delete'));
  });
});

test('stop completion observed after the unchanged deadline preserves recovery records', windowsOnly, async t => {
  await withFixture(t, { stopCost: 2001, observed: { state: 'absent' } }, async f => {
    await assert.rejects(f.uninstall());
    assert.deepEqual(f.budgets, [2000]);
    assert.equal(await f.lock(), f.raw);
    assert.ok(!f.calls.includes('/Delete'));
  });
});

test('late independent exit evidence cannot authorize registration deletion', windowsOnly, async t => {
  await withFixture(t, { stopCost: 1500, queryCost: 501 }, async f => {
    await assert.rejects(f.uninstall());
    assert.deepEqual(f.budgets, [2000, 500]);
    assert.equal(await f.lock(), f.raw);
    assert.ok(!f.calls.includes('/Delete'));
  });
});

test('a missing task permits exact direct daemon shutdown without numeric PID authority', windowsOnly, async t => {
  await withFixture(t, { endError: Object.assign(new Error('task absent'), { code: 1 }), presenceState: 'absent' }, async f => {
    assert.equal((await f.uninstall()).installed, false);
    assert.ok(f.calls.includes('stop'));
    await assert.rejects(f.lock(), { code: 'ENOENT' });
  });
});

for (const presenceState of ['present', 'unverifiable']) test(`Task End failure with ${presenceState} registration never stops the daemon`, windowsOnly, async t => {
  await withFixture(t, { endError: Object.assign(new Error('End refused'), { code: 1 }), presenceState }, async f => {
    await assert.rejects(f.uninstall());
    assert.ok(f.calls.includes('presence'));
    assert.ok(!f.calls.includes('stop'));
    assert.equal(await f.lock(), f.raw);
  });
});

test('registration deletion denial preserves recovery records after exact daemon exit', windowsOnly, async t => {
  await withFixture(t, { deleteError: Object.assign(new Error('delete denied'), { code: 1 }), presenceState: 'present' }, async f => {
    await assert.rejects(f.uninstall());
    assert.ok(f.calls.includes('/Delete'));
    assert.equal(await f.lock(), f.raw);
    assert.equal(await f.startup(), '{"retained":true}');
  });
});

test('a replacement daemon record blocks registration deletion and preserves recovery authority', windowsOnly, async t => {
  const replacement = { schema: 'uci_arena_evidence_daemon_lock_v2', pid: 43, nonce: 'replacement-owner',
    processIdentity: { ...exact, pid: 43, start_token: '639120000000000001' } };
  await withFixture(t, { replaceRecord: replacement }, async f => {
    await assert.rejects(f.uninstall(), /ownership changed/);
    assert.equal(await f.lock(), JSON.stringify(replacement));
    assert.ok(!f.calls.includes('/Delete'));
    assert.equal(await f.startup(), '{"retained":true}');
  });
});

test('unqualified native stop capability fails before teardown mutates registration', windowsOnly, async t => {
  await withFixture(t, { missingStopCapability: true }, async f => {
    await assert.rejects(f.uninstall());
    assert.ok(!f.calls.includes('/End'));
    assert.ok(!f.calls.includes('stop'));
    assert.equal(await f.lock(), f.raw);
  });
});

test('a legacy owner receives only native absence observation and no termination authority', windowsOnly, async t => {
  await withFixture(t, { owner: { pid: 42 }, observed: { state: 'absent' } }, async f => {
    assert.equal((await f.uninstall()).installed, false);
    assert.ok(f.calls.includes('query'));
    assert.ok(!f.calls.includes('stop'));
    await assert.rejects(f.lock(), { code: 'ENOENT' });
  });
});

test('a present legacy owner preserves its record without numeric PID termination', windowsOnly, async t => {
  await withFixture(t, { owner: { pid: 42 }, observed: { state: 'present', identity: exact } }, async f => {
    await assert.rejects(f.uninstall());
    assert.ok(f.calls.includes('query'));
    assert.ok(!f.calls.includes('stop'));
    assert.equal(await f.lock(), f.raw);
    assert.ok(!f.calls.includes('/Delete'));
  });
});

test('a stopped response cannot authorize deletion while the exact owner remains current', windowsOnly, async t => {
  await withFixture(t, { observed: { state: 'present', identity: exact }, queryCost: 2000 }, async f => {
    await assert.rejects(f.uninstall());
    assert.equal(await f.lock(), f.raw);
    assert.ok(!f.calls.includes('/Delete'));
  });
});

test('executable mismatch proves old incarnation retirement without deleting a replacement owner', windowsOnly, async t => {
  await withFixture(t, { stopResult: { schema: stopSchema, state: 'reused' },
    observed: { state: 'present', identity: { ...exact, executable_path: 'C:\\other\\node.exe' } } }, async f => {
    assert.equal((await f.uninstall()).installed, false);
    await assert.rejects(f.lock(), { code: 'ENOENT' });
  });
});

for (const owner of [
  { schema: 'unknown', pid: 42 },
  { schema: 'uci_arena_evidence_daemon_lock_v2', pid: 42, processIdentity: null },
  { schema: 'uci_arena_evidence_daemon_lock_v2', pid: 42, processIdentity: { ...exact, platform: 'linux', boot_id: 'other-boot' } },
]) test('unknown or cross-platform owner authority fails before Task End', windowsOnly, async t => {
  await withFixture(t, { owner }, async f => {
    await assert.rejects(f.uninstall());
    assert.equal(await f.lock(), f.raw);
    assert.deepEqual(f.calls, []);
  });
});

test('actual public native helper stops a test-owned daemon when Task End has no effect', windowsOnly, async t => {
  const child = childProcess.spawn(process.execPath, ['--input-type=module', '--eval',
    "process.stdout.write('ready\\n'); setInterval(() => {}, 1000);"], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await Promise.race([exited, new Promise((_, reject) => {
      const timeout = setTimeout(() => reject(new Error('owned stop fixture did not exit within five seconds')), 5000);
      exited.finally(() => clearTimeout(timeout));
    })]);
  });
  await once(child.stdout, 'data', { signal: AbortSignal.timeout(5000) });
  const nativeHelper = path.resolve('native/bin/uci_arena_background_guard.exe');
  const helper = new NativeResourceHelper({ nativeHelper, nativeHelperAvailable: true });
  const observation = helper.queryProcessInstanceSync(child.pid);
  assert.equal(observation.state, 'present');
  const parent = path.resolve('build/test-fixtures');
  await mkdir(parent, { recursive: true });
  const workspace = await mkdtemp(path.join(parent, 'native-owned-stop-'));
  const locks = path.join(workspace, 'locks');
  await mkdir(locks);
  await writeFile(path.join(locks, 'daemon.lock'), JSON.stringify({
    schema: 'uci_arena_evidence_daemon_lock_v2', pid: child.pid, nonce: 'test-owned-native-daemon',
    processIdentity: observation.identity,
  }));
  const calls = [];
  const executeImpl = async (executable, args, execOptions) => {
    assert.equal(executable, 'schtasks.exe'); assert.equal(execOptions.windowsHide, true);
    assert.ok(['/End', '/Delete'].includes(args[0])); calls.push(args[0]);
    return { stdout: '', stderr: '' };
  };
  await configureProcessIdentityProbe(helper);
  const { uninstallStartup } = await import(`../src/platform_startup.mjs?native-owned-stop-${++importId}`);
  let passed = false;
  try {
    const started = performance.now();
    assert.equal((await uninstallStartup({ workspace, paths: { locks } }, { executeImpl })).installed, false);
    assert.ok(performance.now() - started < 2000);
    assert.equal(helper.queryProcessInstanceSync(child.pid).state, 'absent');
    assert.deepEqual(calls, ['/End', '/Delete']);
    await assert.rejects(readFile(path.join(locks, 'daemon.lock')), { code: 'ENOENT' });
    passed = true;
  } finally {
    if (passed) await rm(workspace, { recursive: true, force: true });
    else t.diagnostic(`failed native ownership fixture retained: ${workspace}`);
  }
});
