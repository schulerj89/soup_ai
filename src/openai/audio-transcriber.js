const DEFAULT_API_BASE_URL = 'https://api.openai.com/v1';

function formatApiError(status, bodyText) {
  const details = `${bodyText ?? ''}`.trim();
  return details ? `OpenAI transcription API HTTP ${status}: ${details}` : `OpenAI transcription API HTTP ${status}`;
}

export class AudioTranscriber {
  constructor({
    apiKey,
    model = 'gpt-4o-mini-transcribe',
    apiBaseUrl = DEFAULT_API_BASE_URL,
    fetchImpl = globalThis.fetch,
  }) {
    this.apiKey = apiKey;
    this.model = model;
    this.apiBaseUrl = apiBaseUrl.replace(/\/$/, '');
    this.fetchImpl = fetchImpl;
  }

  async transcribe({ audioBuffer, fileName, mimeType = 'application/octet-stream' }) {
    if (!this.apiKey) {
      throw new Error('AudioTranscriber requires an OpenAI API key.');
    }

    const form = new FormData();
    const file = new Blob([audioBuffer], { type: mimeType });
    form.append('file', file, fileName);
    form.append('model', this.model);

    const response = await this.fetchImpl(`${this.apiBaseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
      },
      body: form,
    });

    if (!response.ok) {
      throw new Error(formatApiError(response.status, await response.text()));
    }

    const data = await response.json();
    const text = `${data?.text ?? ''}`.trim();

    if (!text) {
      throw new Error('OpenAI transcription API returned an empty transcript.');
    }

    return {
      text,
      model: data?.model ?? this.model,
    };
  }
}
