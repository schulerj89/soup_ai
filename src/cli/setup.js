import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { projectRoot } from '../utils/paths.js';
import {
  buildEnvFileContents,
  buildSetupDefaults,
  discoverTelegramChatIds,
  readExistingEnv,
  writeEnvAndInitializeDb,
} from './setup-lib.js';

async function promptValue(rl, label, defaultValue) {
  const suffix = defaultValue ? ` [${defaultValue}]` : '';
  const answer = await rl.question(`${label}${suffix}: `);
  return answer.trim() || defaultValue || '';
}

async function main() {
  const envPath = path.join(projectRoot, '.env');
  const existingEnv = readExistingEnv(envPath);

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    console.log('Soup AI setup');
    console.log('');

    const defaults = buildSetupDefaults(existingEnv);
    const openAiApiKey = await promptValue(rl, 'OpenAI API key', defaults.openAiApiKey);
    const telegramBotToken = await promptValue(
      rl,
      'Telegram bot token',
      defaults.telegramBotToken,
    );

    const discoveredChatIds = await discoverTelegramChatIds(telegramBotToken);
    const setupDefaults = buildSetupDefaults(existingEnv, discoveredChatIds);

    if (discoveredChatIds.length > 0) {
      console.log(`Discovered chat IDs: ${discoveredChatIds.join(', ')}`);
    }

    const allowedChatIds = await promptValue(
      rl,
      'Allowed Telegram chat IDs (comma-separated)',
      setupDefaults.allowedChatIds,
    );
    const workspaceRoot = await promptValue(
      rl,
      'Workspace root for Codex',
      setupDefaults.workspaceRoot,
    );
    const openAiModel = await promptValue(
      rl,
      'OpenAI model',
      setupDefaults.openAiModel,
    );
    const openAiMemoryModel = await promptValue(
      rl,
      'OpenAI memory model',
      setupDefaults.openAiMemoryModel,
    );
    const openAiTranscriptionModel = await promptValue(
      rl,
      'OpenAI transcription model',
      setupDefaults.openAiTranscriptionModel,
    );
    const dbPath = await promptValue(
      rl,
      'SQLite DB path',
      setupDefaults.dbPath,
    );
    const codexBin = await promptValue(rl, 'Codex binary', setupDefaults.codexBin);
    const codexSearch = await promptValue(
      rl,
      'Enable Codex web search (true/false)',
      setupDefaults.codexSearch,
    );

    const contents = buildEnvFileContents({
      existingEnv,
      values: {
        openAiApiKey,
        telegramBotToken,
        allowedChatIds,
        workspaceRoot,
        openAiModel,
        openAiMemoryModel,
        openAiTranscriptionModel,
        dbPath,
        codexBin,
        codexSearch,
      },
    });

    writeEnvAndInitializeDb({
      envPath,
      contents,
    });

    console.log('');
    console.log(`Wrote ${path.relative(projectRoot, envPath)} and initialized the SQLite database.`);
    console.log('Next steps:');
    console.log('1. npm run supervisor:once');
    console.log('2. npm run task:register');
    console.log('3. Read docs/telegram.md if you still need bot/chat details');
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
