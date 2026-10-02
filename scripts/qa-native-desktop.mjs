import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(repository, 'ui/desktop/package.json'));
const { chromium } = require('@playwright/test');
const asar = require('@electron/asar');
const options = {};
for (let index = 2; index < process.argv.length; index += 2) {
  assert(process.argv[index].startsWith('--') && process.argv[index + 1], 'Use named option/value pairs');
  options[process.argv[index].slice(2)] = process.argv[index + 1];
}
for (const required of ['app', 'backend', 'expect-storage', 'report']) assert(options[required], `Missing --${required}`);
assert(['available', 'unavailable'].includes(options['expect-storage']));
assert(['linux', 'win32'].includes(process.platform), 'This test must run on the native target OS');
const expectedArchitecture = options['expect-arch'] ?? 'x64';
assert(['x64', 'arm64'].includes(expectedArchitecture), 'Expected architecture must be x64 or arm64');
assert(process.platform === 'linux' || expectedArchitecture === 'x64', 'Windows RC5 supports x64 only');
assert.equal(process.arch, expectedArchitecture, 'QA must run natively on the requested artifact architecture');
const appPath = await fs.realpath(path.resolve(options.app));
const backendPath = await fs.realpath(path.resolve(options.backend));
const appBytes = await fs.readFile(appPath);
const backendBytes = await fs.readFile(backendPath);
for (const [name, bytes] of [['Electron app', appBytes], ['embedded backend', backendBytes]]) {
  if (process.platform === 'linux') {
    assert.equal(bytes.subarray(0, 4).toString('hex'), '7f454c46', `${name} must be ELF`);
    assert.equal(bytes[4], 2, `${name} must be ELF64`);
    assert.equal(bytes[5], 1, `${name} must be little-endian`);
    assert.equal(bytes.readUInt16LE(18), expectedArchitecture === 'arm64' ? 183 : 62, `${name} ELF architecture must match the native runner`);
  } else {
    assert.equal(bytes.subarray(0, 2).toString('ascii'), 'MZ', `${name} must be PE`);
    const peOffset = bytes.readUInt32LE(60);
    assert.equal(bytes.subarray(peOffset, peOffset + 4).toString('hex'), '50450000', `${name} must have a PE header`);
    assert.equal(bytes.readUInt16LE(peOffset + 4), 0x8664, `${name} must be x64 PE`);
  }
}
const archivePath = path.join(path.dirname(path.dirname(backendPath)), 'app.asar');
const bundledMain = asar.extractFile(archivePath, path.join('.vite', 'build', 'main.js')).toString();
assert(bundledMain.includes('https://account.saygm.com/v1'), 'Installed account service must target production');
assert(!bundledMain.includes('test-account.saygm.com'), 'Testnet account transport must not be packaged');
assert(backendBytes.includes(Buffer.from('https://api.saygm.com')), 'Installed SayGM provider must contain its production gateway');
const reportPath = path.resolve(options.report);
await fs.mkdir(path.dirname(reportPath), { recursive: true });
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'saygm-native-qa-'));
const appData = path.join(temporary, 'config');
const working = path.join(temporary, 'work');
await fs.mkdir(appData, { recursive: true });
await fs.mkdir(working, { recursive: true });
const temporaryUserData = path.join(appData, 'SayGM');
let userData = temporaryUserData;
let nativeWindowsUserData;
if (process.platform === 'win32') {
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Windows OS credential-store tests are restricted to a disposable CI runner');
  const knownAppData = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[Environment]::GetFolderPath("ApplicationData")'], { encoding: 'utf8' }).trim();
  assert(path.isAbsolute(knownAppData), 'Windows must return an absolute known AppData folder');
  nativeWindowsUserData = path.join(knownAppData, 'SayGM');
  await assert.rejects(fs.access(nativeWindowsUserData), { code: 'ENOENT' }, 'CI must start without an existing SayGM profile');
}
const events = [];
const fixture = `qa-not-a-real-key-${randomUUID()}`;
const fixtureHash = createHash('sha256').update(fixture).digest('hex');
let active;
let fixtureWritten = false;
let fixtureDeleted = false;
const report = {
  started_at: new Date().toISOString(),
  platform: process.platform,
  architecture: process.arch,
  expected_architecture: expectedArchitecture,
  app_and_backend_binary_architectures_verified: true,
  boundary: 'Actual packaged app and embedded backend; isolated app-data and disposable non-authoritative fixture only. No account login, customer credential, inference, or payment. CDP is bound to loopback for this test only. The invoking workflow records whether the app was installed or extracted from a portable archive.',
  expected_storage: options['expect-storage'],
  app_sha256: createHash('sha256').update(appBytes).digest('hex'),
  backend_sha256: createHash('sha256').update(backendBytes).digest('hex'),
  asar_sha256: createHash('sha256').update(await fs.readFile(archivePath)).digest('hex'),
  production_endpoint_markers_verified: true,
  events,
};
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
async function note(name, detail = {}) {
  events.push({ at: new Date().toISOString(), name, ...detail });
  console.log(`PASS ${name}`);
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
function childEnvironment() {
  const names = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'windir', 'WINDIR', 'COMSPEC', 'PATHEXT',
    'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USER', 'USERNAME',
    'DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'XDG_DATA_HOME', 'LANG', 'LC_ALL'];
  const environment = Object.fromEntries(names.filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]]));
  environment.APPDATA = appData;
  environment.LOCALAPPDATA = path.join(temporary, 'local');
  environment.XDG_CONFIG_HOME = appData;
  environment.ELECTRON_ENABLE_LOGGING = '1';
  return environment;
}
async function start() {
  const port = await freePort();
  const args = [`--remote-debugging-address=127.0.0.1`, `--remote-debugging-port=${port}`, '--disable-gpu'];
  if (options['password-store']) args.push(`--password-store=${options['password-store']}`);
  const child = spawn(appPath, args, { cwd: working, env: childEnvironment(), stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  const instance = { child, browser: null, page: null, lastLog: '' };
  active = instance;
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { instance.lastLog = (instance.lastLog + String(chunk)).slice(-12000); });
  let spawnError;
  child.once('error', (error) => { spawnError = error; });
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    if (spawnError) throw new Error(`Native app could not start: ${spawnError.code ?? 'spawn error'}`);
    if (child.exitCode !== null) throw new Error(`Native app exited before renderer startup (code ${child.exitCode})`);
    try {
      instance.browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 1500 });
      break;
    } catch { await delay(250); }
  }
  assert(instance.browser, 'Actual packaged app CDP endpoint did not become ready');
  while (Date.now() < deadline) {
    for (const context of instance.browser.contexts()) {
      for (const candidate of context.pages()) {
        try {
          if (await candidate.evaluate(() => !!window.electron?.gmAccount && document.body.innerText.trim().length > 0)) {
            const endpoint = await candidate.evaluate(() => window.electron.getAcpUrl());
            if (endpoint) { instance.page = candidate; break; }
          }
        } catch { /* A splash page can be replaced during startup. */ }
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
    update: await window.electron.checkForUpdates(),
    fallback: await window.electron.isUsingGitHubFallback(),
    autoDownloadDisabled: await window.electron.getAutoDownloadDisabled(),
  }));
  assert.equal(details.platform, process.platform);
  assert.equal(details.arch, expectedArchitecture);
  assert.equal(details.version, '0.1.0-rc.5');
  const runtimeRoot = path.resolve(details.config.GOOSE_PATH_ROOT);
  const temporaryRoot = path.join(temporaryUserData, 'agent');
  const nativeRoot = nativeWindowsUserData ? path.join(nativeWindowsUserData, 'agent') : null;
  if (process.platform === 'win32' && nativeRoot && runtimeRoot.toLowerCase() === nativeRoot.toLowerCase()) {
    userData = nativeWindowsUserData;
    report.profile_binding = 'fresh-native-windows-profile-on-disposable-runner';
  } else {
    assert.equal(runtimeRoot, temporaryRoot, 'App must use its isolated generated profile');
    userData = temporaryUserData;
    report.profile_binding = 'temporary-app-data';
  }
  const startupDirectory = path.join(userData, 'logs', 'startup');
  const startupFiles = (await fs.readdir(startupDirectory)).filter((name) => name.startsWith('goose-serve-startup-') && name.endsWith('.json')).sort();
  assert(startupFiles.length > 0, 'Packaged app must record its own backend startup');
  const startup = JSON.parse(await fs.readFile(path.join(startupDirectory, startupFiles.at(-1)), 'utf8'));
  const actualBackend = await fs.realpath(startup.binaryPath);
  assert.equal(process.platform === 'win32' ? actualBackend.toLowerCase() : actualBackend, process.platform === 'win32' ? backendPath.toLowerCase() : backendPath, 'App must launch its own installed backend');
  assert(Number.isInteger(startup.pid) && startup.pid > 0 && startup.healthCheckSucceeded, 'Installed backend must pass its real startup health check');
  if (process.platform === 'win32') {
    const moduleJson = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `$ErrorActionPreference = 'Stop'; ConvertTo-Json -Compress -InputObject @((Get-Process -Id ${startup.pid}).Modules | Where-Object { $_.ModuleName -match '^(msvcp|msvcr|vcruntime|concrt)[0-9].*\\.dll$' } | Select-Object ModuleName,FileName)`], { encoding: 'utf8' });
    const modules = JSON.parse(moduleJson);
    assert(Array.isArray(modules), 'Windows must return the backend runtime module list');
    const requiredRuntime = ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll'];
    report.windows_vc_runtime_modules = modules;
    report.windows_vc_runtime_loaded_from_bundle = requiredRuntime.every((name) => modules.some((module) => module.ModuleName.toLowerCase() === name))
      && modules.every((module) => path.dirname(module.FileName).toLowerCase() === path.dirname(backendPath).toLowerCase());
  }
  const endpoint = new URL(details.acpUrl);
  assert.equal(endpoint.protocol, 'wss:');
  assert.equal(endpoint.hostname, '127.0.0.1');
  assert.equal(details.config.GOOSE_EXTERNAL_BACKEND, false);
  assert.equal(details.status.connected, false);
  assert.equal(details.status.secureStorageAvailable, options['expect-storage'] === 'available');
  assert.equal(details.update.error, 'Updates are disabled in this build.');
  assert.equal(details.fallback, false);
  assert.equal(details.autoDownloadDisabled, true);
  if (process.platform === 'win32') {
    await assert.rejects(fs.access(path.join(temporary, 'local', 'Goose')), { code: 'ENOENT' }, 'SayGM must not write upstream Goose helper directories');
  }
  await note('Packaged app renderer, preload, isolated storage, local TLS backend and disabled updater are live', {
    version: details.version, secure_storage_available: details.status.secureStorageAvailable,
  });
  await instance.page.evaluate(async () => {
    const url = await window.electron.getAcpUrl();
    const socket = new WebSocket(url);
    const pending = new Map();
    let sequence = 0;
    socket.addEventListener('message', (event) => {
      const response = JSON.parse(event.data);
      if (response.id !== undefined && pending.has(response.id)) {
        const callbacks = pending.get(response.id); pending.delete(response.id); clearTimeout(callbacks.timeout);
        response.error ? callbacks.reject(new Error(`ACP error ${response.error.code}: ${response.error.message}`)) : callbacks.resolve(response.result);
      } else if (response.method && response.id !== undefined) {
        socket.send(JSON.stringify({ jsonrpc: '2.0', id: response.id, error: { code: -32601, message: 'QA client does not handle interactive requests' } }));
      }
    });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('ACP socket connection timed out')), 15000);
      socket.addEventListener('open', () => { clearTimeout(timeout); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('Pinned local ACP connection failed')); }, { once: true });
    });
    window.__qaAcp = {
      request(method, params) {
        const id = ++sequence;
        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`ACP timeout: ${method}`)); }, 30000);
          pending.set(id, { resolve, reject, timeout });
          socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
        });
      },
      close: () => socket.close(),
    };
  });
  const initialize = await rpc('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'SayGM artifact QA', version: '1' } });
  assert.equal(initialize.protocolVersion, 1);
  const providers = await rpc('_goose/unstable/providers/list', {});
  assert.deepEqual(providers.entries.map((entry) => entry.providerId), ['saygm']);
  await note('Real embedded ACP initialize and SayGM-only provider inventory passed');
  return instance;
}
async function rpc(method, params) {
  assert(active?.page);
  return active.page.evaluate(({ method, params }) => window.__qaAcp.request(method, params), { method, params });
}
async function stop() {
  const instance = active;
  if (!instance) return;
  try { await instance.page?.evaluate(() => { window.__qaAcp?.close(); window.electron.closeWindow(); }); } catch { /* Window close can end CDP before its acknowledgement. */ }
  await delay(1200);
  if (instance.child.exitCode === null && instance.child.pid) {
    if (process.platform === 'win32') {
      try { execFileSync('taskkill.exe', ['/PID', String(instance.child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* Already exited. */ }
    } else {
      try { process.kill(-instance.child.pid, 'SIGTERM'); } catch { /* Already exited. */ }
      await delay(300);
      try { process.kill(-instance.child.pid, 'SIGKILL'); } catch { /* Already exited. */ }
    }
  }
  await instance.browser?.close().catch(() => undefined);
  active = undefined;
}
async function readFixtureState() {
  const response = await rpc('_goose/unstable/providers/config/read', { providerId: 'saygm' });
  const field = response.fields.find((entry) => entry.key === 'SAYGM_API_KEY');
  assert(field && field.isSecret, 'SayGM key must remain a secret field');
  assert(field.value === undefined || field.value === null || field.value === 'qa-n...', 'Provider configuration must mask the disposable fixture');
  return field.isSet;
}
async function assertNoPlaintextFixture(directory = userData) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) await assertNoPlaintextFixture(filename);
    else if (entry.isFile()) {
      const contents = await fs.readFile(filename);
      assert(!contents.includes(Buffer.from(fixture)), 'Disposable provider key must not appear in plaintext app-data');
    }
  }
}
try {
  await start();
  if (options['expect-storage'] === 'available') {
    assert.equal(await readFixtureState(), false, 'Disposable runner keyring must not contain an existing SayGM credential');
    fixtureWritten = true;
    await rpc('_goose/unstable/providers/config/save', { providerId: 'saygm', fields: [{ key: 'SAYGM_API_KEY', value: fixture }] });
    assert.equal(await readFixtureState(), true);
    await stop();
    await assertNoPlaintextFixture();
    await note('Bundled backend stored a disposable non-authoritative fixture in the native secret store');
    await start();
    assert.equal(await readFixtureState(), true);
    const deletion = await rpc('_goose/unstable/providers/secrets/delete-if-sha256-matches', { providerId: 'saygm', key: 'SAYGM_API_KEY', expectedSha256: fixtureHash });
    assert.equal(deletion.deleted, true, 'Restarted backend must decrypt and match the exact fixture before deletion');
    fixtureDeleted = true;
    assert.equal(await readFixtureState(), false);
    await note('Native secret-store persistence and exact hash-based deletion passed after app/backend restart');
  } else {
    const error = await active.page.evaluate(async () => {
      try { await window.electron.gmAccount.beginDeviceLogin(); return null; }
      catch (error) { return String(error.message ?? error); }
    });
    assert(error && /secure|storage|credential/i.test(error), 'Unprotected storage must prevent OAuth setup before device authorization');
    await note('Linux basic_text storage fails closed before OAuth setup');
  }
  await active.page.getByRole('heading', { name: 'Connect SayGM', exact: true }).waitFor({ state: 'visible', timeout: 30000 });
  const signIn = active.page.getByRole('button', { name: /^Continue in browser/ });
  if (options['expect-storage'] === 'unavailable') {
    await active.page.getByRole('alert').filter({ hasText: 'SayGM could not access secure storage.' }).waitFor({ state: 'visible', timeout: 30000 });
    assert.equal(await signIn.isDisabled(), true, 'Onboarding must disable sign-in when storage is unprotected');
  } else {
    assert.equal(await signIn.isEnabled(), true, 'Fresh protected profile must present browser sign-in');
  }
  await note('Fresh-profile onboarding rendered with the expected sign-in availability');
  await active.page.screenshot({ path: reportPath.replace(/\.json$/, '') + '.png' });
  await stop();
  await assertNoPlaintextFixture();
  if (process.platform === 'win32') {
    assert.equal(report.windows_vc_runtime_loaded_from_bundle, true, 'Backend Visual C++ runtime DLLs must load from its own bundle, not the build runner');
  }
  report.result = 'passed';
} catch (error) {
  report.result = 'failed';
  report.error = String(error.message).replaceAll(fixture, '[fixture]');
  process.exitCode = 1;
} finally {
  if (fixtureWritten && !fixtureDeleted) {
    try {
      if (!active?.page) await start();
      const cleanup = await rpc('_goose/unstable/providers/secrets/delete-if-sha256-matches', { providerId: 'saygm', key: 'SAYGM_API_KEY', expectedSha256: fixtureHash });
      fixtureDeleted = cleanup.deleted === true;
    } catch { /* Report incomplete fixture cleanup explicitly. */ }
  }
  await stop();
  report.fixture_cleanup = !fixtureWritten || fixtureDeleted;
  if (!report.fixture_cleanup) { report.result = 'failed'; process.exitCode = 1; }
  await fs.rm(temporary, { recursive: true, force: true });
  if (nativeWindowsUserData) await fs.rm(nativeWindowsUserData, { recursive: true, force: true });
  report.completed_at = new Date().toISOString();
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ result: report.result, error: report.error, fixture_cleanup: report.fixture_cleanup, report: reportPath }));
}
