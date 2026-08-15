import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'yaml';
import {
  DEFAULT_WEBHOOK_PORT,
  addHostedReceiver,
  getDaemonWebhooksConfigPath,
  hostedReceiverPort,
  readDaemonWebhooksConfig,
  removeHostedReceiver,
  resolveReceiverSecrets,
  startHostedWebhookReceivers,
  writeDaemonWebhooksConfig,
} from './daemon-webhooks.js';
import { DAEMON_SERVICES, DAEMON_SERVICE_IDS } from './daemon-services.js';

let configDir: string;
let previousConfigDir: string | undefined;

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-webhooks-'));
  previousConfigDir = process.env.AGENTS_DAEMON_CONFIG_DIR;
  process.env.AGENTS_DAEMON_CONFIG_DIR = configDir;
});

afterEach(() => {
  if (previousConfigDir === undefined) delete process.env.AGENTS_DAEMON_CONFIG_DIR;
  else process.env.AGENTS_DAEMON_CONFIG_DIR = previousConfigDir;
  fs.rmSync(configDir, { recursive: true, force: true });
});

describe('daemon webhooks config', () => {
  it('hosts nothing when no config file exists', () => {
    expect(fs.existsSync(getDaemonWebhooksConfigPath())).toBe(false);
    expect(readDaemonWebhooksConfig()).toEqual({ receivers: [] });
  });

  it('round-trips a declared receiver through the real YAML file', () => {
    writeDaemonWebhooksConfig({
      receivers: [{ bundle: 'linear-webhook', port: 8788, rateLimit: 30, funnel: { publicPort: 443 } }],
    });

    const onDisk = yaml.parse(fs.readFileSync(getDaemonWebhooksConfigPath(), 'utf-8'));
    expect(onDisk.receivers).toEqual([
      { bundle: 'linear-webhook', port: 8788, rateLimit: 30, funnel: { publicPort: 443 } },
    ]);
    expect(readDaemonWebhooksConfig().receivers[0]).toEqual({
      bundle: 'linear-webhook',
      port: 8788,
      rateLimit: 30,
      funnel: { publicPort: 443 },
    });
  });

  it('reads an unreadable or malformed file as "host nothing", never a throw', () => {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(getDaemonWebhooksConfigPath(), 'receivers: [ this: is: not: valid', 'utf-8');
    expect(readDaemonWebhooksConfig()).toEqual({ receivers: [] });
  });

  it('drops an entry with no bundle and a funnel port Tailscale cannot serve', () => {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      getDaemonWebhooksConfigPath(),
      yaml.stringify({
        receivers: [
          { port: 9000 },                                        // no bundle -> unusable, dropped
          { bundle: 'gh', port: 8790, funnel: { publicPort: 9999 } }, // 9999 is not a Funnel port
        ],
      }),
      'utf-8',
    );
    const { receivers } = readDaemonWebhooksConfig();
    // The bundle-less entry is gone entirely; the bad funnel port is dropped but
    // the receiver still binds localhost rather than being silently discarded.
    expect(receivers).toEqual([{ bundle: 'gh', port: 8790 }]);
  });

  it('treats the port as the receiver identity: a second add on it is an edit', () => {
    addHostedReceiver({ bundle: 'first' });
    addHostedReceiver({ bundle: 'second', port: 8788 });
    expect(readDaemonWebhooksConfig().receivers.map((r) => [r.bundle, hostedReceiverPort(r)]))
      .toEqual([['first', DEFAULT_WEBHOOK_PORT], ['second', 8788]]);

    addHostedReceiver({ bundle: 'replacement', port: 8788 });
    expect(readDaemonWebhooksConfig().receivers.map((r) => [r.bundle, hostedReceiverPort(r)]))
      .toEqual([['first', DEFAULT_WEBHOOK_PORT], ['replacement', 8788]]);
  });

  it('removes by port and reports when nothing was declared there', () => {
    addHostedReceiver({ bundle: 'first' });
    expect(removeHostedReceiver(9999)).toBe(false);
    expect(readDaemonWebhooksConfig().receivers).toHaveLength(1);
    expect(removeHostedReceiver(DEFAULT_WEBHOOK_PORT)).toBe(true);
    expect(readDaemonWebhooksConfig().receivers).toEqual([]);
  });
});

describe('webhook-receiver daemon service', () => {
  it('is catalogued as a hosted service', () => {
    expect(DAEMON_SERVICE_IDS).toContain('webhook-receiver');
    const def = DAEMON_SERVICES.find((s) => s.id === 'webhook-receiver');
    expect(def?.title).toBe('Webhook receiver');
    expect(def?.description).toContain('webhooks.yaml');
  });
});

describe('startHostedWebhookReceivers', () => {
  it('binds nothing when no receiver is declared', async () => {
    const logs: string[] = [];
    const hosted = startHostedWebhookReceivers({ log: (level, msg) => logs.push(`${level} ${msg}`) });
    try {
      expect(hosted.count).toBe(0);
      expect(logs).toEqual([]);
    } finally {
      await hosted.close();
    }
  });

  it('fails a receiver LOUD when its signing secret cannot be resolved', async () => {
    // A bundle that genuinely does not exist on this machine — the same failure
    // shape as a locked bundle: the receiver must NOT bind unverifiable ingress,
    // and the reason must reach the daemon log rather than being swallowed.
    addHostedReceiver({ bundle: 'daemon-webhooks-test-absent-bundle', port: 8791 });
    const logs: { level: string; message: string }[] = [];
    const hosted = startHostedWebhookReceivers({ log: (level, message) => logs.push({ level, message }) });
    try {
      expect(hosted.count).toBe(0);
      expect(logs).toHaveLength(1);
      expect(logs[0].level).toBe('WARN');
      expect(logs[0].message).toContain(':8791 skipped');
      expect(logs[0].message).toContain('daemon-webhooks-test-absent-bundle');
    } finally {
      await hosted.close();
    }
  });

  it('throws rather than returning empty secrets for an unresolvable bundle', () => {
    expect(() => resolveReceiverSecrets('daemon-webhooks-test-absent-bundle')).toThrow();
  });
});
