import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';

function parseTomlValue(rawValue) {
  const value = rawValue.trim();

  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }

  if (value === 'true') {
    return true;
  }

  if (value === 'false') {
    return false;
  }

  if (!Number.isNaN(Number(value))) {
    return Number(value);
  }

  return value;
}

function parseSimpleToml(text) {
  const root = {};
  const sections = {};
  let currentSection = 'root';

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (!line || line.startsWith('#')) {
      continue;
    }

    const sectionMatch = line.match(/^\[(.+)\]$/);

    if (sectionMatch) {
      currentSection = sectionMatch[1];
      sections[currentSection] ??= {};
      continue;
    }

    const assignmentMatch = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);

    if (!assignmentMatch) {
      continue;
    }

    const [, key, rawValue] = assignmentMatch;
    const target = currentSection === 'root' ? root : sections[currentSection];
    target[key] = parseTomlValue(rawValue);
  }

  return { root, sections };
}

function epochToIso(epochSeconds) {
  return typeof epochSeconds === 'number' ? new Date(epochSeconds * 1000).toISOString() : null;
}

function walkFiles(dirPath, matcher, files = []) {
  if (!fs.existsSync(dirPath)) {
    return files;
  }

  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const entryPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      walkFiles(entryPath, matcher, files);
      continue;
    }

    if (matcher(entryPath)) {
      files.push(entryPath);
    }
  }

  return files;
}

function pathEnvValue() {
  const key = Object.keys(process.env).find((name) => name.toLowerCase() === 'path');
  return key ? process.env[key] : '';
}

export class CodexRunner {
  constructor({ codexBin, workspaceRoot, codexModel, codexEnableSearch, timeoutMs, codexHome }) {
    this.codexBin = codexBin;
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.codexModel = codexModel;
    this.codexEnableSearch = codexEnableSearch;
    this.timeoutMs = timeoutMs;
    this.codexHome = codexHome ?? path.join(os.homedir(), '.codex');
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

  resolveSpawnCommand() {
    if (path.isAbsolute(this.codexBin) || this.codexBin.includes(path.sep)) {
      return this.codexBin;
    }

    if (process.platform !== 'win32') {
      return this.codexBin;
    }

    const candidateNames = path.extname(this.codexBin)
      ? [this.codexBin]
      : [`${this.codexBin}.cmd`, `${this.codexBin}.exe`, `${this.codexBin}.bat`, this.codexBin];

    const candidateDirectories = [
      ...`${pathEnvValue() ?? ''}`.split(path.delimiter).filter(Boolean),
      path.dirname(process.execPath),
      process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'nodejs') : null,
      process.env.APPDATA ? path.join(process.env.APPDATA, 'npm') : null,
    ].filter(Boolean);

    for (const directory of candidateDirectories) {
      for (const candidateName of candidateNames) {
        const candidatePath = path.join(directory, candidateName);

        if (fs.existsSync(candidatePath)) {
          return candidatePath;
        }
      }
    }

    return this.codexBin;
  }

  readConfigSummary() {
    const configPath = path.join(this.codexHome, 'config.toml');

    if (!fs.existsSync(configPath)) {
      return {
        configPath,
        found: false,
      };
    }

    const parsed = parseSimpleToml(fs.readFileSync(configPath, 'utf8'));
    const projectSections = Object.keys(parsed.sections).filter((key) => key.startsWith('projects.'));
    const windowsSection = parsed.sections.windows ?? {};

    return {
      configPath,
      found: true,
      model: parsed.root.model ?? null,
      personality: parsed.root.personality ?? null,
      modelReasoningEffort: parsed.root.model_reasoning_effort ?? null,
      windowsSandbox: windowsSection.sandbox ?? null,
      trustedProjectCount: projectSections.length,
    };
  }

  async readLatestRateLimitTelemetry() {
    const sessionFiles = walkFiles(path.join(this.codexHome, 'sessions'), (entryPath) => entryPath.endsWith('.jsonl'))
      .map((entryPath) => ({
        entryPath,
        mtimeMs: fs.statSync(entryPath).mtimeMs,
      }))
      .sort((left, right) => right.mtimeMs - left.mtimeMs)
      .slice(0, 5);

    for (const sessionFile of sessionFiles) {
      let latestTokenCount = null;
      const input = fs.createReadStream(sessionFile.entryPath, 'utf8');
      const lineReader = readline.createInterface({ input, crlfDelay: Infinity });

      for await (const line of lineReader) {
        try {
          const parsed = JSON.parse(line);

          if (parsed?.payload?.type === 'token_count') {
            latestTokenCount = parsed.payload;
          }
        } catch {
          // Ignore malformed lines in local telemetry files.
        }
      }

      if (latestTokenCount?.rate_limits) {
        return {
          sourceFile: sessionFile.entryPath,
          limitId: latestTokenCount.rate_limits.limit_id ?? null,
          limitName: latestTokenCount.rate_limits.limit_name ?? null,
          planType: latestTokenCount.rate_limits.plan_type ?? null,
          primary: latestTokenCount.rate_limits.primary
            ? {
                usedPercent: latestTokenCount.rate_limits.primary.used_percent ?? null,
                windowMinutes: latestTokenCount.rate_limits.primary.window_minutes ?? null,
                resetsAt: epochToIso(latestTokenCount.rate_limits.primary.resets_at),
              }
            : null,
          secondary: latestTokenCount.rate_limits.secondary
            ? {
                usedPercent: latestTokenCount.rate_limits.secondary.used_percent ?? null,
                windowMinutes: latestTokenCount.rate_limits.secondary.window_minutes ?? null,
                resetsAt: epochToIso(latestTokenCount.rate_limits.secondary.resets_at),
              }
            : null,
          credits: latestTokenCount.rate_limits.credits ?? null,
          lastTokenUsage: latestTokenCount.info?.last_token_usage ?? null,
          totalTokenUsage: latestTokenCount.info?.total_token_usage ?? null,
          modelContextWindow: latestTokenCount.info?.model_context_window ?? null,
        };
      }
    }

    return null;
  }

  async getStatus() {
    return {
      interactiveStatusCommand: '/status',
      note:
        'Codex exposes /status in interactive mode. This tool returns the closest scriptable local equivalent from config.toml and recent session telemetry.',
      config: this.readConfigSummary(),
      rateLimits: await this.readLatestRateLimitTelemetry(),
    };
  }

  async run({ prompt, workingDirectory }) {
    const safeDirectory = this.assertAllowedDirectory(workingDirectory);
    const args = this.buildArgs({ prompt, workingDirectory: safeDirectory });
    const command = this.resolveSpawnCommand();

    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
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
          command: [command, ...args].join(' '),
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
