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
    'Disposable GitHub macOS runner; isolated HOME and app data. No login, account/provider credential writes, inference, or payment. Secure-storage availability is observed; persistence is not tested. CDP is bound to loopback for this smoke test only.',
  process_cleanup: false,
  events: [],
};
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
let smokeClosed = false;
async function persistReport() {
  report.updated_at = new Date().toISOString();
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
}
async function setPhase(name) {
  if (smokeClosed) throw new Error('Smoke has already ended');
  report.current_phase = name;
  console.log(`PHASE ${name}`);
  await persistReport();
}
async function withTimeout(promise, milliseconds, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds}ms`)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function note(name, detail = {}) {
  if (smokeClosed) throw new Error('Smoke has already ended');
  report.events.push({ at: new Date().toISOString(), name, ...detail });
  console.log(`PASS ${name}`);
  await persistReport();
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
function sanitizeDiagnostic(value) {
  return String(value)
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[url]')
    .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [redacted]')
    .replace(/\b(access[_-]?token|refresh[_-]?token|api[_-]?key|password|secret)\b\s*[:=]\s*[^\s,;"']+/gi, '$1=[redacted]')
    .slice(0, 500);
}
async function start() {
  await setPhase('reserve-loopback-debug-port');
  const port = await freePort();
  await setPhase('launch-packaged-app-with-isolated-home');
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
  const instance = {
    child,
    browser: null,
    page: null,
    backendPid: null,
    outputBytes: 0,
    diagnosticLines: [],
    carry: '',
  };
  active = instance;
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk) => {
      instance.outputBytes += chunk.length;
      const text = instance.carry + String(chunk);
      const lines = text.split(/\r?\n/);
      instance.carry = lines.pop()?.slice(-1000) ?? '';
      for (const line of lines) {
        if (/error|warn|failed|exception|panic|ready|health|startup|secure.?storage|keychain/i.test(line)) {
          instance.diagnosticLines.push(sanitizeDiagnostic(line));
          if (instance.diagnosticLines.length > 20) instance.diagnosticLines.shift();
        }
      }
    });
  }
  let spawnError;
  child.once('error', (error) => {
    spawnError = error;
  });
  await setPhase('wait-for-packaged-renderer');
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    if (spawnError)
      throw new Error(`Packaged app could not start: ${spawnError.code ?? 'spawn error'}`);
    if (child.exitCode !== null)
      throw new Error(`Packaged app exited before renderer startup (${child.exitCode})`);
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
          if (await withTimeout(
            candidate.evaluate(() => Boolean(window.electron?.gmAccount && document.body.innerText.trim())),
            5000,
            'renderer bridge probe'
          )) {
            instance.page = candidate;
            break;
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
  report.screenshot_path = reportPath.replace(/\.json$/, '') + '.png';
  await setPhase('capture-renderer-before-account-or-backend-ipc');
  await withTimeout(instance.page.screenshot({ path: report.screenshot_path }), 15000, 'initial screenshot');
  await note('Initial packaged renderer screenshot captured');
  await setPhase('verify-first-run-onboarding');
  await withTimeout(
    instance.page.getByRole('heading', { name: 'Connect SayGM', exact: true }).waitFor({ state: 'visible', timeout: 25000 }),
    28000,
    'onboarding heading'
  );
  await withTimeout(
    instance.page.screenshot({ path: report.screenshot_path, timeout: 10000 }),
    12000,
    'onboarding screenshot'
  );
  await note('First-run SayGM onboarding rendered');
  await setPhase('read-renderer-config');
  const details = await withTimeout(instance.page.evaluate(() => ({
    platform: window.electron.platform,
    arch: window.electron.arch,
    version: window.electron.getVersion(),
    config: window.electron.getConfig(),
  })), 10000, 'renderer config IPC');
  assert.equal(details.platform, 'darwin');
  assert.equal(details.arch, 'arm64');
  assert.equal(details.version, '0.1.0-rc.5');
  assert.equal(path.resolve(details.config.GOOSE_PATH_ROOT), path.join(userData, 'agent'));
  assert.equal(details.config.GOOSE_EXTERNAL_BACKEND, false, 'Smoke test must use the packaged local backend');
  await setPhase('read-fresh-account-status');
  const status = await withTimeout(instance.page.evaluate(() => window.electron.gmAccount.getStatus()), 10000, 'account status IPC');
  assert.equal(status.connected, false, 'Fresh profile must not contain a SayGM account');
  report.secure_storage_available = Boolean(status.secureStorageAvailable);
  await setPhase('read-local-acp-endpoint');
  const acpUrl = await withTimeout(instance.page.evaluate(() => window.electron.getAcpUrl()), 10000, 'local ACP endpoint IPC');
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
  instance.backendPid = startup.pid;
  const endpoint = new URL(acpUrl);
  assert.equal(endpoint.protocol, 'wss:');
  assert.equal(endpoint.hostname, '127.0.0.1');
  assert(/^\d+$/.test(endpoint.port));
  assert(Number(endpoint.port) > 0 && Number(endpoint.port) <= 65535);
  await note('Packaged renderer/preload, isolated profile, and local TLS backend are live', {
    version: details.version,
    secure_storage_available: report.secure_storage_available,
  });

  await setPhase('open-local-acp-websocket');
  await withTimeout(
    instance.page.evaluate(async (url) => {
      const socket = new WebSocket(url);
      const pending = new Map();
      let sequence = 0;
      socket.addEventListener('message', (event) => {
        const response = JSON.parse(event.data);
        if (response.id !== undefined && pending.has(response.id)) {
          const callbacks = pending.get(response.id);
          pending.delete(response.id);
          clearTimeout(callbacks.timeout);
          response.error
            ? callbacks.reject(new Error(`ACP error ${response.error.code}: ${response.error.message}`))
            : callbacks.resolve(response.result);
        } else if (response.method && response.id !== undefined) {
          socket.send(JSON.stringify({
            jsonrpc: '2.0',
            id: response.id,
            error: { code: -32601, message: 'QA client does not handle interactive requests' },
          }));
        }
      });
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('ACP socket connection timed out')), 15000);
        socket.addEventListener('open', () => { clearTimeout(timeout); resolve(); }, { once: true });
        socket.addEventListener('error', () => {
          clearTimeout(timeout);
          reject(new Error('Pinned local ACP connection failed'));
        }, { once: true });
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
    }, acpUrl),
    20000,
    'ACP websocket setup'
  );
  await setPhase('acp-initialize');
  const initialize = await withTimeout(
    instance.page.evaluate(() => window.__qaAcp.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'SayGM macOS package QA', version: '1' },
    })),
    35000,
    'ACP initialize'
  );
  assert.equal(initialize.protocolVersion, 1);
  await setPhase('acp-provider-inventory');
  const providers = await withTimeout(
    instance.page.evaluate(() => window.__qaAcp.request('_goose/unstable/providers/list', {})),
    35000,
    'ACP provider inventory'
  );
  assert.deepEqual(
    providers.entries.map((entry) => entry.providerId),
    ['saygm']
  );
  await note('Packaged backend ACP initialize and SayGM-only provider inventory passed');
}

async function stop() {
  const instance = active;
  if (!instance) {
    report.process_cleanup = true;
    return;
  }
  try {
    await withTimeout(instance.page?.evaluate(() => {
      window.__qaAcp?.close();
      window.electron.closeWindow();
    }), 3000, 'renderer close request');
  } catch {
    // Window close can end CDP before its acknowledgement.
  }
  await delay(1200);
  const appPid = instance.child.pid;
  assert(appPid, 'Packaged app must have a process id');
  const pidIsAlive = (pid) => {
    if (!pid) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if (error.code === 'ESRCH') return false;
      if (error.code === 'EPERM') return true;
      throw error;
    }
  };
  const groupIsAlive = (processGroupId) => {
    try {
      process.kill(-processGroupId, 0);
      return true;
    } catch (error) {
      if (error.code === 'ESRCH') return false;
      if (error.code === 'EPERM') return true;
      throw error;
    }
  };
  try {
    process.kill(-appPid, 'SIGTERM');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
  const stillRunning = () =>
    pidIsAlive(appPid) || pidIsAlive(instance.backendPid) || groupIsAlive(appPid);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && stillRunning()) await delay(250);
  if (stillRunning()) {
    try {
      process.kill(-appPid, 'SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
    if (pidIsAlive(instance.backendPid)) {
      try {
        process.kill(instance.backendPid, 'SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    }
    const killDeadline = Date.now() + 5000;
    while (Date.now() < killDeadline && stillRunning()) await delay(250);
  }
  await withTimeout(instance.browser?.close().catch(() => undefined), 3000, 'CDP browser close').catch(() => undefined);
  assert(!pidIsAlive(appPid), 'Packaged app process did not exit');
  assert(!pidIsAlive(instance.backendPid), 'Packaged backend process did not exit');
  assert(!groupIsAlive(appPid), 'Packaged app process group did not drain');
  report.process_cleanup = true;
  report.process_ids = { app: appPid, backend: instance.backendPid };
  report.app_output_bytes = instance.outputBytes;
  report.app_diagnostic_lines = instance.diagnosticLines;
  active = undefined;
}

try {
  await withTimeout((async () => {
    await start();
    await stop();
  })(), 180000, 'overall native smoke');
  report.result = 'passed';
} catch (error) {
  smokeClosed = true;
  report.result = 'failed';
  report.failure_phase = report.current_phase;
  report.error = sanitizeDiagnostic(error.message);
  if (active) {
    if (active.carry && /error|warn|failed|exception|panic|ready|health|startup|secure.?storage|keychain/i.test(active.carry)) {
      active.diagnosticLines.push(sanitizeDiagnostic(active.carry));
    }
    report.app_output_bytes = active.outputBytes;
    report.app_diagnostic_lines = active.diagnosticLines;
  }
  await persistReport();
  process.exitCode = 1;
} finally {
  smokeClosed = true;
  try {
    await withTimeout(stop(), 25000, 'bounded native cleanup');
  } catch (error) {
    report.result = 'failed';
    report.cleanup_error = sanitizeDiagnostic(error.message);
    process.exitCode = 1;
  }
  if (report.process_cleanup) {
    try {
      await fs.rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
      report.profile_cleanup = true;
    } catch (error) {
      report.result = 'failed';
      report.profile_cleanup = false;
      report.cleanup_error ??= sanitizeDiagnostic(error.message);
      process.exitCode = 1;
    }
  } else {
    report.result = 'failed';
    report.profile_cleanup = false;
    report.cleanup_error ??=
      'Temporary profile retained because app/backend process cleanup failed.';
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
