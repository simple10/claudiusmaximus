import { select } from '@inquirer/prompts';
import type { Config } from '../types.ts';
import { sshSafe } from '../ssh.ts';
import { header, info, ok, fail, printOutput } from '../ui.ts';

export async function backupsMenu(cfg: Config): Promise<void> {
  while (true) {
    header('Backups');
    const action = await select({
      message: 'Backup operations',
      choices: [
        { name: 'Run manual backup', value: 'run' },
        { name: 'List backups', value: 'list' },
        { name: 'View backup log', value: 'log' },
        { name: 'View cron job', value: 'cron' },
        { name: 'Back', value: 'back' },
      ],
    });

    if (action === 'back') return;

    switch (action) {
      case 'run': {
        info('Running backup...');
        const r = await sshSafe(cfg, 'vps1', 'sudo /home/openclaw/scripts/backup.sh');
        if (r.ok) {
          ok('Backup completed');
          printOutput(r.stdout);
        } else {
          fail('Backup failed');
          printOutput(r.stderr || r.stdout);
        }
        break;
      }
      case 'list': {
        const r = await sshSafe(cfg, 'vps1', 'sudo ls -lh /home/openclaw/.openclaw/backups/ 2>/dev/null');
        if (r.ok && r.stdout.trim()) {
          printOutput(r.stdout);
        } else {
          info('No backups found or backup directory empty.');
        }
        break;
      }
      case 'log': {
        const r = await sshSafe(cfg, 'vps1', 'sudo cat /var/log/openclaw-backup.log 2>/dev/null | tail -50');
        if (r.ok && r.stdout.trim()) {
          printOutput(r.stdout);
        } else {
          info('No backup log found.');
        }
        break;
      }
      case 'cron': {
        const r = await sshSafe(cfg, 'vps1', 'sudo cat /etc/cron.d/openclaw-backup 2>/dev/null');
        if (r.ok && r.stdout.trim()) {
          printOutput(r.stdout);
        } else {
          info('No backup cron job found.');
        }
        break;
      }
    }
    console.log();
  }
}
