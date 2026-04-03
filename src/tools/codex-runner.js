import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { CodexCommandBuilder } from './codex-command-builder.js';
import { CodexProcessRunner } from './codex-process-runner.js';
import {
  extractFinalAgentMessage,
  hasMeaningfulStructuredWork,
  isAcknowledgementLikeText,
  parseCodexStructuredReport,
} from './codex-result-parser.js';
import { CodexStatusReader } from './codex-status-reader.js';

const CODEX_REPORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'status',
    'summary',
    'files_changed',
    'verification',
    'user_message',
  ],
  properties: {
    status: {
      type: 'string',
      enum: ['completed', 'partial', 'failed'],
    },
    summary: { type: 'string' },
    files_changed: {
      type: 'array',
      items: { type: 'string' },
    },
    verification: {
      type: 'array',
      items: { type: 'string' },
    },
    remaining_work: {
      type: 'array',
      items: { type: 'string' },
    },
    git: {
      type: 'object',
      additionalProperties: false,
      required: ['commit_hashes', 'push_succeeded'],
      properties: {
        commit_hashes: {
          type: 'array',
          items: { type: 'string' },
        },
        push_succeeded: {
          type: ['boolean', 'null'],
        },
      },
    },
    user_message: { type: 'string' },
  },
};

export { parseCodexStructuredReport } from './codex-result-parser.js';

export class CodexRunner {
  constructor({
    codexBin,
    workspaceRoot,
    codexModel,
    codexEnableSearch,
    timeoutMs,
    codexHome,
    spawnImpl = spawn,
    killProcessTreeImpl = null,
  }) {
    this.codexBin = codexBin;
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.codexModel = codexModel;
    this.codexEnableSearch = codexEnableSearch;
    this.timeoutMs = timeoutMs;
    this.codexHome = codexHome ?? path.join(os.homedir(), '.codex');
    this.spawnImpl = spawnImpl;
    this.killProcessTreeImpl = killProcessTreeImpl;
    this.commandBuilder = new CodexCommandBuilder({
      codexBin,
      codexModel,
      codexEnableSearch,
    });
    this.statusReader = new CodexStatusReader({
      codexHome: this.codexHome,
    });
    this.processRunner = new CodexProcessRunner({
      spawnImpl: this.spawnImpl,
      timeoutMs: this.timeoutMs,
      killProcessTree: (pid) => this.killProcessTree(pid),
    });
  }

  assertAllowedDirectory(targetDirectory) {
    const resolved = path.resolve(targetDirectory);
    const relative = path.relative(this.workspaceRoot, resolved);

    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Requested working directory is outside SUPERVISOR_WORKSPACE_ROOT: ${resolved}`);
    }

    return resolved;
  }

  buildArgs({ prompt, workingDirectory, modelOverride = this.codexModel, outputSchemaPath, outputLastMessagePath }) {
    return this.commandBuilder.buildArgs({
      prompt,
      workingDirectory,
      modelOverride,
      outputSchemaPath,
      outputLastMessagePath,
    });
  }

  resolveSpawnCommand() {
    return this.commandBuilder.resolveSpawnCommand();
  }

  buildSpawnSpec(args) {
    return this.commandBuilder.buildSpawnSpec(args);
  }

  readConfigSummary() {
    return this.statusReader.readConfigSummary();
  }

  async readLatestRateLimitTelemetry() {
    return this.statusReader.readLatestRateLimitTelemetry();
  }

  async getStatus() {
    return this.statusReader.getStatus();
  }

  async killProcessTree(pid) {
    if (!pid) {
      return false;
    }

    if (this.killProcessTreeImpl) {
      await this.killProcessTreeImpl(pid);
      return true;
    }

    if (process.platform === 'win32') {
      let found = true;

      await new Promise((resolve, reject) => {
        const killer = spawn('taskkill', ['/pid', `${pid}`, '/T', '/F'], {
          windowsHide: true,
        });

        let stderr = '';
        killer.stderr?.on('data', (chunk) => {
          stderr += chunk.toString();
        });
        killer.on('error', reject);
        killer.on('close', () => {
          if (/not found|no running instance|cannot find the process/i.test(stderr)) {
            found = false;
          }
          resolve();
        });
      });

      return found;
    }

    try {
      process.kill(pid, 'SIGTERM');
      return true;
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ESRCH') {
        return false;
      }

      throw error;
    }
  }

  async run({ prompt, workingDirectory, onSpawn = null, onExit = null, onStdout = null, onStderr = null }) {
    const safeDirectory = this.assertAllowedDirectory(workingDirectory);
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soup-ai-codex-'));
    const outputSchemaPath = path.join(tempDir, `codex-schema-${randomUUID()}.json`);
    const outputLastMessagePath = path.join(tempDir, `codex-output-${randomUUID()}.json`);
    const startedAt = new Date().toISOString();
    fs.writeFileSync(outputSchemaPath, JSON.stringify(CODEX_REPORT_SCHEMA, null, 2), 'utf8');

    try {
      const initialArgs = this.buildArgs({
        prompt,
        workingDirectory: safeDirectory,
        outputSchemaPath,
        outputLastMessagePath,
      });
      const initialResult = await this.processRunner.execute({
        spawnSpec: this.buildSpawnSpec(initialArgs),
        workingDirectory: safeDirectory,
        onSpawn: (event) =>
          onSpawn?.({
            ...event,
            startedAt,
            timeoutMs: this.timeoutMs,
            outputSchemaPath,
            outputLastMessagePath,
          }),
        onExit,
        onStdout,
        onStderr,
      });

      let finalResult = initialResult;

      if (
        initialResult.exitCode !== 0 &&
        this.codexModel &&
        /model is not supported/i.test(initialResult.stderr)
      ) {
        const fallbackArgs = this.buildArgs({
          prompt,
          workingDirectory: safeDirectory,
          modelOverride: null,
          outputSchemaPath,
          outputLastMessagePath,
        });
        const fallbackResult = await this.processRunner.execute({
          spawnSpec: this.buildSpawnSpec(fallbackArgs),
          workingDirectory: safeDirectory,
          onSpawn: (event) =>
            onSpawn?.({
              ...event,
              startedAt,
              timeoutMs: this.timeoutMs,
              outputSchemaPath,
              outputLastMessagePath,
            }),
          onExit,
          onStdout,
          onStderr,
        });

        finalResult = {
          ...fallbackResult,
          stderr: [
            `Configured CODEX_MODEL=${this.codexModel} was rejected by Codex; retried without an explicit model.`,
            initialResult.stderr.trim(),
            fallbackResult.stderr.trim(),
          ]
            .filter(Boolean)
            .join('\n\n'),
        };
      }

      const outputLastMessage = fs.existsSync(outputLastMessagePath)
        ? fs.readFileSync(outputLastMessagePath, 'utf8').trim()
        : null;
      const finalAgentMessage = extractFinalAgentMessage(finalResult.stdout) ?? outputLastMessage;
      const structuredReport = parseCodexStructuredReport(finalAgentMessage);
      const acknowledgedOnly =
        finalResult.exitCode === 0 &&
        (structuredReport ? !hasMeaningfulStructuredWork(structuredReport) : isAcknowledgementLikeText(finalAgentMessage));

      return {
        ...finalResult,
        outputLastMessage,
        finalAgentMessage,
        structuredReport,
        acknowledgedOnly,
      };
    } finally {
      if (fs.existsSync(outputSchemaPath)) {
        fs.unlinkSync(outputSchemaPath);
      }
      if (fs.existsSync(outputLastMessagePath)) {
        fs.unlinkSync(outputLastMessagePath);
      }
      if (fs.existsSync(tempDir)) {
        fs.rmdirSync(tempDir);
      }
    }
  }
}
