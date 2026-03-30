export class CodexProcessRunner {
  constructor({
    spawnImpl,
    timeoutMs,
    killProcessTree,
  }) {
    this.spawnImpl = spawnImpl;
    this.timeoutMs = timeoutMs;
    this.killProcessTree = killProcessTree;
  }

  async execute({ spawnSpec, workingDirectory, onSpawn = null, onExit = null }) {
    return new Promise((resolve, reject) => {
      const child = this.spawnImpl(spawnSpec.command, spawnSpec.args, {
        cwd: workingDirectory,
        shell: spawnSpec.shell,
        windowsHide: true,
      });

      let stdout = '';
      let stderr = '';
      let settled = false;
      let timedOut = false;
      let finalized = false;

      const finalizeExit = async () => {
        if (finalized) {
          return;
        }

        finalized = true;

        if (onExit) {
          await onExit({ pid: child.pid, timedOut });
        }
      };

      if (onSpawn) {
        Promise.resolve(onSpawn({ pid: child.pid })).catch(() => {});
      }

      const timeout = setTimeout(() => {
        timedOut = true;
        void this.killProcessTree(child.pid).catch(() => {});
      }, this.timeoutMs);

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });

      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      child.on('error', (error) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timeout);
        void finalizeExit().finally(() => reject(error));
      });

      child.on('close', (exitCode, signal) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timeout);
        void finalizeExit().finally(() =>
          resolve({
            command: [spawnSpec.command, ...spawnSpec.args].join(' '),
            workingDirectory,
            stdout,
            stderr,
            exitCode: exitCode ?? (timedOut ? -1 : null),
            signal,
            timedOut,
          }),
        );
      });
    });
  }
}
