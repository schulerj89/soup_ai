import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_CAPTURE_MAX_CHARS = 64 * 1024;

function appendBoundedTail(current, addition, maxChars) {
  const max = Number.isFinite(maxChars) && maxChars > 0 ? maxChars : DEFAULT_CAPTURE_MAX_CHARS;
  const next = `${current}${addition}`;

  if (next.length <= max) {
    return next;
  }

  return next.slice(-max);
}

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

  async execute({
    spawnSpec,
    workingDirectory,
    outputDirectory = os.tmpdir(),
    maxBufferedChars = DEFAULT_CAPTURE_MAX_CHARS,
    onSpawn = null,
    onExit = null,
    onStdout = null,
    onStderr = null,
  }) {
    return new Promise((resolve, reject) => {
      fs.mkdirSync(outputDirectory, { recursive: true });
      const stdoutFilePath = path.join(outputDirectory, 'stdout.log');
      const stderrFilePath = path.join(outputDirectory, 'stderr.log');
      const stdoutStream = fs.createWriteStream(stdoutFilePath, { flags: 'w' });
      const stderrStream = fs.createWriteStream(stderrFilePath, { flags: 'w' });
      const child = this.spawnImpl(spawnSpec.command, spawnSpec.args, {
        cwd: workingDirectory,
        shell: spawnSpec.shell,
        windowsHide: true,
      });

      // `codex exec` can wait for more prompt content from stdin if the pipe stays open.
      // We pass the full prompt as an argument, so close stdin immediately.
      try {
        child.stdin?.end();
      } catch {
        // Ignore stdin closure failures and let normal process handling continue.
      }

      let stdout = '';
      let stderr = '';
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      let timedOut = false;
      let finalized = false;

      const closeCaptureStreams = async () => {
        await Promise.all(
          [stdoutStream, stderrStream].map(
            (stream) =>
              new Promise((resolveStream) => {
                if (stream.destroyed) {
                  resolveStream();
                  return;
                }

                stream.end(resolveStream);
              }),
          ),
        );
      };

      const finalizeExit = async () => {
        if (finalized) {
          return;
        }

        finalized = true;
        await closeCaptureStreams();

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
        const text = chunk.toString();
        stdoutStream.write(chunk);
        stdoutBytes += Buffer.byteLength(text, 'utf8');
        stdout = appendBoundedTail(stdout, text, maxBufferedChars);
        if (onStdout) {
          Promise.resolve(onStdout({ pid: child.pid, chunk: text, timestamp: new Date().toISOString() })).catch(() => {});
        }
      });

      child.stderr.on('data', (chunk) => {
        const text = chunk.toString();
        stderrStream.write(chunk);
        stderrBytes += Buffer.byteLength(text, 'utf8');
        stderr = appendBoundedTail(stderr, text, maxBufferedChars);
        if (onStderr) {
          Promise.resolve(onStderr({ pid: child.pid, chunk: text, timestamp: new Date().toISOString() })).catch(() => {});
        }
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
            stdoutBytes,
            stderrBytes,
            stdoutFilePath,
            stderrFilePath,
            stdoutTruncated: stdout.length < stdoutBytes,
            stderrTruncated: stderr.length < stderrBytes,
            exitCode: exitCode ?? (timedOut ? -1 : null),
            signal,
            timedOut,
          }),
        );
      });
    });
  }
}
