import { $, ProcessOutput } from 'zx';
import type { Config, VpsTarget, SshResult } from './types.ts';

// Suppress zx verbose output by default
$.verbose = false;

function sshArgs(cfg: Config, target: VpsTarget): string[] {
  const ip = target === 'vps1' ? cfg.VPS1_IP : cfg.VPS2_IP;
  return [
    '-i', cfg.SSH_KEY_PATH,
    '-p', cfg.SSH_PORT,
    '-o', 'ConnectTimeout=10',
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    `${cfg.SSH_USER}@${ip}`,
  ];
}

/**
 * Execute a command on a remote VPS and return stdout.
 * Throws on non-zero exit.
 */
export async function ssh(cfg: Config, target: VpsTarget, cmd: string): Promise<string> {
  const args = sshArgs(cfg, target);
  const result = await $`ssh ${args} ${cmd}`;
  return result.stdout.trim();
}

/**
 * Execute a command on a remote VPS, returning a result object (never throws).
 */
export async function sshSafe(cfg: Config, target: VpsTarget, cmd: string): Promise<SshResult> {
  const args = sshArgs(cfg, target);
  try {
    const result = await $`ssh ${args} ${cmd}`;
    return {
      ok: true,
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
      exitCode: 0,
    };
  } catch (err) {
    const e = err as ProcessOutput;
    return {
      ok: false,
      stdout: (e.stdout || '').trim(),
      stderr: (e.stderr || '').trim(),
      exitCode: e.exitCode ?? 1,
    };
  }
}

/**
 * Stream command output to terminal (for logs -f, etc).
 * Returns when the remote command completes or the user presses Ctrl+C.
 */
export async function sshStream(cfg: Config, target: VpsTarget, cmd: string): Promise<void> {
  const ip = target === 'vps1' ? cfg.VPS1_IP : cfg.VPS2_IP;
  const proc = $`ssh -i ${cfg.SSH_KEY_PATH} -p ${cfg.SSH_PORT} -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new ${cfg.SSH_USER}@${ip} ${cmd}`;
  proc.stdout.pipe(process.stdout);
  proc.stderr.pipe(process.stderr);

  const abort = () => { proc.kill('SIGTERM'); };
  process.on('SIGINT', abort);

  try {
    await proc;
  } catch {
    // Expected when user Ctrl+C's or remote command exits non-zero
  } finally {
    process.off('SIGINT', abort);
  }
}

/**
 * Interactive SSH session with PTY allocation (for shell access, interactive commands).
 */
export async function sshInteractive(cfg: Config, target: VpsTarget, cmd: string): Promise<void> {
  const ip = target === 'vps1' ? cfg.VPS1_IP : cfg.VPS2_IP;
  const proc = $`ssh -t -i ${cfg.SSH_KEY_PATH} -p ${cfg.SSH_PORT} -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new ${cfg.SSH_USER}@${ip} ${cmd}`;
  proc.stdin.pipe(process.stdin);
  proc.stdout.pipe(process.stdout);
  proc.stderr.pipe(process.stderr);

  try {
    await proc;
  } catch {
    // Expected on exit
  }
}

// ── Docker helpers ──────────────────────────────────────────────

const VPS1_COMPOSE_DIR = '/home/openclaw/openclaw';
const VPS2_COMPOSE_DIR = '/home/openclaw/monitoring';

/**
 * Run docker compose commands on a VPS.
 * adminclaw can't cd into /home/openclaw, so we use sudo sh -c.
 */
export async function dockerCompose(
  cfg: Config,
  target: VpsTarget,
  subcmd: string
): Promise<string> {
  const dir = target === 'vps1' ? VPS1_COMPOSE_DIR : VPS2_COMPOSE_DIR;
  return ssh(cfg, target, `sudo sh -c 'cd ${dir} && sudo -u openclaw docker compose ${subcmd}'`);
}

/**
 * Safe version of dockerCompose (never throws).
 */
export async function dockerComposeSafe(
  cfg: Config,
  target: VpsTarget,
  subcmd: string
): Promise<SshResult> {
  const dir = target === 'vps1' ? VPS1_COMPOSE_DIR : VPS2_COMPOSE_DIR;
  return sshSafe(cfg, target, `sudo sh -c 'cd ${dir} && sudo -u openclaw docker compose ${subcmd}'`);
}

/**
 * Stream docker compose output (for logs -f).
 */
export async function dockerComposeStream(
  cfg: Config,
  target: VpsTarget,
  subcmd: string
): Promise<void> {
  const dir = target === 'vps1' ? VPS1_COMPOSE_DIR : VPS2_COMPOSE_DIR;
  return sshStream(cfg, target, `sudo sh -c 'cd ${dir} && sudo -u openclaw docker compose ${subcmd}'`);
}

/**
 * Execute a command inside the openclaw-gateway container on VPS-1.
 */
export async function gatewayExec(cfg: Config, cmd: string): Promise<string> {
  return ssh(cfg, 'vps1', `sudo docker exec openclaw-gateway ${cmd}`);
}

/**
 * Safe version of gatewayExec (never throws).
 */
export async function gatewayExecSafe(cfg: Config, cmd: string): Promise<SshResult> {
  return sshSafe(cfg, 'vps1', `sudo docker exec openclaw-gateway ${cmd}`);
}

// The openclaw CLI in the container is invoked via node, not a bin symlink
const OPENCLAW_BIN = 'node dist/index.js';

/**
 * Run an openclaw CLI command inside the gateway container.
 */
export async function openclawCmd(cfg: Config, args: string): Promise<string> {
  return gatewayExec(cfg, `${OPENCLAW_BIN} ${args}`);
}

/**
 * Safe version of openclawCmd (never throws).
 */
export async function openclawCmdSafe(cfg: Config, args: string): Promise<SshResult> {
  return gatewayExecSafe(cfg, `${OPENCLAW_BIN} ${args}`);
}

/** The command prefix for openclaw inside the gateway container */
export const OPENCLAW_EXEC = `sudo docker exec openclaw-gateway ${OPENCLAW_BIN}`;
export const OPENCLAW_EXEC_IT = `sudo docker exec -it openclaw-gateway ${OPENCLAW_BIN}`;
