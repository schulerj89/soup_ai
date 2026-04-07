import { runPromptSetup } from './setup-prompt.js';
import { runSetupTui } from './setup-tui.js';
import { formatCliError } from '../utils/cli-error.js';

async function main() {
  const shouldUseTui = Boolean(process.stdin.isTTY && process.stdout.isTTY && !process.env.CI);

  if (shouldUseTui) {
    console.clear();
  }

  if (shouldUseTui) {
    await runSetupTui();
    return;
  }

  await runPromptSetup();
}

main().catch((error) => {
  console.error(formatCliError(error));
  process.exitCode = 1;
});
