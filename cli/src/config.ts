import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from './types.ts';

const REQUIRED_FIELDS = [
  'VPS1_IP',
  'VPS2_IP',
  'SSH_KEY_PATH',
  'SSH_USER',
  'SSH_PORT',
] as const;

/**
 * Find the project root by walking up from cli/ looking for openclaw-config.env.
 */
function findProjectRoot(): string {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  let dir = resolve(__dirname, '..');
  for (let i = 0; i < 5; i++) {
    if (existsSync(resolve(dir, 'openclaw-config.env'))) return dir;
    dir = resolve(dir, '..');
  }
  throw new Error(
    'Cannot find openclaw-config.env. Run the CLI from the openclaw-vps project.'
  );
}

/**
 * Parse a KEY=VALUE env file. Skips comments and blank lines.
 * Does NOT set process.env — avoids leaking secrets to child processes.
 */
function parseEnvFile(path: string): Record<string, string> {
  const content = readFileSync(path, 'utf-8');
  const vars: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    vars[key] = value;
  }
  return vars;
}

/**
 * Load and validate config from openclaw-config.env.
 * Resolves ~ in SSH_KEY_PATH.
 */
export function loadConfig(): Config {
  const root = findProjectRoot();
  const envPath = resolve(root, 'openclaw-config.env');
  const vars = parseEnvFile(envPath);

  const missing = REQUIRED_FIELDS.filter((f) => !vars[f]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required fields in openclaw-config.env: ${missing.join(', ')}`
    );
  }

  // Resolve ~ in SSH_KEY_PATH
  if (vars.SSH_KEY_PATH.startsWith('~')) {
    const home = process.env.HOME || process.env.USERPROFILE || '';
    vars.SSH_KEY_PATH = vars.SSH_KEY_PATH.replace('~', home);
  }

  return vars as unknown as Config;
}
