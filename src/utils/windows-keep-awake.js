const ES_CONTINUOUS = 0x80000000;
const ES_SYSTEM_REQUIRED = 0x00000001;

async function loadDefaultBinding() {
  const { default: koffi } = await import('koffi');
  const kernel32 = koffi.load('kernel32.dll');
  const setThreadExecutionState = kernel32.func('uint SetThreadExecutionState(uint)');

  return {
    setThreadExecutionState(flags) {
      return setThreadExecutionState(flags);
    },
  };
}

export async function acquireWindowsKeepAwake({
  platform = process.platform,
  loadBinding = loadDefaultBinding,
} = {}) {
  if (platform !== 'win32') {
    return {
      enabled: false,
      release() {},
    };
  }

  const binding = await loadBinding();
  const startFlags = ES_CONTINUOUS | ES_SYSTEM_REQUIRED;
  const resetFlags = ES_CONTINUOUS;
  let released = false;

  if (!binding.setThreadExecutionState(startFlags)) {
    throw new Error('SetThreadExecutionState failed to enable Windows sleep prevention.');
  }

  return {
    enabled: true,
    release() {
      if (released) {
        return;
      }

      released = true;

      if (!binding.setThreadExecutionState(resetFlags)) {
        throw new Error('SetThreadExecutionState failed to clear Windows sleep prevention.');
      }
    },
  };
}

export const windowsKeepAwakeFlags = {
  continuous: ES_CONTINUOUS,
  systemRequired: ES_SYSTEM_REQUIRED,
};
