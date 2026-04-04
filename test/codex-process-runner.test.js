import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CodexProcessRunner } from '../src/tools/codex-process-runner.js';

test('CodexProcessRunner keeps only a bounded in-memory tail while writing full output to disk', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'soup-ai-codex-process-'));
  const child = new EventEmitter();
  child.pid = 777;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = {
    end() {},
  };

  const runner = new CodexProcessRunner({
    spawnImpl: () => child,
    timeoutMs: 1000,
    killProcessTree: async () => true,
  });

  try {
    const resultPromise = runner.execute({
      spawnSpec: { command: 'codex', args: ['exec'], shell: false },
      workingDirectory: tempRoot,
      outputDirectory: tempRoot,
      maxBufferedChars: 8,
    });

    child.stdout.emit('data', Buffer.from('0123456789'));
    child.stderr.emit('data', Buffer.from('abcdefghij'));
    child.emit('close', 0, null);

    const result = await resultPromise;

    assert.equal(result.stdout, '23456789');
    assert.equal(result.stderr, 'cdefghij');
    assert.equal(result.stdoutBytes, 10);
    assert.equal(result.stderrBytes, 10);
    assert.equal(result.stdoutTruncated, true);
    assert.equal(result.stderrTruncated, true);
    assert.equal(fs.readFileSync(result.stdoutFilePath, 'utf8'), '0123456789');
    assert.equal(fs.readFileSync(result.stderrFilePath, 'utf8'), 'abcdefghij');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
