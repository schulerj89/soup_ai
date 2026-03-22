import { runPromptSetup } from './setup-prompt.js';
import { runSetupTui } from './setup-tui.js';

async function main() {
  const shouldUseTui = Boolean(process.stdin.isTTY && process.stdout.isTTY && !process.env.CI);

  if (shouldUseTui) {
    await runSetupTui();
    return;
  }

  await runPromptSetup();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
