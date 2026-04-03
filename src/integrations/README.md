# Provider Requirements Registry

This folder contains the provider requirements registry used to describe which environment variables and capabilities each integration provider needs.

## Files

- `provider-requirements.js`: static provider definitions.
- `provider-registry.js`: lookup and aggregation helpers.
- `index.js`: public exports for consumers.

## Public API

Import from the folder entrypoint:

```js
import {
  collectProviderRequirements,
  getProvider,
  getProviderRequirements,
  hasProvider,
  listProviders,
  providerRequirements,
} from './index.js';
```

Available exports:

- `providerRequirements`: frozen object keyed by provider id.
- `listProviders()`: returns all provider definitions as an array.
- `hasProvider(name)`: returns `true` if the normalized provider name is supported.
- `getProvider(name)`: returns the matching provider definition or throws `Error('Unknown provider: ...')`.
- `getProviderRequirements(name)`: returns the provider's `envVars` array.
- `collectProviderRequirements(providerNames)`: resolves multiple providers and returns a frozen object with `providers`, `envVars`, and `capabilities`. `providers` preserves request order. `envVars` and `capabilities` are de-duplicated in first-seen order.

Provider names are normalized with `trim().toLowerCase()`. Current aliases are:

- `openai`, `open-ai`
- `github`, `git-hub`
- `vercel`
- `telegram`

## Provider Shape

Each provider definition has this shape:

```js
{
  id: 'openai',
  displayName: 'OpenAI',
  envVars: [
    {
      name: 'OPENAI_API_KEY',
      required: true,
      secret: true,
      description: 'API key used for model, transcription, and summarization requests.',
    },
  ],
  capabilities: ['chat-completions', 'responses', 'audio-transcription'],
}
```

`required` defaults to `true` unless explicitly set to `false`. `secret` also defaults to `true` unless explicitly set to `false`.

## Supported Providers

Current providers defined in `providerRequirements`:

- `openai`
- `github`
- `vercel`
- `telegram`

## Usage Examples

List supported providers:

```js
import { listProviders } from './index.js';

const providers = listProviders();
```

Check a provider name before resolving it:

```js
import { hasProvider, getProvider } from './index.js';

if (hasProvider(userInput)) {
  const provider = getProvider(userInput);
  console.log(provider.displayName);
}
```

Get the environment variables required by one provider:

```js
import { getProviderRequirements } from './index.js';

const envVars = getProviderRequirements('vercel');
```

Collect requirements for multiple providers:

```js
import { collectProviderRequirements } from './index.js';

const requirements = collectProviderRequirements(['openai', 'github', 'vercel']);

console.log(requirements.providers.map((provider) => provider.id));
console.log(requirements.envVars.map((envVar) => envVar.name));
console.log(requirements.capabilities);
```

## Extending the Registry

Add new providers in `provider-requirements.js`, then add any accepted aliases in `provider-registry.js`. If you add a provider without adding an alias, `getProvider()` and `hasProvider()` will not resolve it by name.
