export function formatCliError(error) {
  return error instanceof Error ? error.stack || error.message : `${error}`;
}
