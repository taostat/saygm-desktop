import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(repository, 'ui/desktop/package.json'));
const { chromium } = require('@playwright/test');
const asar = require('@electron/asar');
const options = {};
for (let index = 2; index < process.argv.length; index += 2) {
  assert(
    process.argv[index].startsWith('--') && process.argv[index + 1],
    'Use named option/value pairs'
  );
  options[process.argv[index].slice(2)] = process.argv[index + 1];
}
for (const required of ['app', 'backend', 'source-backend', 'report']) {
  assert(options[required], `Missing --${required}`);
}
assert.equal(process.platform, 'darwin', 'This smoke test must run on macOS');
assert.equal(process.arch, 'arm64', 'This smoke test must run on native Apple Silicon');
assert.equal(
  process.env.GITHUB_ACTIONS,
  'true',
  'This smoke test is restricted to a disposable CI runner'
);

const appPath = await fs.realpath(path.resolve(options.app));
const backendPath = await fs.realpath(path.resolve(options.backend));
const sourceBackendPath = await fs.realpath(path.resolve(options['source-backend']));
const appBytes = await fs.readFile(appPath);
const backendBytes = await fs.readFile(backendPath);
const sourceBackendBytes = await fs.readFile(sourceBackendPath);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
assert.equal(
  sha256(backendBytes),
  sha256(sourceBackendBytes),
  'Packaged backend must match the built source binary'
);

function architectures(filename) {
  return execFileSync('lipo', ['-archs', filename], { encoding: 'utf8' })
    .trim()
    .split(/\s+/)
    .sort();
}

assert.deepEqual(
  architectures(appPath),
  ['arm64'],
  'Packaged Electron executable must be arm64-only'
);
assert.deepEqual(
  architectures(backendPath),
  ['arm64'],
  'Packaged Goose backend must be arm64-only'
);

const resourcesDirectory = path.dirname(path.dirname(backendPath));
const archivePath = path.join(resourcesDirectory, 'app.asar');
const mainBundle = asar.extractFile(archivePath, path.join('.vite', 'build', 'main.js')).toString();
assert(
  mainBundle.includes('https://account.saygm.com/v1'),
  'Packaged account service must use production'
);
assert(
  !mainBundle.includes('test-account.saygm.com'),
  'Test account transport must not be packaged'
);
assert(
  backendBytes.includes(Buffer.from('https://api.saygm.com')),
  'Packaged provider must use production gateway'
);

const reportPath = path.resolve(options.report);
await fs.mkdir(path.dirname(reportPath), { recursive: true });
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'saygm-native-macos-'));
const home = path.join(temporary, 'home');
const workingDirectory = path.join(temporary, 'work');
const userData = path.join(home, 'Library', 'Application Support', 'SayGM');
await fs.mkdir(home, { recursive: true });
await fs.mkdir(workingDirectory, { recursive: true });

const report = {
  started_at: new Date().toISOString(),
  platform: process.platform,
  architecture: process.arch,
  expected_architecture: 'arm64',
  app_sha256: sha256(appBytes),
  backend_sha256: sha256(backendBytes),
  source_backend_sha256: sha256(sourceBackendBytes),
  asar_sha256: sha256(await fs.readFile(archivePath)),
  app_architectures: architectures(appPath),
  backend_architectures: architectures(backendPath),
  boundary:
    'Disposable GitHub macOS runner; isolated HOME and app data. No login, customer credentials, inference, payment, or credential-store writes. CDP is bound to loopback for this smoke test only.',
  events: [],
};
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
async function note(name, detail = {}) {
  report.events.push({ at: new Date().toISOString(), name, ...detail });
  console.log(`PASS ${name}`);
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const inheritedNames = [
  'PATH',
  'HOME',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'USER',
  'LOGNAME',
  'SHELL',
  'TERM',
  'DISPLAY',
  'XAUTHORITY',
  'DBUS_SESSION_BUS_ADDRESS',
  'GITHUB_ACTIONS',
];
const childEnvironment = Object.fromEntries(
  inheritedNames
    .filter((name) => process.env[name] !== undefined)
    .map((name) => [name, process.env[name]])
);
childEnvironment.HOME = home;
childEnvironment.APPDATA = path.join(home, 'Library', 'Application Support');
childEnvironment.XDG_CONFIG_HOME = path.join(home, '.config');
childEnvironment.ELECTRON_ENABLE_LOGGING = '1';

let active;
async function start() {
  const port = await freePort();
  const child = spawn(
    appPath,
    ['--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`, '--disable-gpu'],
    {
      cwd: workingDirectory,
      env: childEnvironment,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  const instance = { child, browser: null, page: null, lastLog: '' };
  active = instance;
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk) => {
      instance.lastLog = (instance.lastLog + String(chunk)).slice(-12000);
    });
  }
  let spawnError;
  child.once('error', (error) => {
    spawnError = error;
  });
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    if (spawnError)
      throw new Error(`Packaged app could not start: ${spawnError.code ?? 'spawn error'}`);
    if (child.exitCode !== null)
      throw new Error(
        `Packaged app exited before renderer startup (${child.exitCode}): ${instance.lastLog}`
      );
    try {
      instance.browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, {
        timeout: 1500,
      });
      break;
    } catch {
      await delay(250);
    }
  }
  assert(instance.browser, 'Packaged app CDP endpoint did not become ready');
  while (Date.now() < deadline) {
    for (const context of instance.browser.contexts()) {
      for (const candidate of context.pages()) {
        try {
          if (
            await candidate.evaluate(() =>
              Boolean(window.electron?.gmAccount && document.body.innerText.trim())
            )
          ) {
            const acpUrl = await candidate.evaluate(() => window.electron.getAcpUrl());
            if (acpUrl) {
              instance.page = candidate;
              break;
            }
          }
        } catch {
          // Electron may replace its splash page during startup.
        }
      }
      if (instance.page) break;
    }
    if (instance.page) break;
    await delay(250);
  }
  assert(instance.page, 'Packaged renderer/preload and embedded backend did not become ready');
  const details = await instance.page.evaluate(async () => ({
    platform: window.electron.platform,
    arch: window.electron.arch,
    version: window.electron.getVersion(),
    acpUrl: await window.electron.getAcpUrl(),
    config: window.electron.getConfig(),
    status: await window.electron.gmAccount.getStatus(),
  }));
  assert.equal(details.platform, 'darwin');
  assert.equal(details.arch, 'arm64');
  assert.equal(details.version, '0.1.0-rc.5');
  assert.equal(path.resolve(details.config.GOOSE_PATH_ROOT), path.join(userData, 'agent'));
  const startupDirectory = path.join(userData, 'logs', 'startup');
  const startupFiles = (await fs.readdir(startupDirectory))
    .filter((name) => name.startsWith('goose-serve-startup-') && name.endsWith('.json'))
    .sort();
  assert(startupFiles.length > 0, 'Packaged app must record the embedded backend startup');
  const startup = JSON.parse(
    await fs.readFile(path.join(startupDirectory, startupFiles.at(-1)), 'utf8')
  );
  assert.equal(
    await fs.realpath(startup.binaryPath),
    backendPath,
    'App must launch its packaged backend'
  );
  assert(Number.isInteger(startup.pid) && startup.pid > 0 && startup.healthCheckSucceeded);
  const endpoint = new URL(details.acpUrl);
  assert.equal(endpoint.protocol, 'wss:');
  assert.equal(endpoint.hostname, '127.0.0.1');
  assert(/^\d+$/.test(endpoint.port));
  assert(Number(endpoint.port) > 0 && Number(endpoint.port) <= 65535);
  report.secure_storage_available = Boolean(details.status.secureStorageAvailable);
  await note('Packaged renderer/preload, isolated profile, and local TLS backend are live', {
    version: details.version,
    secure_storage_available: report.secure_storage_available,
  });

  await instance.page.evaluate(async () => {
    const socket = new WebSocket(await window.electron.getAcpUrl());
    const pending = new Map();
    let sequence = 0;
    socket.addEventListener('message', (event) => {
      const response = JSON.parse(event.data);
      if (response.id !== undefined && pending.has(response.id)) {
        const callbacks = pending.get(response.id);
        pending.delete(response.id);
        clearTimeout(callbacks.timeout);
        response.error
          ? callbacks.reject(
              new Error(`ACP error ${response.error.code}: ${response.error.message}`)
            )
          : callbacks.resolve(response.result);
      } else if (response.method && response.id !== undefined) {
        socket.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: response.id,
            error: { code: -32601, message: 'QA client does not handle interactive requests' },
          })
        );
      }
    });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('ACP socket connection timed out')), 15000);
      socket.addEventListener(
        'open',
        () => {
          clearTimeout(timeout);
          resolve();
        },
        { once: true }
      );
      socket.addEventListener(
        'error',
        () => {
          clearTimeout(timeout);
          reject(new Error('Pinned local ACP connection failed'));
        },
        { once: true }
      );
    });
    window.__qaAcp = {
      request(method, params) {
        const id = ++sequence;
        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`ACP timeout: ${method}`));
          }, 30000);
          pending.set(id, { resolve, reject, timeout });
          socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
        });
      },
      close: () => socket.close(),
    };
  });
  const initialize = await instance.page.evaluate(() =>
    window.__qaAcp.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'SayGM macOS package QA', version: '1' },
    })
  );
  assert.equal(initialize.protocolVersion, 1);
  const providers = await instance.page.evaluate(() =>
    window.__qaAcp.request('_goose/unstable/providers/list', {})
  );
  assert.deepEqual(
    providers.entries.map((entry) => entry.providerId),
    ['saygm']
  );
  await note('Packaged backend ACP initialize and SayGM-only provider inventory passed');
  await instance.page
    .getByRole('heading', { name: 'Connect SayGM', exact: true })
    .waitFor({ state: 'visible', timeout: 30000 });
  await instance.page.screenshot({ path: reportPath.replace(/\.json$/, '') + '.png' });
  await note('First-run SayGM onboarding rendered and screenshot captured');
}

async function stop() {
  const instance = active;
  if (!instance) return;
  try {
    await instance.page?.evaluate(() => {
      window.__qaAcp?.close();
      window.electron.closeWindow();
    });
  } catch {
    // Window close can end CDP before its acknowledgement.
  }
  await delay(1200);
  if (instance.child.exitCode === null && instance.child.pid) {
    try {
      process.kill(-instance.child.pid, 'SIGTERM');
    } catch {
      /* Already exited. */
    }
    await delay(300);
    try {
      process.kill(-instance.child.pid, 'SIGKILL');
    } catch {
      /* Already exited. */
    }
  }
  await instance.browser?.close().catch(() => undefined);
  active = undefined;
}

try {
  await start();
  await stop();
  report.result = 'passed';
} catch (error) {
  report.result = 'failed';
  report.error = String(error.message);
  if (active?.lastLog) report.app_log_tail = active.lastLog;
  process.exitCode = 1;
} finally {
  try {
    await stop();
  } catch (error) {
    report.result = 'failed';
    report.cleanup_error = String(error.message);
    process.exitCode = 1;
  }
  try {
    await fs.rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
    report.profile_cleanup = true;
  } catch (error) {
    report.result = 'failed';
    report.profile_cleanup = false;
    report.cleanup_error ??= String(error.message);
    process.exitCode = 1;
  }
  report.completed_at = new Date().toISOString();
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(
    JSON.stringify({
      result: report.result,
      error: report.error,
      profile_cleanup: report.profile_cleanup,
      report: reportPath,
    })
  );
}
