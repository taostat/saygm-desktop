import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
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
for (const required of ['app', 'backend', 'report']) {
  assert(options[required], `Missing --${required}`);
}
assert(
  options['source-backend'] || options['expected-backend-sha256'],
  'Provide --source-backend or --expected-backend-sha256'
);
assert.equal(process.platform, 'darwin', 'This smoke test must run on macOS');
assert.equal(process.arch, 'arm64', 'This smoke test must run on native Apple Silicon');
assert.equal(
  process.env.GITHUB_ACTIONS,
  'true',
  'This smoke test is restricted to a disposable CI runner'
);

const appPath = await fs.realpath(path.resolve(options.app));
const backendPath = await fs.realpath(path.resolve(options.backend));
const sourceBackendPath = options['source-backend']
  ? await fs.realpath(path.resolve(options['source-backend']))
  : null;
const appBytes = await fs.readFile(appPath);
const backendBytes = await fs.readFile(backendPath);
const sourceBackendBytes = sourceBackendPath ? await fs.readFile(sourceBackendPath) : null;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const backendSha256 = sha256(backendBytes);
const sourceBackendSha256 = sourceBackendBytes ? sha256(sourceBackendBytes) : null;
assert.equal(
  backendSha256,
  sourceBackendSha256 ?? options['expected-backend-sha256'],
  sourceBackendPath
    ? 'Packaged backend must match the built source binary'
    : 'Packaged backend must match the pinned native-build artifact hash'
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
const runnerHome = path.resolve(process.env.HOME || os.homedir());
const workingDirectory = path.join(temporary, 'work');
const expectedUserData = path.join(runnerHome, 'Library', 'Application Support', 'SayGM');
let userDataDirectory = expectedUserData;
let runnerProfileOwnedBySmoke = false;
await fs.mkdir(workingDirectory, { recursive: true });

const report = {
  started_at: new Date().toISOString(),
  platform: process.platform,
  architecture: process.arch,
  expected_architecture: 'arm64',
  app_sha256: sha256(appBytes),
  backend_sha256: backendSha256,
  source_backend_sha256: sourceBackendSha256,
  expected_backend_sha256: sourceBackendPath ? null : options['expected-backend-sha256'],
  backend_comparison_source: sourceBackendPath ? 'native-build-output' : 'pinned-native-artifact',
  asar_sha256: sha256(await fs.readFile(archivePath)),
  app_architectures: architectures(appPath),
  backend_architectures: architectures(backendPath),
  boundary:
    'Disposable GitHub macOS runner with its native HOME. The smoke refuses an existing SayGM app-data profile and removes only the profile created by this run. The backend working directory is temporary. No login, SayGM account/provider credential writes, inference, or payment. Secure-storage availability is observed; persistence is not tested. CDP is bound to loopback for this smoke test only.',
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
childEnvironment.ELECTRON_ENABLE_LOGGING = '1';

async function ensureRunnerProfileIsAbsent() {
  let existingProfile = null;
  try {
    existingProfile = await fs.lstat(expectedUserData);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  assert.equal(
    existingProfile,
    null,
    'Refusing to launch against a pre-existing SayGM app-data profile on the runner'
  );
}

async function removeRunnerProfileCreatedBySmoke() {
  if (!runnerProfileOwnedBySmoke) return;
  assert.equal(userDataDirectory, expectedUserData, 'Refusing to remove an unexpected app-data path');
  let profile;
  try {
    profile = await fs.lstat(expectedUserData);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  assert(profile.isDirectory() && !profile.isSymbolicLink(), 'Runner SayGM profile is not a plain directory');
  await fs.rm(expectedUserData, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
}

let active;
function sanitizeDiagnostic(value) {
  return String(value)
    .replaceAll(runnerHome, '[runner-home]')
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[url]')
    .replace(/file:\/\/[^\s"'<>]+/gi, '[local file]')
    .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [redacted]')
    .replace(/\b(access[_-]?token|refresh[_-]?token|api[_-]?key|password|secret)\b\s*[:=]\s*[^\s,;"']+/gi, '$1=[redacted]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]')
    .slice(0, 500);
}
function appendDiagnostic(entries, detail, maximum = 30) {
  entries.push(detail);
  if (entries.length > maximum) entries.splice(0, entries.length - maximum);
}
function resourceName(rawUrl) {
  try {
    return path.basename(decodeURIComponent(new URL(rawUrl).pathname)).slice(0, 160) || '[root]';
  } catch {
    return '[unknown]';
  }
}
function observePage(page, instance) {
  if (instance.observedPages.has(page)) return;
  instance.observedPages.add(page);
  instance.pages.push(page);
  page.on('console', (message) => {
    if (message.type() !== 'error' && message.type() !== 'warning') return;
    appendDiagnostic(instance.rendererDiagnostics.console, {
      type: message.type(),
      text: sanitizeDiagnostic(message.text()),
    });
  });
  page.on('pageerror', (error) => {
    appendDiagnostic(
      instance.rendererDiagnostics.pageErrors,
      sanitizeDiagnostic(error.stack ?? error.message)
    );
  });
  page.on('requestfailed', (request) => {
    appendDiagnostic(instance.rendererDiagnostics.failedRequests, {
      resource: resourceName(request.url()),
      resource_type: request.resourceType(),
      error: sanitizeDiagnostic(request.failure()?.errorText ?? 'unknown request failure'),
    });
  });
  page.on('response', (response) => {
    if (response.status() < 400 || response.request().resourceType() !== 'script') return;
    appendDiagnostic(instance.rendererDiagnostics.failedScriptResponses, {
      resource: resourceName(response.url()),
      status: response.status(),
    });
  });
}
async function captureBackendStartup(instance) {
  const diagnosticsDirectory = path.join(instance.userDataDirectory, 'logs', 'startup');
  let names;
  try {
    names = (await fs.readdir(diagnosticsDirectory))
      .filter((name) => name.startsWith('goose-serve-startup-') && name.endsWith('.json'))
      .sort();
  } catch {
    return { directory_found: false, attempts: [] };
  }
  const attempts = [];
  for (const name of names.slice(-5)) {
    try {
      const startup = JSON.parse(await fs.readFile(path.join(diagnosticsDirectory, name), 'utf8'));
      attempts.push({
        file: name,
        binary_name: startup.binaryPath ? path.basename(startup.binaryPath) : null,
        pid: startup.pid,
        health_check_succeeded: startup.healthCheckSucceeded,
        child_exit_code: startup.childExitCode,
        child_exit_signal: startup.childExitSignal,
        events: (startup.events ?? []).slice(-20).map((event) => ({
          name: sanitizeDiagnostic(event.name),
          elapsed_ms: event.elapsedMs,
          at: event.at,
        })),
        stderr_tail: (startup.stderrTail ?? []).slice(-8).map(sanitizeDiagnostic),
      });
    } catch (error) {
      attempts.push({ file: name, read_error: sanitizeDiagnostic(error.message) });
    }
  }
  return { directory_found: true, attempts };
}
function captureMainProcessDiagnostics(instance) {
  const pid = instance.child.pid;
  if (!pid) return { attempted: false, reason: 'main PID unavailable' };

  let processState;
  try {
    processState = execFileSync('ps', ['-p', String(pid), '-o', 'pid=,ppid=,state=,comm='], {
      encoding: 'utf8',
      timeout: 3000,
    }).trim();
  } catch (error) {
    processState = sanitizeDiagnostic(error.message);
  }

  const sampled = spawnSync('/usr/bin/sample', [String(pid), '1', '1'], {
    encoding: 'utf8',
    timeout: 8000,
    maxBuffer: 512 * 1024,
  });
  const sampleOutput = [sampled.stdout, sampled.stderr].filter(Boolean).join('\n');
  const sampleLines = sampleOutput.split(/\r?\n/).filter(Boolean);
  const sampleSummary = sampleLines.filter((line) =>
    /^(Analysis of sampling|Process:|Path:|Identifier:|Version:|Code Type:|Parent Process:|Date\/Time:|OS Version:|Report Version:|Call graph:|Thread(?:\s|_)\d+)/.test(
      line.trimStart()
    ) || /^\s+(?:\+\s+)?\d+(?:\s|$)/.test(line)
  );
  return {
    attempted: true,
    process_state: processState.slice(0, 500),
    sample_exit_status: sampled.status,
    sample_signal: sampled.signal,
    sample_error: sampled.error ? sanitizeDiagnostic(sampled.error.message) : null,
    sample_lines: sampleSummary
      .slice(0, 100)
      .map((line) => sanitizeDiagnostic(line)),
  };
}
async function captureRendererFailure(instance) {
  const page = instance.page;
  if (!page || page.isClosed()) return { page_available: false };
  const captured = { page_available: true, screenshot_captured: false };

  try {
    const config = await withTimeout(
      page.evaluate(() => {
        const value = window.electron.getConfig();
        return {
          external_backend: Boolean(value?.GOOSE_EXTERNAL_BACKEND),
          path_root: typeof value?.GOOSE_PATH_ROOT === 'string' ? value.GOOSE_PATH_ROOT : null,
        };
      }),
      3000,
      'failure preload config'
    );
    const resolvedPathRoot = config.path_root ? path.resolve(config.path_root) : null;
    const configuredUserData = resolvedPathRoot ? path.dirname(resolvedPathRoot) : null;
    const pathRootUnderRunnerHome = Boolean(
      resolvedPathRoot && resolvedPathRoot.startsWith(`${runnerHome}${path.sep}`)
    );
    const pathRootMatchesExpected = resolvedPathRoot === path.join(expectedUserData, 'agent');
    if (pathRootUnderRunnerHome && pathRootMatchesExpected) {
      userDataDirectory = configuredUserData;
      instance.userDataDirectory = configuredUserData;
    }
    captured.preload_config = {
      state: 'resolved',
      external_backend: config.external_backend,
      path_root_present: Boolean(resolvedPathRoot),
      path_root_under_runner_home: pathRootUnderRunnerHome,
      path_root_matches_expected_agent_directory: pathRootMatchesExpected,
      app_data_relative_to_runner_home: pathRootUnderRunnerHome
        ? path.relative(runnerHome, configuredUserData)
        : null,
    };
  } catch (error) {
    captured.preload_config = {
      state: error.message.includes('timed out') ? 'timeout' : 'rejected',
      error: sanitizeDiagnostic(error.message),
    };
  }

  captured.main_process_diagnostics = captureMainProcessDiagnostics(instance);

  try {
    await withTimeout(
      page.screenshot({ path: report.screenshot_path, timeout: 5000 }),
      6000,
      'failure screenshot'
    );
    captured.screenshot_captured = true;
  } catch (error) {
    captured.screenshot_error = sanitizeDiagnostic(error.message);
  }
  try {
    captured.page = await withTimeout(
      page.evaluate(() => {
        const safeAssetName = (value) => {
          try {
            return new URL(value, location.href).pathname.split('/').filter(Boolean).at(-1) ?? '[root]';
          } catch {
            return '[unknown]';
          }
        };
        const visible = (element) => element.getClientRects().length > 0;
        const root = document.getElementById('root');
        const resources = performance.getEntriesByType('resource').slice(-30);
        return {
          title: document.title,
          ready_state: document.readyState,
          page_name: safeAssetName(location.href),
          body_text: document.body?.innerText.replace(/\s+/g, ' ').trim().slice(0, 1800) ?? '',
          visible_headings: Array.from(document.querySelectorAll('h1, h2, h3'))
            .filter(visible)
            .map((heading) => heading.innerText.trim().slice(0, 160))
            .slice(0, 20),
          visible_status_text: Array.from(document.querySelectorAll('[role="status"]'))
            .filter(visible)
            .map((element) => element.innerText.trim().slice(0, 200))
            .slice(0, 10),
          root_present: Boolean(root),
          root_child_count: root?.childElementCount ?? 0,
          root_text: root?.innerText.replace(/\s+/g, ' ').trim().slice(0, 1200) ?? '',
          scripts: Array.from(document.querySelectorAll('script[src]'))
            .map((script) => safeAssetName(script.src))
            .slice(0, 30),
          recent_resources: resources.map((resource) => ({
            name: safeAssetName(resource.name),
            initiator: resource.initiatorType,
            duration_ms: Math.round(resource.duration),
            transfer_size: resource.transferSize,
            decoded_size: resource.decodedBodySize,
          })),
        };
      }),
      6000,
      'failure renderer snapshot'
    );
  } catch (error) {
    captured.page_snapshot_error = sanitizeDiagnostic(error.message);
  }
  captured.ipc = {};
  let loopbackAcpUrl = null;
  const probes = [
    [
      'account_status',
      () => page.evaluate(() => window.electron.gmAccount.getStatus()),
      (value) => ({
        connected: Boolean(value?.connected),
        provider_configured: Boolean(value?.providerConfigured),
        secure_storage_available: Boolean(value?.secureStorageAvailable),
      }),
    ],
    [
      'acp_url',
      () => page.evaluate(() => window.electron.getAcpUrl()),
      (value) => {
        if (typeof value !== 'string') return { available: false };
        try {
          const endpoint = new URL(value);
          const loopback = endpoint.protocol === 'wss:' && endpoint.hostname === '127.0.0.1';
          if (loopback) loopbackAcpUrl = value;
          return {
            available: true,
            protocol: endpoint.protocol,
            loopback,
            port_present: Boolean(endpoint.port),
          };
        } catch {
          return { available: false, invalid: true };
        }
      },
    ],
  ];
  for (const [name, operation, project] of probes) {
    const startedAt = Date.now();
    try {
      const value = await withTimeout(operation(), 4000, `failure ${name} IPC`);
      captured.ipc[name] = {
        state: 'resolved',
        elapsed_ms: Date.now() - startedAt,
        value: project(value),
      };
    } catch (error) {
      captured.ipc[name] = {
        state: error.message.includes('timed out') ? 'timeout' : 'rejected',
        elapsed_ms: Date.now() - startedAt,
        error: sanitizeDiagnostic(error.message),
      };
    }
  }
  if (!loopbackAcpUrl) {
    captured.local_acp_probe = { state: 'skipped', reason: 'local loopback ACP URL unavailable' };
  } else {
    try {
      captured.local_acp_probe = await withTimeout(
        page.evaluate(async (url) => {
          const socket = new WebSocket(url);
          const pending = new Map();
          let sequence = 0;
          socket.addEventListener('message', (event) => {
            let response;
            try {
              response = JSON.parse(event.data);
            } catch {
              return;
            }
            if (response.id !== undefined && pending.has(response.id)) {
              const callbacks = pending.get(response.id);
              pending.delete(response.id);
              clearTimeout(callbacks.timeout);
              response.error
                ? callbacks.reject(new Error(`ACP request failed: ${response.error.code}`))
                : callbacks.resolve(response.result);
            } else if (response.method && response.id !== undefined) {
              socket.send(JSON.stringify({
                jsonrpc: '2.0',
                id: response.id,
                error: { code: -32601, message: 'Diagnostic client does not handle interactive requests' },
              }));
            }
          });
          const request = (method, params) => {
            const id = ++sequence;
            return new Promise((resolve, reject) => {
              const timeout = setTimeout(() => {
                pending.delete(id);
                reject(new Error(`ACP request timeout: ${method}`));
              }, 7000);
              pending.set(id, { resolve, reject, timeout });
              socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
            });
          };
          try {
            await new Promise((resolve, reject) => {
              const timeout = setTimeout(() => reject(new Error('ACP socket open timed out')), 7000);
              socket.addEventListener('open', () => { clearTimeout(timeout); resolve(); }, { once: true });
              socket.addEventListener('error', () => {
                clearTimeout(timeout);
                reject(new Error('Local ACP socket failed to open'));
              }, { once: true });
            });
            const initialized = await request('initialize', {
              protocolVersion: 1,
              clientCapabilities: {},
              clientInfo: { name: 'SayGM macOS diagnostic', version: '1' },
            });
            const providers = await request('_goose/unstable/providers/list', {});
            return {
              state: 'resolved',
              protocol_version: initialized?.protocolVersion ?? null,
              provider_ids: Array.isArray(providers?.entries)
                ? providers.entries.map((entry) => entry.providerId).filter((value) => typeof value === 'string')
                : [],
            };
          } finally {
            for (const callbacks of pending.values()) clearTimeout(callbacks.timeout);
            pending.clear();
            if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
              socket.close();
            }
          }
        }, loopbackAcpUrl),
        18000,
        'failure local ACP probe'
      );
    } catch (error) {
      captured.local_acp_probe = {
        state: error.message.includes('timed out') ? 'timeout' : 'rejected',
        error: sanitizeDiagnostic(error.message),
      };
    }
  }
  return captured;
}
async function start() {
  await setPhase('verify-runner-profile-is-absent');
  await ensureRunnerProfileIsAbsent();
  await note('Runner-native SayGM app-data profile was absent before launch');
  await setPhase('reserve-loopback-debug-port');
  const port = await freePort();
  await setPhase('launch-packaged-app-with-native-home');
  runnerProfileOwnedBySmoke = true;
  const child = spawn(
    appPath,
    [
      '--dir',
      workingDirectory,
      '--remote-debugging-address=127.0.0.1',
      `--remote-debugging-port=${port}`,
      '--disable-gpu',
    ],
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
    pages: [],
    observedPages: new Set(),
    userDataDirectory,
    rendererDiagnostics: {
      console: [],
      pageErrors: [],
      failedRequests: [],
      failedScriptResponses: [],
    },
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
  for (const context of instance.browser.contexts()) {
    context.on('page', (candidate) => observePage(candidate, instance));
    for (const candidate of context.pages()) observePage(candidate, instance);
  }
  while (Date.now() < deadline) {
    for (const context of instance.browser.contexts()) {
      for (const candidate of context.pages()) {
        observePage(candidate, instance);
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
  assert.equal(path.resolve(details.config.GOOSE_PATH_ROOT), path.join(userDataDirectory, 'agent'));
  assert.equal(details.config.GOOSE_EXTERNAL_BACKEND, false, 'Smoke test must use the packaged local backend');
  await setPhase('read-fresh-account-status');
  const status = await withTimeout(instance.page.evaluate(() => window.electron.gmAccount.getStatus()), 10000, 'account status IPC');
  assert.equal(status.connected, false, 'Fresh profile must not contain a SayGM account');
  report.secure_storage_available = Boolean(status.secureStorageAvailable);
  await setPhase('read-local-acp-endpoint');
  const acpUrl = await withTimeout(instance.page.evaluate(() => window.electron.getAcpUrl()), 10000, 'local ACP endpoint IPC');
  const startupDirectory = path.join(userDataDirectory, 'logs', 'startup');
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
    report.failure_diagnostics_at = new Date().toISOString();
    try {
      report.failure_renderer = await captureRendererFailure(active);
      for (const field of ['title', 'body_text', 'root_text']) {
        if (report.failure_renderer.page?.[field]) {
          report.failure_renderer.page[field] = sanitizeDiagnostic(report.failure_renderer.page[field]);
        }
      }
      if (report.failure_renderer.page?.visible_headings) {
        report.failure_renderer.page.visible_headings = report.failure_renderer.page.visible_headings
          .map(sanitizeDiagnostic);
      }
      if (report.failure_renderer.page?.visible_status_text) {
        report.failure_renderer.page.visible_status_text = report.failure_renderer.page.visible_status_text
          .map(sanitizeDiagnostic);
      }
      if (report.failure_renderer.ipc) {
        for (const probe of Object.values(report.failure_renderer.ipc)) {
          if (probe?.error) probe.error = sanitizeDiagnostic(probe.error);
        }
      }
    } catch (diagnosticError) {
      report.failure_renderer = { capture_error: sanitizeDiagnostic(diagnosticError.message) };
    }
    report.renderer_diagnostics = active.rendererDiagnostics;
    report.backend_startup_snapshot = await captureBackendStartup(active);
    const latestBackendPid = report.backend_startup_snapshot.attempts
      ?.slice()
      .reverse()
      .find((attempt) => Number.isInteger(attempt.pid) && attempt.pid > 0)?.pid;
    if (latestBackendPid) active.backendPid = latestBackendPid;
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
      await removeRunnerProfileCreatedBySmoke();
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
