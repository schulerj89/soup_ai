import { providerRequirements } from './provider-requirements.js';

const providerAliases = new Map([
  ['openai', 'openai'],
  ['open-ai', 'openai'],
  ['github', 'github'],
  ['git-hub', 'github'],
  ['vercel', 'vercel'],
  ['telegram', 'telegram'],
]);

function normalizeProviderName(name) {
  return `${name ?? ''}`.trim().toLowerCase();
}

export function listProviders() {
  return Object.values(providerRequirements);
}

export function hasProvider(name) {
  const normalized = normalizeProviderName(name);
  return providerAliases.has(normalized);
}

export function getProvider(name) {
  const normalized = normalizeProviderName(name);
  const providerId = providerAliases.get(normalized);

  if (!providerId) {
    throw new Error(`Unknown provider: ${name}`);
  }

  return providerRequirements[providerId];
}

export function getProviderRequirements(name) {
  return getProvider(name).envVars;
}

export function collectProviderRequirements(providerNames) {
  const providers = [];
  const envVarsByName = new Map();
  const capabilities = new Set();

  for (const providerName of providerNames) {
    const provider = getProvider(providerName);
    providers.push(provider);

    for (const envVar of provider.envVars) {
      if (!envVarsByName.has(envVar.name)) {
        envVarsByName.set(envVar.name, envVar);
      }
    }

    for (const capability of provider.capabilities) {
      capabilities.add(capability);
    }
  }

  return Object.freeze({
    providers: Object.freeze(providers),
    envVars: Object.freeze([...envVarsByName.values()]),
    capabilities: Object.freeze([...capabilities]),
  });
}
