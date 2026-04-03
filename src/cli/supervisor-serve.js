import { loadConfig } from '../config/load-config.js';
import { AppDb } from '../db/app-db.js';
import { ExecutionPlanner } from '../openai/execution-planner.js';
import { SupervisorAgent } from '../openai/supervisor-agent.js';
import { MemorySummarizer } from '../openai/memory-summarizer.js';
import { AudioTranscriber } from '../openai/audio-transcriber.js';
import { SupervisorService } from '../services/supervisor-service.js';
import { TelegramClient } from '../telegram/telegram-client.js';
import { CodexRunner } from '../tools/codex-runner.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const config = loadConfig();
  const db = new AppDb({ dbPath: config.dbPath });
  let stopping = false;

  const requestStop = (signal) => {
    if (!stopping) {
      stopping = true;
      console.log(`[Soup AI] Received ${signal}; shutting down after the current cycle.`);
    }
  };

  process.on('SIGINT', () => requestStop('SIGINT'));
  process.on('SIGTERM', () => requestStop('SIGTERM'));

  try {
    const telegramClient = new TelegramClient({
      token: config.telegramBotToken,
      apiBaseUrl: config.telegramApiBaseUrl,
    });
    const codexRunner = new CodexRunner({
      codexBin: config.codexBin,
      workspaceRoot: config.workspaceRoot,
      codexModel: config.codexModel,
      codexEnableSearch: config.codexEnableSearch,
      timeoutMs: config.codexTimeoutMs,
    });
    const agent = new SupervisorAgent({
      model: config.openAiModel,
    });
    const executionPlanner = new ExecutionPlanner({
      model: config.openAiModel,
    });
    const memorySummarizer = new MemorySummarizer({
      model: config.openAiMemoryModel,
    });
    const audioTranscriber = new AudioTranscriber({
      apiKey: config.openAiApiKey,
      model: config.openAiTranscriptionModel,
    });
    const service = new SupervisorService({
      db,
      telegramClient,
      agent,
      executionPlanner,
      codexRunner,
      config: {
        ...config,
        telegramPollTimeoutSeconds: Math.max(config.telegramPollTimeoutSeconds, 30),
      },
      memorySummarizer,
      audioTranscriber,
    });

    console.log('[Soup AI] supervisor:serve started.');

    let consecutiveFailures = 0;

    while (!stopping) {
      try {
        const summary = await service.runOnce();

        if (summary.skipped) {
          await sleep(5000);
        } else {
          consecutiveFailures = 0;
        }
      } catch (error) {
        consecutiveFailures += 1;
        const delayMs = Math.min(30000, 1000 * 2 ** Math.min(consecutiveFailures - 1, 5));
        const message = error instanceof Error ? error.stack ?? error.message : `${error}`;
        console.error(`[Soup AI] supervisor:serve cycle failed (${consecutiveFailures}): ${message}`);

        if (!stopping) {
          await sleep(delayMs);
        }
      }
    }
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
