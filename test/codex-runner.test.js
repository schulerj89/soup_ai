import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexRunner } from '../src/tools/codex-runner.js';

test('CodexRunner reads config and recent rate-limit telemetry', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'soup-ai-codex-'));
  const codexHome = path.join(tempRoot, '.codex');
  const sessionsDir = path.join(codexHome, 'sessions', '2026', '03', '11');

  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(
    path.join(codexHome, 'config.toml'),
    [
      'model = "gpt-5.4"',
      'personality = "pragmatic"',
      'model_reasoning_effort = "high"',
      '',
      '[windows]',
      'sandbox = "elevated"',
      '',
      "[projects.'C:\\Users\\joshs\\Projects']",
      'trust_level = "trusted"',
      '',
    ].join('\n'),
    'utf8',
  );

  fs.writeFileSync(
    path.join(sessionsDir, 'latest.jsonl'),
    JSON.stringify({
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: { total_tokens: 1234 },
          total_token_usage: { total_tokens: 9999 },
          model_context_window: 258400,
        },
        rate_limits: {
          limit_id: 'codex',
          limit_name: 'Codex',
          primary: {
            used_percent: 12,
            window_minutes: 300,
            resets_at: 1773240000,
          },
          secondary: {
            used_percent: 33,
            window_minutes: 10080,
            resets_at: 1773844800,
          },
          credits: {
            has_credits: false,
            unlimited: false,
            balance: null,
          },
          plan_type: 'plus',
        },
      },
    }) + '\n',
    'utf8',
  );

  const runner = new CodexRunner({
    codexBin: 'codex',
    workspaceRoot: 'C:/Users/joshs/Projects',
    codexModel: null,
    codexEnableSearch: false,
    timeoutMs: 1000,
    codexHome,
  });

  const status = await runner.getStatus();

  assert.equal(status.config.model, 'gpt-5.4');
  assert.equal(status.config.windowsSandbox, 'elevated');
  assert.equal(status.rateLimits.limitId, 'codex');
  assert.equal(status.rateLimits.primary.usedPercent, 12);
  assert.equal(status.rateLimits.lastTokenUsage.total_tokens, 1234);
});

test('CodexRunner resolves codex.cmd on Windows-style PATHs', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'soup-ai-codex-path-'));
  const binDir = path.join(tempRoot, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, 'codex.cmd'), '@echo off\r\n', 'utf8');

  const originalPath = process.env.Path;
  process.env.Path = binDir;

  try {
    const runner = new CodexRunner({
      codexBin: 'codex',
      workspaceRoot: 'C:/Users/joshs/Projects',
      codexModel: null,
      codexEnableSearch: false,
      timeoutMs: 1000,
      codexHome: tempRoot,
    });

    const resolved = runner.resolveSpawnCommand();
    assert.match(resolved.toLowerCase(), /codex\.cmd$/);
  } finally {
    process.env.Path = originalPath;
  }
});

test('CodexRunner wraps codex.cmd with cmd.exe on Windows', () => {
  const runner = new CodexRunner({
    codexBin: 'C:\\Users\\joshs\\AppData\\Roaming\\npm\\codex.cmd',
    workspaceRoot: 'C:/Users/joshs/Projects',
    codexModel: null,
    codexEnableSearch: false,
    timeoutMs: 1000,
    codexHome: os.tmpdir(),
  });

  const originalPlatform = process.platform;
  const originalComSpec = process.env.comspec;

  Object.defineProperty(process, 'platform', { value: 'win32' });
  process.env.comspec = 'C:\\Windows\\System32\\cmd.exe';

  try {
    const spec = runner.buildSpawnSpec(['exec', 'test']);
    assert.equal(spec.command, '"C:\\Users\\joshs\\AppData\\Roaming\\npm\\codex.cmd" exec test');
    assert.deepEqual(spec.args, []);
    assert.equal(spec.shell, true);
  } finally {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    process.env.comspec = originalComSpec;
  }
});

test('CodexRunner keeps direct spawn for executables on Windows', () => {
  const runner = new CodexRunner({
    codexBin: 'C:\\tools\\codex.exe',
    workspaceRoot: 'C:/Users/joshs/Projects',
    codexModel: null,
    codexEnableSearch: false,
    timeoutMs: 1000,
    codexHome: os.tmpdir(),
  });

  const originalPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'win32' });

  try {
    const spec = runner.buildSpawnSpec(['exec', 'test']);
    assert.equal(spec.command, 'C:\\tools\\codex.exe');
    assert.deepEqual(spec.args, ['exec', 'test']);
    assert.equal(spec.shell, false);
  } finally {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  }
});

test('CodexRunner places top-level search before exec and model after exec', () => {
  const runner = new CodexRunner({
    codexBin: 'codex',
    workspaceRoot: 'C:/Users/joshs/Projects',
    codexModel: 'gpt-5.4',
    codexEnableSearch: true,
    timeoutMs: 1000,
    codexHome: os.tmpdir(),
  });

  assert.deepEqual(runner.buildArgs({ prompt: 'test prompt', workingDirectory: 'C:/Users/joshs/Projects/soup_ai' }), [
    '--search',
    'exec',
    '--dangerously-bypass-approvals-and-sandbox',
    '-C',
    'C:/Users/joshs/Projects/soup_ai',
    '-m',
    'gpt-5.4',
    '--json',
    '--skip-git-repo-check',
    'test prompt',
  ]);
});
