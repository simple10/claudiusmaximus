import { select } from '@inquirer/prompts';
import chalk from 'chalk';
import { loadConfig } from './config.ts';
import type { Config } from './types.ts';
import { openclawMenu, openclawDirect } from './commands/openclaw.ts';
import { statusDashboard } from './commands/status.ts';
import { gatewayMenu } from './commands/gateway.ts';
import { monitoringMenu } from './commands/monitoring.ts';
import { infraMenu } from './commands/infra.ts';
import { otelMenu } from './commands/otel.ts';
import { backupsMenu } from './commands/backups.ts';
import { runVerification } from './commands/verify.ts';

function banner(): void {
  console.log(chalk.bold.cyan('\n  OpenClaw VPS Management CLI\n'));
}

// ── Direct command dispatch ─────────────────────────────────────

const DIRECT_COMMANDS: Record<string, (cfg: Config, rest: string[]) => Promise<void>> = {
  oc: async (cfg, rest) => openclawDirect(cfg, rest.join(' ')),
  status: async (cfg) => statusDashboard(cfg),
  verify: async (cfg) => runVerification(cfg),
};

async function directMode(cfg: Config, args: string[]): Promise<boolean> {
  const cmd = args[0];
  if (!cmd || !DIRECT_COMMANDS[cmd]) return false;
  await DIRECT_COMMANDS[cmd](cfg, args.slice(1));
  return true;
}

// ── Interactive menu loop ───────────────────────────────────────

async function mainMenu(cfg: Config): Promise<void> {
  while (true) {
    banner();
    const action = await select({
      message: 'What would you like to do?',
      choices: [
        { name: 'OpenClaw', value: 'openclaw', description: 'Run openclaw CLI commands' },
        { name: 'Status Overview', value: 'status', description: 'Health dashboard for both VPSs' },
        { name: 'Gateway (Docker)', value: 'gateway', description: 'Manage the gateway container' },
        { name: 'Monitoring', value: 'monitoring', description: 'Manage observability stack' },
        { name: 'Infrastructure', value: 'infra', description: 'WireGuard, UFW, disk, resources' },
        { name: 'OTEL', value: 'otel', description: 'Check OTLP endpoints and config' },
        { name: 'Backups', value: 'backups', description: 'Backup operations' },
        { name: 'Verify All', value: 'verify', description: 'Full verification suite' },
        { name: 'Exit', value: 'exit' },
      ],
    });

    switch (action) {
      case 'openclaw':
        await openclawMenu(cfg);
        break;
      case 'status':
        await statusDashboard(cfg);
        break;
      case 'gateway':
        await gatewayMenu(cfg);
        break;
      case 'monitoring':
        await monitoringMenu(cfg);
        break;
      case 'infra':
        await infraMenu(cfg);
        break;
      case 'otel':
        await otelMenu(cfg);
        break;
      case 'backups':
        await backupsMenu(cfg);
        break;
      case 'verify':
        await runVerification(cfg);
        break;
      case 'exit':
        console.log(chalk.dim('  Goodbye.\n'));
        return;
    }
  }
}

// ── Entry point ─────────────────────────────────────────────────

async function main(): Promise<void> {
  let cfg: Config;
  try {
    cfg = loadConfig();
  } catch (err) {
    console.error(chalk.red(`Error: ${(err as Error).message}`));
    process.exit(1);
  }

  const args = process.argv.slice(2);

  // Direct command mode: ./cli.mjs status, ./cli.mjs oc status, ./cli.mjs verify
  if (args.length > 0) {
    const handled = await directMode(cfg, args);
    if (!handled) {
      console.error(chalk.red(`Unknown command: ${args[0]}`));
      console.error(chalk.dim('Available: oc, status, verify'));
      process.exit(1);
    }
    return;
  }

  // Interactive mode
  await mainMenu(cfg);
}

main().catch((err) => {
  // ExitPromptError is thrown when user presses Ctrl+C in a prompt
  if (err.name === 'ExitPromptError') {
    console.log(chalk.dim('\n  Goodbye.\n'));
    process.exit(0);
  }
  console.error(chalk.red(err.message || err));
  process.exit(1);
});
