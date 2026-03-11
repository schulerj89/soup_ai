import { loadConfig } from '../config/load-config.js';
import { AppDb } from '../db/app-db.js';
import { safeJsonParse } from '../utils/json.js';

function parseArgs(argv) {
  const parsed = {
    taskId: null,
    limit: 1,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];

    if (value === '--task-id' && argv[index + 1]) {
      parsed.taskId = Number(argv[index + 1]);
      index += 1;
      continue;
    }

    if (value === '--limit' && argv[index + 1]) {
      parsed.limit = Number(argv[index + 1]);
      index += 1;
    }
  }

  return parsed;
}

function printSection(title, value) {
  console.log(`\n=== ${title} ===`);
  console.log(value);
}

function normalizeRun(row) {
  return {
    ...row,
    input: safeJsonParse(row.input_json, null),
    output: safeJsonParse(row.output_json, null),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig({ requireOpenAI: false, requireTelegram: false, requireAllowedChats: false });
  const db = new AppDb({ dbPath: config.dbPath });

  try {
    const runs = args.taskId
      ? db.db
          .prepare(
            `SELECT tr.*, t.title AS task_title, t.status AS task_status, t.details AS task_details
             FROM tool_runs tr
             LEFT JOIN tasks t ON t.id = tr.task_id
             WHERE tr.task_id = ?
             ORDER BY tr.id DESC`,
          )
          .all(args.taskId)
      : db.db
          .prepare(
            `SELECT tr.*, t.title AS task_title, t.status AS task_status, t.details AS task_details
             FROM tool_runs tr
             LEFT JOIN tasks t ON t.id = tr.task_id
             WHERE tr.tool_name = 'run_codex_exec'
             ORDER BY tr.id DESC
             LIMIT ?`,
          )
          .all(args.limit);

    if (runs.length === 0) {
      console.log('No Codex tool runs found.');
      return;
    }

    for (const row of runs.map(normalizeRun)) {
      console.log(`task_id=${row.task_id} tool_run_id=${row.id} exit_code=${row.exit_code}`);
      console.log(`task_title=${row.task_title ?? '(unknown)'}`);
      console.log(`task_status=${row.task_status ?? '(unknown)'}`);
      console.log(`created_at=${row.created_at}`);

      printSection('Prompt', row.input?.prompt ?? '(missing prompt)');
      printSection('Working Directory', row.input?.workingDirectory ?? '(missing working directory)');
      printSection('Structured Output', JSON.stringify(row.output?.structured_report ?? null, null, 2));
      printSection('Summary', row.output?.summary ?? '(missing summary)');
      printSection('Stdout', row.output?.stdout ?? '');
      printSection('Stderr', row.output?.stderr ?? '');

      if (row.task_details) {
        printSection('Task Details', row.task_details);
      }
    }
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
