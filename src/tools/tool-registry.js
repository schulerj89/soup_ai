const TOOL_REGISTRY = {
  codex: {
    id: 'codex',
    description: 'Run local Codex execution against the workspace.',
    readOnly: false,
    backgroundSafe: true,
    maxConcurrent: 1,
  },
  search: {
    id: 'search',
    description: 'Run read-only search or inspection work.',
    readOnly: true,
    backgroundSafe: true,
    maxConcurrent: 4,
  },
  status: {
    id: 'status',
    description: 'Read local status or telemetry.',
    readOnly: true,
    backgroundSafe: true,
    maxConcurrent: 4,
  },
};

export function getToolDefinition(toolType) {
  return TOOL_REGISTRY[toolType] ?? TOOL_REGISTRY.codex;
}

export function getToolConcurrencyLimit(toolType, overrides = {}) {
  const override = overrides?.[toolType];
  return Number.isInteger(override) && override > 0 ? override : getToolDefinition(toolType).maxConcurrent;
}

export function listToolDefinitions() {
  return Object.values(TOOL_REGISTRY);
}
