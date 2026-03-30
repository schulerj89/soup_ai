import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { CodexCommandBuilder } from './codex-command-builder.js';
import { CodexStatusReader } from './codex-status-reader.js';

const CODEX_REPORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'completed',
    'summary',
    'files_changed',
    'verification',
    'commit_hash',
    'push_succeeded',
    'follow_up',
    'raw_user_visible_output',
  ],
  properties: {
    completed: { type: 'boolean' },
    summary: { type: 'string' },
    files_changed: {
      type: 'array',
      items: { type: 'string' },
    },
    verification: {
      type: 'array',
      items: { type: 'string' },
    },
    commit_hash: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
    },
    push_succeeded: {
      anyOf: [{ type: 'boolean' }, { type: 'null' }],
    },
    follow_up: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
    },
    raw_user_visible_output: { type: 'string' },
  },
};

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parseJsonObject(value) {
  const parsed = safeJsonParse(value);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
}

function extractTrailingJsonObject(value) {
  const normalized = `${value ?? ''}`.trim();

  if (!normalized.endsWith('}')) {
    return null;
  }

  for (let index = normalized.lastIndexOf('{'); index >= 0; index = normalized.lastIndexOf('{', index - 1)) {
    const candidate = normalized.slice(index).trim();
    const parsed = parseJsonObject(candidate);

    if (parsed) {
      return parsed;
    }
  }

  return null;
}

export function parseCodexStructuredReport(value) {
  const normalized = `${value ?? ''}`.trim();

  if (!normalized) {
    return null;
  }

  const direct = parseJsonObject(normalized);
  if (direct) {
    return direct;
  }

  const marker = 'CODEX_RESULT_JSON:';
  const markerIndex = normalized.lastIndexOf(marker);

  if (markerIndex >= 0) {
    return extractTrailingJsonObject(normalized.slice(markerIndex + marker.length));
  }

  return extractTrailingJsonObject(normalized);
}

function isAcknowledgementLikeText(text) {
  const normalized = `${text ?? ''}`.trim();

  if (!normalized) {
    return true;
  }

  return /^(noted\.|using workspace root|workspace root noted|i(?:'|â€™|’)ll treat\b|i(?:'|â€™|’)m treating\b|recorded the workspace root)/i.test(
    normalized,
  );
}

function extractFinalAgentMessage(stdout) {
  let finalMessage = null;

  for (const rawLine of `${stdout ?? ''}`.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (!line) {
      continue;
    }

    const parsed = safeJsonParse(line);
    if (!parsed || typeof parsed !== 'object') {
      continue;
    }

    if (parsed.type === 'item.completed' && parsed.item?.type === 'agent_message' && typeof parsed.item.text === 'string') {
      finalMessage = parsed.item.text;
    }
  }

  return finalMessage;
}

function hasMeaningfulStructuredWork(report) {
  if (!report || report.completed !== true) {
    return false;
  }

  if (`${report.follow_up ?? ''}`.trim()) {
    return false;
  }

  if ((report.files_changed?.length ?? 0) > 0 || (report.verification?.length ?? 0) > 0 || report.commit_hash) {
    return true;
  }

  const candidateText = `${report.summary ?? ''}\n${report.raw_user_visible_output ?? ''}`.trim();
  return !isAcknowledgementLikeText(candidateText);
}

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

  async run({ prompt, workingDirectory, onSpawn = null, onExit = null }) {
    const safeDirectory = this.assertAllowedDirectory(workingDirectory);
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soup-ai-codex-'));
    const outputSchemaPath = path.join(tempDir, `codex-schema-${randomUUID()}.json`);
    const outputLastMessagePath = path.join(tempDir, `codex-output-${randomUUID()}.json`);
    fs.writeFileSync(outputSchemaPath, JSON.stringify(CODEX_REPORT_SCHEMA, null, 2), 'utf8');

    const execute = (args) => {
      const spawnSpec = this.buildSpawnSpec(args);

      return new Promise((resolve, reject) => {
        const child = this.spawnImpl(spawnSpec.command, spawnSpec.args, {
          cwd: safeDirectory,
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
              workingDirectory: safeDirectory,
              stdout,
              stderr,
              exitCode: exitCode ?? (timedOut ? -1 : null),
              signal,
              timedOut,
            }),
          );
        });
      });
    };

    try {
      const initialArgs = this.buildArgs({
        prompt,
        workingDirectory: safeDirectory,
        outputSchemaPath,
        outputLastMessagePath,
      });
      const initialResult = await execute(initialArgs);

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
        const fallbackResult = await execute(fallbackArgs);

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
