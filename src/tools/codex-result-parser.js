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

function normalizeLegacyStructuredReport(report) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    return null;
  }

  const normalized = { ...report };
  const followUp = `${report.follow_up ?? ''}`.trim();

  if (!Array.isArray(normalized.remaining_work)) {
    normalized.remaining_work = followUp ? [followUp] : [];
  }

  if (typeof normalized.user_message !== 'string') {
    normalized.user_message =
      typeof report.raw_user_visible_output === 'string' ? report.raw_user_visible_output : `${report.summary ?? ''}`;
  }

  if (!normalized.git || typeof normalized.git !== 'object' || Array.isArray(normalized.git)) {
    const git = {};

    if (typeof report.commit_hash === 'string' && report.commit_hash.trim()) {
      git.commit_hashes = [report.commit_hash.trim()];
    }

    if (typeof report.push_succeeded === 'boolean') {
      git.push_succeeded = report.push_succeeded;
    }

    if (Object.keys(git).length > 0) {
      normalized.git = git;
    }
  }

  if (normalized.git && typeof normalized.git === 'object' && !Array.isArray(normalized.git)) {
    if (!Array.isArray(normalized.git.commit_hashes)) {
      const commitHash = typeof normalized.git.commit_hash === 'string' ? normalized.git.commit_hash.trim() : '';
      normalized.git.commit_hashes = commitHash ? [commitHash] : [];
    } else {
      normalized.git.commit_hashes = normalized.git.commit_hashes
        .map((value) => `${value ?? ''}`.trim())
        .filter(Boolean);
    }

    delete normalized.git.commit_hash;

    if (normalized.git.commit_hashes.length === 0 && typeof normalized.git.push_succeeded !== 'boolean') {
      delete normalized.git;
    }
  }

  delete normalized.follow_up;
  delete normalized.raw_user_visible_output;
  delete normalized.commit_hash;
  delete normalized.push_succeeded;

  return normalized;
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

function normalizeAgentText(value) {
  return `${value ?? ''}`
    .replace(/\r\n/g, '\n')
    .replace(/[’‘]/g, "'")
    .replace(/â€™/g, "'")
    .replace(/\u00a0/g, ' ');
}

export function parseCodexStructuredReport(value) {
  const normalized = normalizeAgentText(value).trim();

  if (!normalized) {
    return null;
  }

  const direct = parseJsonObject(normalized);
  if (direct) {
    return normalizeLegacyStructuredReport(direct);
  }

  const marker = 'CODEX_RESULT_JSON:';
  const markerIndex = normalized.lastIndexOf(marker);

  if (markerIndex >= 0) {
    return normalizeLegacyStructuredReport(extractTrailingJsonObject(normalized.slice(markerIndex + marker.length)));
  }

  return normalizeLegacyStructuredReport(extractTrailingJsonObject(normalized));
}

export function isAcknowledgementLikeText(text) {
  const normalized = normalizeAgentText(text).trim();

  if (!normalized) {
    return true;
  }

  return /^(noted\.|using workspace root|workspace root noted|i(?:'ll treat\b|'m treating\b)|recorded the workspace root)/i.test(
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
  if (!report) {
    return false;
  }

  const status = `${report.status ?? ''}`.trim().toLowerCase();
  const completed =
    status === 'completed' ||
    (status !== 'partial' && status !== 'failed' && report.completed === true);

  if (!completed) {
    return false;
  }

  if ((report.remaining_work?.length ?? 0) > 0) {
    return false;
  }

  if ((report.files_changed?.length ?? 0) > 0 || (report.verification?.length ?? 0) > 0 || (report.git?.commit_hashes?.length ?? 0) > 0) {
    return true;
  }

  const candidateText = `${report.summary ?? ''}\n${report.user_message ?? ''}`.trim();
  return !isAcknowledgementLikeText(candidateText);
}
