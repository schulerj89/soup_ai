import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const projectRoot = path.resolve(__dirname, '..', '..');

export function resolveProjectPath(targetPath) {
  if (!targetPath) {
    return projectRoot;
  }

  return path.isAbsolute(targetPath)
    ? path.normalize(targetPath)
    : path.resolve(projectRoot, targetPath);
}
