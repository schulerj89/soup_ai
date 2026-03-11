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
