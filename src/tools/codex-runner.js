import path from 'node:path';
import { spawn } from 'node:child_process';

export class CodexRunner {
  constructor({ codexBin, workspaceRoot, codexModel, codexEnableSearch, timeoutMs }) {
    this.codexBin = codexBin;
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.codexModel = codexModel;
    this.codexEnableSearch = codexEnableSearch;
    this.timeoutMs = timeoutMs;
  }

  assertAllowedDirectory(targetDirectory) {
    const resolved = path.resolve(targetDirectory);
    const relative = path.relative(this.workspaceRoot, resolved);

    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Requested working directory is outside SUPERVISOR_WORKSPACE_ROOT: ${resolved}`);
    }

    return resolved;
  }

  buildArgs({ prompt, workingDirectory }) {
    const args = [
      'exec',
      '--dangerously-bypass-approvals-and-sandbox',
      '-C',
      workingDirectory,
    ];

    if (this.codexModel) {
      args.push('-m', this.codexModel);
    }

    if (this.codexEnableSearch) {
      args.push('--search');
    }

    args.push(prompt);
    return args;
  }

  async run({ prompt, workingDirectory }) {
    const safeDirectory = this.assertAllowedDirectory(workingDirectory);
    const args = this.buildArgs({ prompt, workingDirectory: safeDirectory });

    return new Promise((resolve, reject) => {
      const child = spawn(this.codexBin, args, {
        cwd: safeDirectory,
        shell: false,
        windowsHide: true,
      });

      let stdout = '';
      let stderr = '';
      let settled = false;
      let timedOut = false;

      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill();
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
        reject(error);
      });

      child.on('close', (exitCode, signal) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timeout);

        resolve({
          command: [this.codexBin, ...args].join(' '),
          workingDirectory: safeDirectory,
          stdout,
          stderr,
          exitCode: exitCode ?? (timedOut ? -1 : null),
          signal,
          timedOut,
        });
      });
    });
  }
}
