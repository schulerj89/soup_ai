import path from 'node:path';
import React, { useEffect, useMemo, useState } from 'react';
import { render, Box, Text, useApp, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { projectRoot } from '../utils/paths.js';
import {
  buildEnvFileContents,
  buildSetupDefaults,
  discoverTelegramChatIds,
  readExistingEnv,
  writeEnvAndInitializeDb,
} from './setup-lib.js';

const h = React.createElement;

const FIELDS = [
  {
    key: 'openAiApiKey',
    label: 'OpenAI API key',
    help: 'Required for planning, answers, summaries, and transcription.',
    mask: '*',
  },
  {
    key: 'telegramBotToken',
    label: 'Telegram bot token',
    help: 'Paste the bot token from BotFather. Chat discovery runs after this step.',
    mask: '*',
  },
  {
    key: 'allowedChatIds',
    label: 'Allowed Telegram chat IDs',
    help: 'Comma-separated chat IDs that are allowed to use Soup AI.',
  },
  {
    key: 'workspaceRoot',
    label: 'Workspace root for Codex',
    help: 'Codex is constrained to this root and its descendants.',
  },
  {
    key: 'openAiModel',
    label: 'OpenAI model',
    help: 'Used for planning, direct replies, and Codex summaries.',
  },
  {
    key: 'openAiMemoryModel',
    label: 'OpenAI memory model',
    help: 'Used for conversation summarization. Usually matches the main model.',
  },
  {
    key: 'openAiTranscriptionModel',
    label: 'OpenAI transcription model',
    help: 'Used for Telegram voice notes and audio attachments.',
  },
  {
    key: 'dbPath',
    label: 'SQLite DB path',
    help: 'Relative paths are resolved from the repo root.',
  },
  {
    key: 'codexBin',
    label: 'Codex binary',
    help: 'Usually `codex` if the CLI is on PATH.',
  },
  {
    key: 'codexSearch',
    label: 'Enable Codex web search',
    help: 'Use `true` or `false`.',
  },
];

function maskValue(field, value) {
  if (!value) {
    return '(empty)';
  }

  if (!field.mask) {
    return value;
  }

  const visibleLength = Math.min(value.length, 12);
  return `${field.mask.repeat(visibleLength)} (${value.length} chars)`;
}

function SetupFieldScreen({
  field,
  stepNumber,
  totalSteps,
  value,
  onChange,
  onSubmit,
  busy,
  discoveryStatus,
}) {
  return h(
    Box,
    { flexDirection: 'column', paddingX: 1 },
    h(Text, { bold: true }, 'Soup AI setup'),
    h(Text, { color: 'gray' }, `Step ${stepNumber} of ${totalSteps}`),
    h(Text, null, ''),
    h(Text, { bold: true }, field.label),
    h(Text, { color: 'gray' }, field.help),
    h(Text, null, ''),
    h(
      Box,
      { borderStyle: 'round', paddingX: 1, paddingY: 0, flexDirection: 'column' },
      h(
        Box,
        null,
        h(Text, { color: 'cyan' }, '> '),
        h(TextInput, {
          value,
          onChange,
          onSubmit,
          mask: field.mask,
          focus: !busy,
          showCursor: !busy,
          placeholder: field.label,
        }),
      ),
    ),
    h(Text, null, ''),
    discoveryStatus
      ? h(Text, { color: discoveryStatus.tone }, discoveryStatus.text)
      : null,
    h(Text, { color: 'gray' }, 'Enter saves this field. Esc exits.'),
  );
}

function ReviewScreen({
  values,
  reviewIndex,
  discoveryStatus,
  errorMessage,
}) {
  return h(
    Box,
    { flexDirection: 'column', paddingX: 1 },
    h(Text, { bold: true }, 'Review setup values'),
    h(Text, { color: 'gray' }, 'Use up/down to select a field, Enter to save, E to edit, Esc to exit.'),
    h(Text, null, ''),
    ...FIELDS.map((field, index) =>
      h(
        Box,
        {
          key: field.key,
          flexDirection: 'row',
        },
        h(Text, { color: index === reviewIndex ? 'cyan' : 'gray' }, index === reviewIndex ? '> ' : '  '),
        h(Text, { bold: index === reviewIndex }, `${field.label}: `),
        h(Text, { color: 'gray' }, maskValue(field, values[field.key] ?? '')),
      ),
    ),
    h(Text, null, ''),
    discoveryStatus
      ? h(Text, { color: discoveryStatus.tone }, discoveryStatus.text)
      : null,
    errorMessage ? h(Text, { color: 'red' }, errorMessage) : null,
  );
}

function SavingScreen({ text }) {
  return h(
    Box,
    { flexDirection: 'column', paddingX: 1 },
    h(Text, { bold: true }, 'Soup AI setup'),
    h(Text, null, ''),
    h(Text, { color: 'cyan' }, text),
  );
}

function DoneScreen({ envPath }) {
  return h(
    Box,
    { flexDirection: 'column', paddingX: 1 },
    h(Text, { bold: true }, 'Setup complete'),
    h(Text, null, ''),
    h(Text, null, `Wrote ${envPath} and initialized the SQLite database.`),
    h(Text, null, ''),
    h(Text, null, 'Next steps:'),
    h(Text, null, '1. npm run supervisor:once'),
    h(Text, null, '2. npm run task:register'),
    h(Text, null, '3. Read docs/telegram.md if you still need bot/chat details'),
    h(Text, null, ''),
    h(Text, { color: 'gray' }, 'Press Enter or Esc to exit.'),
  );
}

function SetupApp({ envPath, existingEnv }) {
  const { exit } = useApp();
  const initialDefaults = useMemo(() => buildSetupDefaults(existingEnv), [existingEnv]);
  const [values, setValues] = useState(initialDefaults);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [inputValue, setInputValue] = useState(initialDefaults[FIELDS[0].key]);
  const [mode, setMode] = useState('editing');
  const [busyMessage, setBusyMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [reviewIndex, setReviewIndex] = useState(0);
  const [discoveryStatus, setDiscoveryStatus] = useState(null);

  const currentField = FIELDS[currentIndex];

  useEffect(() => {
    if (mode === 'editing') {
      setInputValue(values[currentField.key] ?? '');
    }
  }, [currentField, mode, values]);

  const commitField = async (submittedValue) => {
    if (mode !== 'editing') {
      return;
    }

    const trimmed = submittedValue.trim();
    const nextValues = {
      ...values,
      [currentField.key]: trimmed,
    };

    setValues(nextValues);
    setErrorMessage('');

    if (currentField.key === 'telegramBotToken') {
      setBusyMessage('Discovering recent Telegram chats...');
      setMode('busy');

      const discoveredChatIds = await discoverTelegramChatIds(trimmed);
      const hasExistingAllowedChats = Boolean(existingEnv.TELEGRAM_ALLOWED_CHAT_IDS);
      const updatedValues = {
        ...nextValues,
        allowedChatIds:
          !hasExistingAllowedChats && !nextValues.allowedChatIds
            ? discoveredChatIds.join(',')
            : nextValues.allowedChatIds,
      };

      setValues(updatedValues);
      setDiscoveryStatus(
        discoveredChatIds.length > 0
          ? {
              tone: 'green',
              text: `Discovered Telegram chat IDs: ${discoveredChatIds.join(', ')}`,
            }
          : {
              tone: 'yellow',
              text: 'No recent Telegram chat IDs found. You can still enter them manually.',
            },
      );
      setBusyMessage('');
      if (currentIndex === FIELDS.length - 1) {
        setReviewIndex(FIELDS.length - 1);
        setMode('review');
      } else {
        setCurrentIndex((index) => index + 1);
        setMode('editing');
      }
      return;
    }

    if (currentIndex === FIELDS.length - 1) {
      setReviewIndex(FIELDS.length - 1);
      setMode('review');
      return;
    }

    setCurrentIndex((index) => index + 1);
  };

  const saveSetup = async () => {
    setErrorMessage('');
    setBusyMessage('Writing .env and initializing SQLite...');
    setMode('saving');

    try {
      const contents = buildEnvFileContents({
        existingEnv,
        values,
      });

      writeEnvAndInitializeDb({
        envPath,
        contents,
      });
      setMode('done');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : `${error}`);
      setMode('review');
    } finally {
      setBusyMessage('');
    }
  };

  useInput((input, key) => {
    if (key.escape) {
      exit();
      return;
    }

    if (mode === 'review') {
      if (key.upArrow) {
        setReviewIndex((index) => Math.max(0, index - 1));
        return;
      }

      if (key.downArrow) {
        setReviewIndex((index) => Math.min(FIELDS.length - 1, index + 1));
        return;
      }

      if (input.toLowerCase() === 'e') {
        setCurrentIndex(reviewIndex);
        setMode('editing');
        return;
      }

      if (key.return) {
        void saveSetup();
      }

      return;
    }

    if (mode === 'done' && (key.return || input.toLowerCase() === 'q')) {
      exit();
    }
  });

  if (mode === 'busy' || mode === 'saving') {
    return h(SavingScreen, { text: busyMessage });
  }

  if (mode === 'done') {
    return h(DoneScreen, {
      envPath: path.relative(projectRoot, envPath),
    });
  }

  if (mode === 'review') {
    return h(ReviewScreen, {
      values,
      reviewIndex,
      discoveryStatus,
      errorMessage,
    });
  }

  return h(SetupFieldScreen, {
    field: currentField,
    stepNumber: currentIndex + 1,
    totalSteps: FIELDS.length,
    value: inputValue,
    onChange: setInputValue,
    onSubmit: (value) => {
      void commitField(value);
    },
    busy: false,
    discoveryStatus,
  });
}

export async function runSetupTui() {
  const envPath = path.join(projectRoot, '.env');
  const existingEnv = readExistingEnv(envPath);
  const app = render(h(SetupApp, { envPath, existingEnv }));
  await app.waitUntilExit();
}
