/**
 * Disposable real-SSH endpoint for the resolver integration tests. ssh2 owns
 * only the protocol boundary; every exec launches an actual agents-cli process.
 */
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import ssh2 from 'ssh2';

const { Server } = ssh2;

const config = JSON.parse(process.argv[2]);
const children = new Set();
const trace = event => fs.appendFileSync(config.tracePath, `${event}\n`);

function runPeer(stream, command) {
  const invocation = config.peer === 'old'
    ? { command: process.execPath, args: [config.oldCliEntry, ...config.peerArgs] }
    : { command: process.execPath, args: ['--import', config.tsxLoaderUrl, config.currentCliEntry, ...config.peerArgs] };
  const child = spawn(invocation.command, invocation.args, {
    cwd: config.cwd,
    env: {
      ...process.env,
      HOME: config.peerHome,
      USERPROFILE: config.peerHome,
      AGENTS_SKIP_MIGRATION: '1',
      AGENTS_SESSIONS_LOCAL: '1',
      NODE_NO_WARNINGS: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk.toString(); });
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  child.on('close', code => {
    children.delete(child);
    const status = typeof code === 'number' ? code : 255;
    fs.writeFileSync(config.auditPath, JSON.stringify({ command, invocation, status, stdout, stderr }));
    if (config.peer === 'malformed' && status === 0) {
      stream.exit(0);
      stream.end(`{transport-corruption:${stdout.length}`);
      return;
    }
    stream.exit(status);
    stream.end(stdout);
  });
}

const server = new Server({ hostKeys: [fs.readFileSync(config.hostKeyPath)] }, client => {
  trace('connection');
  client.on('authentication', context => { trace(`authentication:${context.method}`); context.accept(); });
  client.on('ready', () => {
    trace('ready');
    client.on('session', accept => {
      trace('session');
      const session = accept();
      session.on('exec', (acceptExec, _reject, info) => { trace(`exec:${info.command}`); runPeer(acceptExec(), info.command); });
    });
  });
  client.on('error', error => trace(`client-error:${error.message}`));
});

server.on('error', error => trace(`server-error:${error.message}`));

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  process.send?.({ port: address.port });
});

async function shutdown() {
  await Promise.all(Array.from(children, child => new Promise(resolve => {
    child.once('close', resolve);
    child.kill('SIGKILL');
  })));
  server.close(() => process.exit(0));
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
