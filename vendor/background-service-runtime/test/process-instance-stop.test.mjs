import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import { NativeResourceHelper } from '../src/native-resource-helper.mjs';

const schema = 'uci_arena_process_instance_stop_v1';
const identity = { schema: 'uci_arena_process_instance_identity_v1', platform: 'win32', pid: 123,
  start_token: '639111234567890123', executable_path: 'C:\\Program Files\\例\\service.exe', boot_id: '' };
const helper = () => new NativeResourceHelper({ nativeHelperAvailable: true, nativeHelper: 'C:\\explicit\\guard.exe' });
function transport(t, fn) {
  t.mock.method(childProcess, 'execFileSync', fn);
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
}

test('stop capability exists and unavailable helper conservatively refuses', () => {
  const runtime = new NativeResourceHelper({ nativeHelperAvailable: false });
  assert.equal(typeof runtime.stopProcessInstanceSync, 'function');
  assert.deepEqual(runtime.stopProcessInstanceSync(identity), { schema, state: 'unverifiable' });
});

test('full identity and shrinking deadline reach only configured native helper', (t) => {
  const calls = [];
  transport(t, (...args) => { calls.push(args); return Buffer.from(JSON.stringify({ schema, state: 'stopped' })); });
  for (const timeoutMs of [1, 137, 2000]) {
    assert.deepEqual(helper().stopProcessInstanceSync(identity, { timeoutMs }), { schema, state: 'stopped' });
    const [file, argv, options] = calls.at(-1);
    assert.equal(file, 'C:\\explicit\\guard.exe');
    assert.deepEqual(argv, ['--stop-process-instance']);
    assert.equal(options.timeout, timeoutMs);
    assert.equal(options.input, `123\n${identity.start_token}\n${timeoutMs}\n${identity.executable_path}\n`);
    assert.equal(options.maxBuffer, 4096);
    assert.equal(options.windowsHide, true);
    assert.deepEqual(options.stdio, ['pipe', 'pipe', 'ignore']);
  }
});

test('invalid identities and budgets never invoke native process', (t) => {
  let calls = 0;
  transport(t, () => { calls++; });
  for (const invalid of [null, 123, { ...identity, pid: 0 }, { ...identity, pid: 4294967296 },
    { ...identity, start_token: '1' }, { ...identity, start_token: '3155378976000000000' },
    { ...identity, executable_path: 'relative.exe' }, { ...identity, executable_path: 'C:\\bad\n.exe' },
    { ...identity, executable_path: 'C:\\bad\ud800.exe' }, { ...identity, boot_id: 'boot' },
    { ...identity, platform: 'linux' }, { ...identity, extra: true },
    Object.defineProperty({ ...identity }, 'pid', { get() { throw Error('must not run'); } }),
    Object.assign({ ...identity }, { [Symbol('extra')]: true })]) {
    assert.throws(() => helper().stopProcessInstanceSync(invalid), TypeError);
  }
  for (const timeoutMs of [0, -1, 1.5, 2001, NaN, Infinity, '1', null]) {
    assert.throws(() => helper().stopProcessInstanceSync(identity, { timeoutMs }), TypeError);
  }
  assert.throws(() => helper().stopProcessInstanceSync(identity, { extra: true }), TypeError);
  assert.throws(() => helper().stopProcessInstanceSync(identity, Object.defineProperty({}, 'timeoutMs', {
    get() { throw Error('must not run'); }, enumerable: true })), TypeError);
  assert.equal(calls, 0);
});

test('closed native states stay distinct; malformed or oversized output cannot imply exit', (t) => {
  let next;
  transport(t, () => Buffer.from(typeof next === 'string' ? next : JSON.stringify(next)));
  for (const state of ['stopped', 'absent', 'reused', 'unverifiable', 'deferred']) {
    next = { schema, state };
    assert.deepEqual(helper().stopProcessInstanceSync(identity), next);
  }
  for (const invalid of [{ schema, state: 'stopped', identity }, { schema, state: 'present' },
    { schema: 'unknown', state: 'stopped' }, 'broken', ' '.repeat(4097)]) {
    next = invalid;
    assert.deepEqual(helper().stopProcessInstanceSync(identity), { schema, state: 'unverifiable' });
  }
});

test('transport deadline is deferred because termination may have happened without exit proof', (t) => {
  transport(t, () => { throw Object.assign(Error('private error'), { code: 'ETIMEDOUT' }); });
  assert.deepEqual(helper().stopProcessInstanceSync(identity), { schema, state: 'deferred' });
});
