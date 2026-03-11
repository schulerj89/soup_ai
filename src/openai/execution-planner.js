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

function normalizeStringList(value) {
  return Array.isArray(value) ? value.map((item) => `${item}`.trim()).filter(Boolean) : [];
}

function normalizeExactFileContents(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return null;
      }

      const path = `${item.path ?? ''}`.trim();
      const content = typeof item.content === 'string' ? item.content : null;

      if (!path || content == null) {
        return null;
      }

      return { path, content };
    })
    .filter(Boolean);
}

function normalizePlan(rawPlan, workspaceRoot) {
  const plan = rawPlan && typeof rawPlan === 'object' ? rawPlan : {};
  const action = plan.action === 'run_codex' ? 'run_codex' : 'answer_directly';
  const reason = `${plan.reason ?? ''}`.trim() || 'No reason provided.';
  const responseOutline = `${plan.response_outline ?? ''}`.trim() || null;
  const taskTitle = `${plan.task_title ?? ''}`.trim() || null;
  const workingDirectory = `${plan.working_directory ?? ''}`.trim() || workspaceRoot;
  const execution = plan.execution && typeof plan.execution === 'object' ? plan.execution : {};
  const executionPlan = {
    goal: `${execution.goal ?? ''}`.trim() || null,
    steps: normalizeStringList(execution.steps),
    targetPaths: normalizeStringList(execution.target_paths),
    exactFileContents: normalizeExactFileContents(execution.exact_file_contents),
    constraints: normalizeStringList(execution.constraints),
    verification: normalizeStringList(execution.verification),
  };

  if (action === 'run_codex' && (!taskTitle || !executionPlan.goal)) {
    return {
      action: 'answer_directly',
      reason: 'Planner returned an incomplete Codex execution plan.',
      responseOutline:
        responseOutline ??
        'Answer directly and ask the user to restate the exact local change if they want repo work performed.',
      taskTitle: null,
      executionPlan: null,
      workingDirectory: workspaceRoot,
    };
  }

  return {
    action,
    reason,
    responseOutline,
    taskTitle,
    executionPlan: action === 'run_codex' ? executionPlan : null,
    workingDirectory,
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
        'If you choose "run_codex", extract the requested work into a structured execution object.',
        'Default the working directory to the provided workspace root.',
        'Use the provided project root only when the user explicitly mentions soup_ai, the current repo, or clearly wants work inside this repository.',
        'If the user asks for work elsewhere under the workspace root, set working_directory to that broader or alternate location.',
        'Be literal about exact file contents when the user specifies text to write.',
        'Schema:',
        '{',
        '  "action": "answer_directly" | "run_codex",',
        '  "reason": string,',
        '  "response_outline": string | null,',
        '  "task_title": string | null,',
        '  "working_directory": string | null,',
        '  "execution": {',
        '    "goal": string | null,',
        '    "steps": string[],',
        '    "target_paths": string[],',
        '    "exact_file_contents": [{"path": string, "content": string}],',
        '    "constraints": string[],',
        '    "verification": string[]',
        '  } | null',
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

    return normalizePlan(safeJsonParse(`${result.finalOutput ?? ''}`.trim(), null), workspaceRoot);
  }
}
