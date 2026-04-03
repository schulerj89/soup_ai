export class TelegramApiError extends Error {
  constructor({ statusCode = null, description = null, retryAfterSeconds = null }) {
    const baseMessage = description
      ? `Telegram API error: ${description}`
      : statusCode
        ? `Telegram API HTTP ${statusCode}`
        : 'Telegram API request failed';
    super(baseMessage);
    this.name = 'TelegramApiError';
    this.statusCode = statusCode;
    this.retryAfterSeconds = Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : null;
  }
}

export class TelegramClient {
  constructor({ token, apiBaseUrl = 'https://api.telegram.org', fetchImpl = globalThis.fetch }) {
    this.token = token;
    this.apiBaseUrl = apiBaseUrl.replace(/\/$/, '');
    this.fetchImpl = fetchImpl;
  }

  async call(method, payload = {}) {
    const response = await this.fetchImpl(`${this.apiBaseUrl}/bot${this.token}/${method}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      let body = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }

      throw new TelegramApiError({
        statusCode: response.status,
        description: body?.description ?? null,
        retryAfterSeconds: body?.parameters?.retry_after ?? null,
      });
    }

    const data = await response.json();

    if (!data.ok) {
      throw new TelegramApiError({
        statusCode: response.status,
        description: data.description ?? 'unknown error',
        retryAfterSeconds: data?.parameters?.retry_after ?? null,
      });
    }

    return data.result;
  }

  async getUpdates({ offset = 0, limit = 25, timeoutSeconds = 0 }) {
    return this.call('getUpdates', {
      offset,
      limit,
      timeout: timeoutSeconds,
      allowed_updates: ['message'],
    });
  }

  async sendMessage({ chatId, text, replyToMessageId = null }) {
    const payload = {
      chat_id: chatId,
      text,
    };

    if (replyToMessageId) {
      payload.reply_parameters = { message_id: replyToMessageId };
    }

    return this.call('sendMessage', payload);
  }

  async getFile(fileId) {
    return this.call('getFile', {
      file_id: fileId,
    });
  }

  async downloadFile(filePath) {
    const response = await this.fetchImpl(`${this.apiBaseUrl}/file/bot${this.token}/${filePath}`, {
      method: 'GET',
    });

    if (!response.ok) {
      throw new Error(`Telegram file download HTTP ${response.status}`);
    }

    return Buffer.from(await response.arrayBuffer());
  }
}
