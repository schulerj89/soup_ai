import assert from 'node:assert/strict';
import test from 'node:test';
import { acquireWindowsKeepAwake, windowsKeepAwakeFlags } from '../src/utils/windows-keep-awake.js';

test('acquireWindowsKeepAwake is a no-op outside Windows', async () => {
  let loadAttempts = 0;

  const handle = await acquireWindowsKeepAwake({
    platform: 'linux',
    loadBinding: async () => {
      loadAttempts += 1;
      throw new Error('should not load binding');
    },
  });

  assert.equal(handle.enabled, false);
  assert.equal(loadAttempts, 0);
  assert.doesNotThrow(() => handle.release());
});

test('acquireWindowsKeepAwake enables and clears SetThreadExecutionState on Windows', async () => {
  const calls = [];

  const handle = await acquireWindowsKeepAwake({
    platform: 'win32',
    loadBinding: async () => ({
      setThreadExecutionState(flags) {
        calls.push(flags);
        return 1;
      },
    }),
  });

  assert.equal(handle.enabled, true);
  handle.release();
  handle.release();

  assert.deepEqual(calls, [
    windowsKeepAwakeFlags.continuous | windowsKeepAwakeFlags.systemRequired,
    windowsKeepAwakeFlags.continuous,
  ]);
});

test('acquireWindowsKeepAwake surfaces Windows API failures', async () => {
  await assert.rejects(
    acquireWindowsKeepAwake({
      platform: 'win32',
      loadBinding: async () => ({
        setThreadExecutionState() {
          return 0;
        },
      }),
    }),
    /failed to enable Windows sleep prevention/i,
  );
});
