import { loadConfig } from '../config/load-config.js';
import { AppDb } from '../db/app-db.js';
import { ExecutionPlanner } from '../openai/execution-planner.js';
import { SupervisorAgent } from '../openai/supervisor-agent.js';
import { MemorySummarizer } from '../openai/memory-summarizer.js';
import { AudioTranscriber } from '../openai/audio-transcriber.js';
import { SupervisorService } from '../services/supervisor-service.js';
import { TelegramClient } from '../telegram/telegram-client.js';
import { CodexRunner } from '../tools/codex-runner.js';

async function main() {
  const config = loadConfig();
  const db = new AppDb({ dbPath: config.dbPath });

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
      config,
      memorySummarizer,
      audioTranscriber,
    });

    const summary = await service.runOnce();
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
