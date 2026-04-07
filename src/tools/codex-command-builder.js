import fs from 'node:fs';
import path from 'node:path';

function pathEnvValue() {
  if (typeof process.env.Path === 'string') {
    return process.env.Path;
  }

  if (typeof process.env.PATH === 'string') {
    return process.env.PATH;
  }

  const key = Object.keys(process.env).find((name) => name.toLowerCase() === 'path');
  return key ? process.env[key] : '';
}

function hasWindowsPathKey() {
  return Object.prototype.hasOwnProperty.call(process.env, 'Path');
}

function quoteForCmd(value) {
  const normalized = Array.from(`${value}`, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;

    if (codePoint <= 31) {
      return ' ';
    }

    return character === '%' ? '%%' : character;
  }).join('');

  if (/^[A-Za-z0-9_./:=+-]+$/.test(normalized)) {
    return normalized;
  }

  return `"${normalized.replace(/"/g, '""')}"`;
}

function resolveBundledCodexScript(command) {
  const extension = path.extname(command).toLowerCase();

  if (!['.cmd', '.bat', '.ps1'].includes(extension)) {
    return null;
  }

  const baseName = path.basename(command, extension).toLowerCase();
  if (baseName !== 'codex') {
    return null;
  }

  const basedir = path.dirname(command);
  const nodeExe = path.join(basedir, process.platform === 'win32' ? 'node.exe' : 'node');
  const codexScript = path.join(basedir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');

  if (!fs.existsSync(nodeExe) || !fs.existsSync(codexScript)) {
    return null;
  }

  return { nodeExe, codexScript };
}

export class CodexCommandBuilder {
  constructor({ codexBin, codexModel, codexEnableSearch }) {
    this.codexBin = codexBin;
    this.codexModel = codexModel;
    this.codexEnableSearch = codexEnableSearch;
  }

  buildArgs({
    prompt,
    workingDirectory,
    modelOverride = this.codexModel,
    outputSchemaPath,
    outputLastMessagePath,
  }) {
    const args = [];

    if (this.codexEnableSearch) {
      args.push('--search');
    }

    args.push('exec', '--dangerously-bypass-approvals-and-sandbox', '-C', workingDirectory);

    if (outputSchemaPath) {
      args.push('--output-schema', outputSchemaPath);
    }

    if (outputLastMessagePath) {
      args.push('-o', outputLastMessagePath);
    }

    if (modelOverride) {
      args.push('-m', modelOverride);
    }

    args.push('--json', '--skip-git-repo-check');
    args.push(prompt);
    return args;
  }

  resolveSpawnCommand() {
    if (path.isAbsolute(this.codexBin) || this.codexBin.includes(path.sep)) {
      return this.codexBin;
    }

    const useWindowsPathResolution = process.platform === 'win32' || hasWindowsPathKey();

    const candidateNames = path.extname(this.codexBin)
      ? [this.codexBin]
      : useWindowsPathResolution
        ? [`${this.codexBin}.cmd`, `${this.codexBin}.exe`, `${this.codexBin}.bat`, this.codexBin]
        : [this.codexBin];

    const candidateDirectories = [
      ...`${pathEnvValue() ?? ''}`.split(path.delimiter).filter(Boolean),
      ...(useWindowsPathResolution
        ? [
            path.dirname(process.execPath),
            process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'nodejs') : null,
            process.env.APPDATA ? path.join(process.env.APPDATA, 'npm') : null,
          ]
        : []),
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

  buildSpawnSpec(args) {
    const command = this.resolveSpawnCommand();
    const extension = path.extname(command).toLowerCase();

    if (process.platform === 'win32') {
      const bundledScript = resolveBundledCodexScript(command);

      if (bundledScript) {
        return {
          command: bundledScript.nodeExe,
          args: [bundledScript.codexScript, ...args],
          shell: false,
        };
      }
    }

    if (process.platform === 'win32' && (extension === '.cmd' || extension === '.bat')) {
      return {
        command: [quoteForCmd(command), ...args.map(quoteForCmd)].join(' '),
        args: [],
        shell: true,
      };
    }

    return { command, args, shell: false };
  }
}
