import { Agent, run } from '@openai/agents';
import { safeJsonParse } from '../utils/json.js';

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

function formatRecentItems(items) {
  return items
    .map((item) => {
      const role = item?.role ?? 'unknown';
      const text = extractTextParts(item?.content).trim();
      return text ? `${role}: ${text}` : null;
    })
    .filter(Boolean)
    .join('\n');
}

function normalizePlan(rawPlan, projectRoot) {
  const plan = rawPlan && typeof rawPlan === 'object' ? rawPlan : {};
  const action = plan.action === 'run_codex' ? 'run_codex' : 'answer_directly';
  const reason = `${plan.reason ?? ''}`.trim() || 'No reason provided.';
  const responseOutline = `${plan.response_outline ?? ''}`.trim() || null;
  const taskTitle = `${plan.task_title ?? ''}`.trim() || null;
  const codexPrompt = `${plan.codex_prompt ?? ''}`.trim() || null;
  const workingDirectory = `${plan.working_directory ?? ''}`.trim() || projectRoot;
  const expectedVerification = Array.isArray(plan.expected_verification)
    ? plan.expected_verification.map((item) => `${item}`.trim()).filter(Boolean)
    : [];

  if (action === 'run_codex' && (!taskTitle || !codexPrompt)) {
    return {
      action: 'answer_directly',
      reason: 'Planner returned an incomplete Codex execution plan.',
      responseOutline:
        responseOutline ??
        'Answer directly and ask the user to restate the exact local change if they want repo work performed.',
      taskTitle: null,
      codexPrompt: null,
      workingDirectory: projectRoot,
      expectedVerification: [],
    };
  }

  return {
    action,
    reason,
    responseOutline,
    taskTitle,
    codexPrompt,
    workingDirectory,
    expectedVerification,
  };
}

export class ExecutionPlanner {
  constructor({
    model,
    runImpl = run,
    agentFactory = (options) => new Agent(options),
  }) {
    this.model = model;
    this.runImpl = runImpl;
    this.agentFactory = agentFactory;
  }

  async plan({ chatId, messageText, workspaceRoot, projectRoot, session = null }) {
    const snapshot = session ? await session.getSnapshot() : { summaryText: null, items: [] };
    const recentItems = formatRecentItems(snapshot.items.slice(-4));

    const planner = this.agentFactory({
      name: 'Soup Execution Planner',
      model: this.model,
      instructions: [
        'Decide whether the user message should be answered directly or executed through Codex.',
        'Return JSON only.',
        'Valid actions are "answer_directly" and "run_codex".',
        'Use "answer_directly" for feasibility questions, product questions, brainstorming, clarification, or advice.',
        'Use "run_codex" only when the user clearly wants local repo or machine work performed.',
        'If you choose "run_codex", produce a minimal task-scoped Codex prompt that asks only for the requested work.',
        'Do not wrap the Codex prompt in extra policy prose or route-selection commentary.',
        'Assume the primary repo for local work is the provided project root unless the user clearly names another path.',
        'Schema:',
        '{',
        '  "action": "answer_directly" | "run_codex",',
        '  "reason": string,',
        '  "response_outline": string | null,',
        '  "task_title": string | null,',
        '  "working_directory": string | null,',
        '  "codex_prompt": string | null,',
        '  "expected_verification": string[]',
        '}',
      ].join('\n'),
    });

    const input = [
      `Workspace root: ${workspaceRoot}`,
      `Project root: ${projectRoot}`,
      snapshot.summaryText ? `Session summary:\n${snapshot.summaryText}` : 'Session summary:\n(none)',
      recentItems ? `Recent conversation:\n${recentItems}` : 'Recent conversation:\n(none)',
      `User message:\n${messageText}`,
    ].join('\n\n');

    const result = await this.runImpl(planner, input, {
      context: {
        chatId,
        workspaceRoot,
      },
      maxTurns: 1,
    });

    return normalizePlan(safeJsonParse(`${result.finalOutput ?? ''}`.trim(), null), projectRoot);
  }
}
