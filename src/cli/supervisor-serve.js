import { loadConfig } from '../config/load-config.js';
import { AppDb } from '../db/app-db.js';
import { ExecutionPlanner } from '../openai/execution-planner.js';
import { SupervisorAgent } from '../openai/supervisor-agent.js';
import { MemorySummarizer } from '../openai/memory-summarizer.js';
import { AudioTranscriber } from '../openai/audio-transcriber.js';
import { SupervisorService } from '../services/supervisor-service.js';
import { TelegramClient } from '../telegram/telegram-client.js';
import { CodexRunner } from '../tools/codex-runner.js';
import { formatCliError } from '../utils/cli-error.js';
import { acquireWindowsKeepAwake } from '../utils/windows-keep-awake.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function computeFailureDelayMs(error, consecutiveFailures) {
  const retryAfterSeconds =
    error && typeof error === 'object' && Number.isFinite(error.retryAfterSeconds) ? error.retryAfterSeconds : null;

  if (retryAfterSeconds != null) {
    return Math.max(1000, retryAfterSeconds * 1000);
  }

  return Math.min(30000, 1000 * 2 ** Math.min(consecutiveFailures - 1, 5));
}

export async function runSupervisorServe({
  loadConfigFn = loadConfig,
  AppDbClass = AppDb,
  ExecutionPlannerClass = ExecutionPlanner,
  SupervisorAgentClass = SupervisorAgent,
  MemorySummarizerClass = MemorySummarizer,
  AudioTranscriberClass = AudioTranscriber,
  SupervisorServiceClass = SupervisorService,
  TelegramClientClass = TelegramClient,
  CodexRunnerClass = CodexRunner,
  createKeepAwake = acquireWindowsKeepAwake,
  processObject = process,
  consoleObject = console,
  sleepFn = sleep,
} = {}) {
  const config = loadConfigFn();
  const db = new AppDbClass({ dbPath: config.dbPath });
  let stopping = false;
  const signalHandlers = new Map();

  const requestStop = (signal) => {
    if (!stopping) {
      stopping = true;
      consoleObject.log(`[Soup AI] Received ${signal}; shutting down after the current cycle.`);
    }
  };

  for (const signal of ['SIGINT', 'SIGTERM']) {
    const handler = () => requestStop(signal);
    signalHandlers.set(signal, handler);
    processObject.on(signal, handler);
  }

  let keepAwakeHandle = null;
  let runError = null;
  let cleanupError = null;

  try {
    keepAwakeHandle = await createKeepAwake();

    if (keepAwakeHandle.enabled) {
      consoleObject.log('[Soup AI] Windows sleep prevention enabled for supervisor:serve.');
    }

    const telegramClient = new TelegramClientClass({
      token: config.telegramBotToken,
      apiBaseUrl: config.telegramApiBaseUrl,
    });
    const codexRunner = new CodexRunnerClass({
      codexBin: config.codexBin,
      workspaceRoot: config.workspaceRoot,
      codexModel: config.codexModel,
      codexEnableSearch: config.codexEnableSearch,
      timeoutMs: config.codexTimeoutMs,
    });
    const agent = new SupervisorAgentClass({
      model: config.openAiModel,
    });
    const executionPlanner = new ExecutionPlannerClass({
      model: config.openAiModel,
    });
    const memorySummarizer = new MemorySummarizerClass({
      model: config.openAiMemoryModel,
    });
    const audioTranscriber = new AudioTranscriberClass({
      apiKey: config.openAiApiKey,
      model: config.openAiTranscriptionModel,
    });
    const service = new SupervisorServiceClass({
      db,
      telegramClient,
      agent,
      executionPlanner,
      codexRunner,
      config: {
        ...config,
        telegramPollTimeoutSeconds: Math.max(config.telegramPollTimeoutSeconds, 30),
        allowBackgroundCodexTasks: true,
      },
      memorySummarizer,
      audioTranscriber,
    });

    consoleObject.log('[Soup AI] supervisor:serve started.');

    let consecutiveFailures = 0;

    while (!stopping) {
      try {
        const summary = await service.runOnce();

        if (summary.skipped) {
          await sleepFn(5000);
        } else {
          consecutiveFailures = 0;
        }
      } catch (error) {
        consecutiveFailures += 1;
        const delayMs = computeFailureDelayMs(error, consecutiveFailures);
        const message = formatCliError(error);
        consoleObject.error(`[Soup AI] supervisor:serve cycle failed (${consecutiveFailures}): ${message}`);
        consoleObject.error(`[Soup AI] supervisor:serve backing off for ${delayMs}ms before retry.`);

        if (!stopping) {
          await sleepFn(delayMs);
        }
      }
    }
  } catch (error) {
    runError = error;
    throw error;
  } finally {
    for (const [signal, handler] of signalHandlers) {
      processObject.removeListener(signal, handler);
    }

    let releaseError = null;

    try {
      keepAwakeHandle?.release?.();
    } catch (error) {
      releaseError = error;
      consoleObject.error(`[Soup AI] ${formatCliError(error)}`);
    }

    db.close();

    if (releaseError && !runError) {
      cleanupError = releaseError;
    }
  }

  if (cleanupError) {
    throw cleanupError;
  }
}

if (import.meta.main) {
  runSupervisorServe().catch((error) => {
    console.error(formatCliError(error));
    process.exitCode = 1;
  });
}
