import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CodexRunner, parseCodexStructuredReport } from '../src/tools/codex-runner.js';
import { isAcknowledgementLikeText } from '../src/tools/codex-result-parser.js';

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

test('CodexRunner bypasses Windows codex launcher scripts when bundled node and codex.js are present', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'soup-ai-codex-launcher-'));
  const binDir = path.join(tempRoot, 'bin');
  const packageDir = path.join(binDir, 'node_modules', '@openai', 'codex', 'bin');
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, 'codex.ps1'), 'placeholder', 'utf8');
  fs.writeFileSync(path.join(binDir, 'node.exe'), '', 'utf8');
  fs.writeFileSync(path.join(packageDir, 'codex.js'), '', 'utf8');

  const runner = new CodexRunner({
    codexBin: path.join(binDir, 'codex.ps1'),
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
    assert.equal(spec.command, path.join(binDir, 'node.exe'));
    assert.deepEqual(spec.args, [path.join(packageDir, 'codex.js'), 'exec', 'test']);
    assert.equal(spec.shell, false);
  } finally {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
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

test('CodexRunner terminates the full process tree when a Windows codex command times out', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'soup-ai-codex-timeout-'));
  const workspaceRoot = tempRoot;
  const workingDirectory = path.join(tempRoot, 'workspace');
  fs.mkdirSync(workingDirectory, { recursive: true });

  const child = new EventEmitter();
  child.pid = 4321;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {
    throw new Error('child.kill should not be used for Windows tree termination');
  };

  let terminatedPid = null;
  let spawnCalls = 0;
  const lifecycle = [];

  const runner = new CodexRunner({
    codexBin: 'C:\\Users\\joshs\\AppData\\Roaming\\npm\\codex.cmd',
    workspaceRoot,
    codexModel: null,
    codexEnableSearch: false,
    timeoutMs: 5,
    codexHome: tempRoot,
    spawnImpl: () => {
      spawnCalls += 1;
      return child;
    },
    killProcessTreeImpl: async (pid) => {
      terminatedPid = pid;
      setImmediate(() => {
        child.emit('close', null, 'SIGTERM');
      });
    },
  });

  const originalPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'win32' });

  try {
    const result = await runner.run({
      prompt: 'Timeout test',
      workingDirectory,
      onSpawn: ({ pid }) => lifecycle.push(`spawn:${pid}`),
      onExit: ({ pid, timedOut }) => lifecycle.push(`exit:${pid}:${timedOut}`),
    });

    assert.equal(spawnCalls, 1);
    assert.equal(terminatedPid, 4321);
    assert.deepEqual(lifecycle, ['spawn:4321', 'exit:4321:true']);
    assert.equal(result.timedOut, true);
    assert.equal(result.exitCode, -1);
    assert.equal(result.signal, 'SIGTERM');
  } finally {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  }
});

test('CodexRunner closes stdin immediately after spawn so codex does not wait for extra input', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'soup-ai-codex-stdin-'));
  const workingDirectory = path.join(tempRoot, 'workspace');
  fs.mkdirSync(workingDirectory, { recursive: true });

  const child = new EventEmitter();
  child.pid = 9876;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();

  let stdinClosed = false;
  child.stdin = {
    end() {
      stdinClosed = true;
      setImmediate(() => child.emit('close', 0, null));
    },
  };

  const runner = new CodexRunner({
    codexBin: 'codex',
    workspaceRoot: tempRoot,
    codexModel: null,
    codexEnableSearch: false,
    timeoutMs: 1000,
    codexHome: tempRoot,
    spawnImpl: () => child,
  });

  const result = await runner.run({
    prompt: 'stdin close test',
    workingDirectory,
  });

  assert.equal(stdinClosed, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
});

test('CodexRunner writes a strict git schema compatible with Codex structured output validation', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'soup-ai-codex-schema-'));
  const workingDirectory = path.join(tempRoot, 'workspace');
  fs.mkdirSync(workingDirectory, { recursive: true });

  const child = new EventEmitter();
  child.pid = 2468;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = {
    end() {
      setImmediate(() => child.emit('close', 0, null));
    },
  };

  const runner = new CodexRunner({
    codexBin: 'codex',
    workspaceRoot: tempRoot,
    codexModel: null,
    codexEnableSearch: false,
    timeoutMs: 1000,
    codexHome: tempRoot,
    spawnImpl: () => child,
  });

  let schema = null;

  await runner.run({
    prompt: 'schema validation test',
    workingDirectory,
    onSpawn: ({ outputSchemaPath }) => {
      schema = JSON.parse(fs.readFileSync(outputSchemaPath, 'utf8'));
    },
  });

  assert.deepEqual(schema?.required, ['status', 'summary', 'files_changed', 'verification', 'remaining_work', 'git', 'user_message']);
  assert.deepEqual(schema?.properties?.git?.type, ['object', 'null']);
  assert.deepEqual(schema?.properties?.git?.required, ['commit_hashes', 'push_succeeded']);
  assert.deepEqual(schema?.properties?.git?.properties?.push_succeeded?.type, ['boolean', 'null']);
});

test('parseCodexStructuredReport accepts a marker-delimited JSON ending', () => {
  assert.deepEqual(
    parseCodexStructuredReport(
      [
        'Updated the requested files and ran tests.',
        '',
        'CODEX_RESULT_JSON:',
        '{"status":"completed","summary":"Updated files.","files_changed":["src/example.js"],"verification":["npm test"],"remaining_work":[],"git":{"commit_hashes":["abc123","def456"],"push_succeeded":true},"user_message":"Updated the requested files and ran tests."}',
      ].join('\n'),
    ),
    {
      status: 'completed',
      summary: 'Updated files.',
      files_changed: ['src/example.js'],
      verification: ['npm test'],
      remaining_work: [],
      git: {
        commit_hashes: ['abc123', 'def456'],
        push_succeeded: true,
      },
      user_message: 'Updated the requested files and ran tests.',
    },
  );
});

test('parseCodexStructuredReport falls back to the trailing JSON object without a marker', () => {
  assert.deepEqual(
    parseCodexStructuredReport(
      'Applied the change.\n{"status":"failed","summary":"Blocked on follow-up.","files_changed":[],"verification":[],"remaining_work":["Need approval."],"user_message":"Blocked on follow-up."}',
    ),
    {
      status: 'failed',
      summary: 'Blocked on follow-up.',
      files_changed: [],
      verification: [],
      remaining_work: ['Need approval.'],
      user_message: 'Blocked on follow-up.',
    },
  );
});

test('parseCodexStructuredReport normalizes legacy single commit hash into commit_hashes', () => {
  assert.deepEqual(
    parseCodexStructuredReport(
      'Applied the change.\n{"status":"completed","summary":"Completed work.","files_changed":["src/example.js"],"verification":["npm test"],"commit_hash":"abc123","push_succeeded":true,"follow_up":null,"raw_user_visible_output":"Completed work."}',
    ),
    {
      status: 'completed',
      summary: 'Completed work.',
      files_changed: ['src/example.js'],
      verification: ['npm test'],
      remaining_work: [],
      git: {
        commit_hashes: ['abc123'],
        push_succeeded: true,
      },
      user_message: 'Completed work.',
    },
  );
});

test('isAcknowledgementLikeText accepts smart-apostrophe variants from Codex output', () => {
  assert.equal(isAcknowledgementLikeText('I’ll treat the workspace root as trusted.'), true);
  assert.equal(isAcknowledgementLikeText('Iâ€™ll treat the workspace root as trusted.'), true);
  assert.equal(isAcknowledgementLikeText('Implemented the requested fix.'), false);
});
