function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parseJsonObject(value) {
  const parsed = safeJsonParse(value);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
}

function extractTrailingJsonObject(value) {
  const normalized = `${value ?? ''}`.trim();

  if (!normalized.endsWith('}')) {
    return null;
  }

  for (let index = normalized.lastIndexOf('{'); index >= 0; index = normalized.lastIndexOf('{', index - 1)) {
    const candidate = normalized.slice(index).trim();
    const parsed = parseJsonObject(candidate);

    if (parsed) {
      return parsed;
    }
  }

  return null;
}

export function parseCodexStructuredReport(value) {
  const normalized = `${value ?? ''}`.trim();

  if (!normalized) {
    return null;
  }

  const direct = parseJsonObject(normalized);
  if (direct) {
    return direct;
  }

  const marker = 'CODEX_RESULT_JSON:';
  const markerIndex = normalized.lastIndexOf(marker);

  if (markerIndex >= 0) {
    return extractTrailingJsonObject(normalized.slice(markerIndex + marker.length));
  }

  return extractTrailingJsonObject(normalized);
}

export function isAcknowledgementLikeText(text) {
  const normalized = `${text ?? ''}`.trim();

  if (!normalized) {
    return true;
  }

  return /^(noted\.|using workspace root|workspace root noted|i(?:'|Ã¢â‚¬â„¢|â€™)ll treat\b|i(?:'|Ã¢â‚¬â„¢|â€™)m treating\b|recorded the workspace root)/i.test(
    normalized,
  );
}

export function extractFinalAgentMessage(stdout) {
  let finalMessage = null;

  for (const rawLine of `${stdout ?? ''}`.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (!line) {
      continue;
    }

    const parsed = safeJsonParse(line);
    if (!parsed || typeof parsed !== 'object') {
      continue;
    }

    if (parsed.type === 'item.completed' && parsed.item?.type === 'agent_message' && typeof parsed.item.text === 'string') {
      finalMessage = parsed.item.text;
    }
  }

  return finalMessage;
}

export function hasMeaningfulStructuredWork(report) {
  if (!report || report.completed !== true) {
    return false;
  }

  if (`${report.follow_up ?? ''}`.trim()) {
    return false;
  }

  if ((report.files_changed?.length ?? 0) > 0 || (report.verification?.length ?? 0) > 0 || report.commit_hash) {
    return true;
  }

  const candidateText = `${report.summary ?? ''}\n${report.raw_user_visible_output ?? ''}`.trim();
  return !isAcknowledgementLikeText(candidateText);
}
