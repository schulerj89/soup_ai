export function truncateText(value, maxChars) {
  const text = `${value ?? ''}`;

  if (text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, maxChars)}\n...[truncated]`;
}

export function splitTelegramText(value, maxChars = 3900) {
  const text = `${value ?? ''}`.trim();
  const normalizedMaxChars = Number(maxChars);
  const limit = Number.isFinite(normalizedMaxChars)
    ? Math.max(1, Math.floor(normalizedMaxChars))
    : 3900;

  if (!text) {
    return [''];
  }

  if (text.length <= limit) {
    return [text];
  }

  const parts = [];
  let remaining = text;

  while (remaining.length > limit) {
    let splitAt = remaining.lastIndexOf('\n', limit);

    if (splitAt < limit * 0.5) {
      splitAt = remaining.lastIndexOf(' ', limit);
    }

    if (splitAt < limit * 0.5) {
      splitAt = limit;
    }

    parts.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining) {
    parts.push(remaining);
  }

  return parts;
}
