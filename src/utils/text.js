export function truncateText(value, maxChars) {
  const text = `${value ?? ''}`;

  if (text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, maxChars)}\n...[truncated]`;
}

export function splitTelegramText(value, maxChars = 3900) {
  const text = `${value ?? ''}`.trim();

  if (!text) {
    return [''];
  }

  if (text.length <= maxChars) {
    return [text];
  }

  const parts = [];
  let remaining = text;

  while (remaining.length > maxChars) {
    let splitAt = remaining.lastIndexOf('\n', maxChars);

    if (splitAt < maxChars * 0.5) {
      splitAt = remaining.lastIndexOf(' ', maxChars);
    }

    if (splitAt < maxChars * 0.5) {
      splitAt = maxChars;
    }

    parts.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining) {
    parts.push(remaining);
  }

  return parts;
}
