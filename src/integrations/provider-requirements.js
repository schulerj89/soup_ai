function freezeEnvVar(envVar) {
  return Object.freeze({
    name: envVar.name,
    required: envVar.required !== false,
    secret: envVar.secret !== false,
    description: envVar.description,
  });
}

function defineProvider(provider) {
  const envVars = Object.freeze(provider.envVars.map(freezeEnvVar));
  const capabilities = Object.freeze([...provider.capabilities]);

  return Object.freeze({
    id: provider.id,
    displayName: provider.displayName,
    envVars,
    capabilities,
  });
}

export const providerRequirements = Object.freeze({
  openai: defineProvider({
    id: 'openai',
    displayName: 'OpenAI',
    envVars: [
      {
        name: 'OPENAI_API_KEY',
        description: 'API key used for model, transcription, and summarization requests.',
      },
    ],
    capabilities: ['chat-completions', 'responses', 'audio-transcription'],
  }),
  github: defineProvider({
    id: 'github',
    displayName: 'GitHub',
    envVars: [
      {
        name: 'GITHUB_TOKEN',
        description: 'Personal access token or GitHub App token for repository access.',
      },
    ],
    capabilities: ['repository-read', 'repository-write', 'issues'],
  }),
  vercel: defineProvider({
    id: 'vercel',
    displayName: 'Vercel',
    envVars: [
      {
        name: 'VERCEL_TOKEN',
        description: 'Access token used to inspect and manage Vercel projects.',
      },
      {
        name: 'VERCEL_PROJECT_ID',
        secret: false,
        description: 'Optional default Vercel project identifier for deployments.',
      },
    ],
    capabilities: ['project-inspection', 'deployment-read', 'deployment-write'],
  }),
  telegram: defineProvider({
    id: 'telegram',
    displayName: 'Telegram',
    envVars: [
      {
        name: 'TELEGRAM_BOT_TOKEN',
        description: 'Bot token used to fetch updates and send messages.',
      },
      {
        name: 'TELEGRAM_ALLOWED_CHAT_IDS',
        secret: false,
        description: 'Comma-separated chat allowlist for the supervisor bot.',
      },
    ],
    capabilities: ['bot-updates', 'bot-messaging'],
  }),
});
