import { Agent, run } from '@openai/agents';

function extractTextParts(content) {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .map((part) => {
      if (!part || typeof part !== 'object') {
        return '';
      }

      if (part.type === 'input_text' || part.type === 'output_text') {
        return part.text ?? '';
      }

      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function renderItems(items) {
  return items
    .map((item) => {
      const role = item?.role ?? item?.type ?? 'unknown';
      const text = extractTextParts(item?.content).trim();
      return text ? `${role}: ${text}` : `${role}: [non-text item omitted]`;
    })
    .join('\n');
}

export class MemorySummarizer {
  constructor({
    model,
    threshold = 24,
    keepRecentItems = 12,
    runImpl = run,
    agentFactory = (options) => new Agent(options),
  }) {
    this.model = model;
    this.threshold = threshold;
    this.keepRecentItems = keepRecentItems;
    this.runImpl = runImpl;
    this.agentFactory = agentFactory;
  }

  shouldSummarize(snapshot) {
    return snapshot.items.length > this.threshold;
  }

  async summarizeSession(session) {
    const snapshot = await session.getSnapshot();

    if (!this.shouldSummarize(snapshot)) {
      return { summarized: false };
    }

    const splitIndex = Math.max(snapshot.items.length - this.keepRecentItems, 1);
    const olderItems = snapshot.items.slice(0, splitIndex);
    const recentItems = snapshot.items.slice(splitIndex);

    const summarizer = this.agentFactory({
      name: 'Soup Memory Summarizer',
      model: this.model,
      instructions: [
        'Summarize older chat context for future assistant turns.',
        'Preserve durable facts, user preferences, open tasks, constraints, decisions, and important tool outcomes.',
        'Be concise and factual. Use short plain text, not markdown headings.',
        'Do not invent facts. Do not include chit-chat unless it affects future work.',
      ].join('\n'),
    });

    const input = [
      snapshot.summaryText ? `Existing summary:\n${snapshot.summaryText}` : 'Existing summary:\n(none)',
      'Older conversation items to compress:',
      renderItems(olderItems),
    ].join('\n\n');

    const result = await this.runImpl(summarizer, input, {
      maxTurns: 1,
    });

    const summaryText = `${result.finalOutput ?? ''}`.trim();

    if (!summaryText) {
      return { summarized: false };
    }

    await session.compact({
      summaryText,
      items: recentItems,
    });

    return {
      summarized: true,
      summaryText,
      keptItems: recentItems.length,
    };
  }
}
