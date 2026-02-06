import { select } from '@inquirer/prompts';
import type { Config } from '../types.ts';
import {
  dockerCompose,
  dockerComposeSafe,
  sshSafe,
  sshStream,
} from '../ssh.ts';
import { header, info, fail, ok, printOutput } from '../ui.ts';

const SERVICES = ['prometheus', 'grafana', 'loki', 'tempo', 'alertmanager', 'node-exporter', 'cadvisor'] as const;

export async function monitoringMenu(cfg: Config): Promise<void> {
  while (true) {
    header('Monitoring (VPS-2)');
    const action = await select({
      message: 'Monitoring management',
      choices: [
        { name: 'Container status', value: 'ps' },
        { name: 'Service health', value: 'health' },
        { name: 'Service logs', value: 'logs' },
        { name: 'Start stack', value: 'start' },
        { name: 'Stop stack', value: 'stop' },
        { name: 'Restart stack', value: 'restart' },
        { name: 'Firing alerts', value: 'alerts' },
        { name: 'Back', value: 'back' },
      ],
    });

    if (action === 'back') return;

    switch (action) {
      case 'ps': {
        const r = await dockerComposeSafe(cfg, 'vps2', 'ps');
        if (r.ok) printOutput(r.stdout);
        else fail(r.stderr);
        break;
      }
      case 'health': {
        info('Checking service health...');
        const checks = await Promise.allSettled([
          sshSafe(cfg, 'vps2', 'curl -sf http://10.0.0.2:9090/-/healthy').then((r) =>
            r.ok ? ok('Prometheus: healthy') : fail('Prometheus: unreachable')
          ),
          sshSafe(cfg, 'vps2', 'curl -sf http://10.0.0.2:3100/ready').then((r) =>
            r.ok ? ok('Loki: ready') : fail('Loki: not ready')
          ),
          sshSafe(cfg, 'vps2', 'curl -sf http://localhost:3200/ready').then((r) =>
            r.ok ? ok('Tempo: ready') : fail('Tempo: not ready')
          ),
          sshSafe(cfg, 'vps2', 'curl -sf http://localhost:3000/api/health').then((r) =>
            r.ok ? ok('Grafana: healthy') : fail('Grafana: unreachable')
          ),
          sshSafe(cfg, 'vps2', 'curl -sf http://localhost:9093/-/healthy').then((r) =>
            r.ok ? ok('Alertmanager: healthy') : fail('Alertmanager: unreachable')
          ),
        ]);
        console.log();
        break;
      }
      case 'logs': {
        const service = await select({
          message: 'Which service?',
          choices: SERVICES.map((s) => ({ name: s, value: s })),
        });
        const mode = await select({
          message: 'Log mode',
          choices: [
            { name: 'Tail (last 100 lines)', value: 'tail' },
            { name: 'Follow (live)', value: 'follow' },
          ],
        });
        if (mode === 'follow') {
          info(`Streaming ${service} logs... Press Ctrl+C to stop.`);
          await sshStream(cfg, 'vps2', `sudo docker logs -f ${service}`);
        } else {
          const r = await sshSafe(cfg, 'vps2', `sudo docker logs --tail 100 ${service}`);
          printOutput(r.stdout || r.stderr);
        }
        break;
      }
      case 'start':
        info('Starting monitoring stack...');
        printOutput(await dockerCompose(cfg, 'vps2', 'up -d'));
        info('Done.');
        break;
      case 'stop':
        info('Stopping monitoring stack...');
        printOutput(await dockerCompose(cfg, 'vps2', 'down'));
        info('Done.');
        break;
      case 'restart':
        info('Restarting monitoring stack...');
        printOutput(await dockerCompose(cfg, 'vps2', 'restart'));
        info('Done.');
        break;
      case 'alerts': {
        const r = await sshSafe(cfg, 'vps2', 'curl -sf http://localhost:9093/api/v2/alerts');
        if (r.ok) {
          const alerts = JSON.parse(r.stdout);
          if (alerts.length === 0) {
            info('No firing alerts.');
          } else {
            console.log(`  ${alerts.length} alert(s) firing:\n`);
            for (const a of alerts) {
              console.log(`  - ${a.labels?.alertname || 'unknown'} [${a.status?.state || '?'}]`);
              if (a.annotations?.summary) console.log(`    ${a.annotations.summary}`);
            }
          }
        } else {
          fail('Could not reach Alertmanager API');
        }
        console.log();
        break;
      }
    }
  }
}
