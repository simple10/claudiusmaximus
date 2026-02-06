import { select } from '@inquirer/prompts';
import type { Config } from '../types.ts';
import { sshSafe } from '../ssh.ts';
import { header, info, ok, fail, printOutput, vpsLabel, divider } from '../ui.ts';

async function runOnBoth(cfg: Config, label: string, cmd: string): Promise<void> {
  const [r1, r2] = await Promise.all([
    sshSafe(cfg, 'vps1', cmd),
    sshSafe(cfg, 'vps2', cmd),
  ]);

  console.log(`\n  ${vpsLabel('vps1')} ${label}`);
  if (r1.ok) printOutput(r1.stdout);
  else fail(r1.stderr);

  divider();

  console.log(`  ${vpsLabel('vps2')} ${label}`);
  if (r2.ok) printOutput(r2.stdout);
  else fail(r2.stderr);

  console.log();
}

export async function infraMenu(cfg: Config): Promise<void> {
  while (true) {
    header('Infrastructure');
    const action = await select({
      message: 'Infrastructure checks',
      choices: [
        { name: 'WireGuard status', value: 'wg' },
        { name: 'Firewall status', value: 'ufw' },
        { name: 'Disk usage', value: 'disk' },
        { name: 'System resources', value: 'resources' },
        { name: 'SSH connectivity', value: 'ssh' },
        { name: 'Back', value: 'back' },
      ],
    });

    if (action === 'back') return;

    switch (action) {
      case 'wg':
        await runOnBoth(cfg, 'WireGuard', 'sudo wg show');
        break;
      case 'ufw':
        await runOnBoth(cfg, 'UFW', 'sudo ufw status');
        break;
      case 'disk':
        await runOnBoth(cfg, 'Disk usage', 'df -h --output=source,size,used,avail,pcent -x tmpfs -x devtmpfs 2>/dev/null || df -h');
        break;
      case 'resources':
        await runOnBoth(cfg, 'System resources', 'echo "--- Memory ---" && free -h && echo "--- Uptime ---" && uptime');
        break;
      case 'ssh': {
        const [r1, r2] = await Promise.all([
          sshSafe(cfg, 'vps1', 'echo ok'),
          sshSafe(cfg, 'vps2', 'echo ok'),
        ]);
        r1.ok ? ok(`${vpsLabel('vps1')} Connected`) : fail(`${vpsLabel('vps1')} ${r1.stderr}`);
        r2.ok ? ok(`${vpsLabel('vps2')} Connected`) : fail(`${vpsLabel('vps2')} ${r2.stderr}`);
        console.log();
        break;
      }
    }
  }
}
