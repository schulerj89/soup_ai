export function safeJsonParse(value, fallback = null) {
  if (value == null || value === '') {
    return fallback;
  }

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function toJson(value) {
  return JSON.stringify(value ?? {});
}
