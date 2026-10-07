import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildLocalServeUrls,
  findGooseBinaryPath,
  startGooseServe,
  waitForGooseServeReady,
} from './gooseServe';

const binaryName = process.platform === 'win32' ? 'goose.exe' : 'goose';
const packagedBinaryName = process.platform === 'win32' ? 'saygm-agent.exe' : 'saygm-agent';
const tempDirs: string[] = [];
const originalCwd = process.cwd();

function makeTempDir(): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'goose-serve-test-'));
  tempDirs.push(tempDir);
  return tempDir;
}

function makeFile(filePath: string): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '');
  fs.chmodSync(filePath, 0o755);
  return filePath;
}

function makeExecutable(filePath: string, contents: string): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
  fs.chmodSync(filePath, 0o755);
  return filePath;
}

async function waitForFileLines(filePath: string): Promise<string[]> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, 'utf8').trim().split('\n');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

describe('findGooseBinaryPath', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    process.chdir(originalCwd);

    while (tempDirs.length > 0) {
      const tempDir = tempDirs.pop();
      if (tempDir) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }
  });

  it('uses GOOSE_BINARY in development builds', () => {
    const tempDir = makeTempDir();
    const overridePath = makeFile(path.join(tempDir, 'override-goose'));
    vi.stubEnv('GOOSE_BINARY', overridePath);

    expect(findGooseBinaryPath({ isPackaged: false })).toBe(overridePath);
  });

  it('rejects GOOSE_BINARY in packaged builds', () => {
    const tempDir = makeTempDir();
    const resourcesPath = path.join(tempDir, 'resources');
    const overridePath = makeFile(path.join(tempDir, 'override-goose'));
    makeFile(path.join(resourcesPath, 'bin', packagedBinaryName));
    vi.stubEnv('GOOSE_BINARY', overridePath);

    expect(() => findGooseBinaryPath({ isPackaged: true, resourcesPath })).toThrow(
      'GOOSE_BINARY is only supported in development builds'
    );
  });

  it('prefers the staged binary over target builds in development builds', () => {
    const tempDir = makeTempDir();
    const desktopDir = path.join(tempDir, 'ui', 'desktop');
    const stagedPath = makeFile(path.join(desktopDir, 'src', 'bin', binaryName));
    const debugPath = makeFile(path.join(tempDir, 'target', 'debug', binaryName));
    const releasePath = makeFile(path.join(tempDir, 'target', 'release', binaryName));
    process.chdir(desktopDir);

    const resolvedPath = findGooseBinaryPath({ isPackaged: false });
    expect(fs.realpathSync(resolvedPath)).toBe(fs.realpathSync(stagedPath));
    expect(fs.realpathSync(resolvedPath)).not.toBe(fs.realpathSync(releasePath));
    expect(fs.realpathSync(resolvedPath)).not.toBe(fs.realpathSync(debugPath));
  });

  it('uses the bundled SayGM agent in packaged builds', () => {
    const tempDir = makeTempDir();
    const resourcesPath = path.join(tempDir, 'resources');
    const bundledPath = makeFile(path.join(resourcesPath, 'bin', packagedBinaryName));

    expect(findGooseBinaryPath({ isPackaged: true, resourcesPath })).toBe(bundledPath);
  });

  it('does not fall back to a Goose-named executable in packaged builds', () => {
    const tempDir = makeTempDir();
    const resourcesPath = path.join(tempDir, 'resources');
    makeFile(path.join(resourcesPath, 'bin', binaryName));

    expect(() => findGooseBinaryPath({ isPackaged: true, resourcesPath })).toThrow(
      'SayGM backend binary not found'
    );
  });
});

describe('buildLocalServeUrls', () => {
  it('builds HTTP and WS URLs', () => {
    expect(buildLocalServeUrls(1234, 'secret', 'http')).toEqual({
      httpBaseUrl: 'http://127.0.0.1:1234',
      statusUrl: 'http://127.0.0.1:1234/status',
      healthUrl: 'http://127.0.0.1:1234/health',
      acpUrl: 'ws://127.0.0.1:1234/acp?token=secret',
      redactedAcpUrl: 'ws://127.0.0.1:1234/acp?token=REDACTED',
    });
  });

  it('builds HTTPS and WSS URLs', () => {
    expect(buildLocalServeUrls(1234, 'secret', 'https')).toEqual({
      httpBaseUrl: 'https://127.0.0.1:1234',
      statusUrl: 'https://127.0.0.1:1234/status',
      healthUrl: 'https://127.0.0.1:1234/health',
      acpUrl: 'wss://127.0.0.1:1234/acp?token=secret',
      redactedAcpUrl: 'wss://127.0.0.1:1234/acp?token=REDACTED',
    });
  });
});

describe('startGooseServe', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    process.chdir(originalCwd);

    while (tempDirs.length > 0) {
      const tempDir = tempDirs.pop();
      if (tempDir) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }
  });

  it('fails before spawn when the managed-key broker is required but missing', async () => {
    await expect(
      startGooseServe({ serverSecret: 'test-secret', managedModelKeyBrokerRequired: true })
    ).rejects.toThrow('private SayGM model-key channel is required');
  });

  it.skipIf(process.platform === 'win32')('uses the injected readiness probe', async () => {
    const tempDir = makeTempDir();
    const goosePath = makeExecutable(
      path.join(tempDir, 'goose'),
      '#!/usr/bin/env sh\nwhile true; do sleep 1; done\n'
    );
    vi.stubEnv('GOOSE_BINARY', goosePath);

    const readinessUrls: string[] = [];
    const readinessProbe = vi.fn(async (input: string) => {
      readinessUrls.push(input);
      return { ok: true, statusCode: 200 };
    });

    const result = await startGooseServe({
      serverSecret: 'test-secret',
      dir: tempDir,
      readinessProbe,
    });

    try {
      expect(readinessProbe).toHaveBeenCalledTimes(1);
      expect(readinessUrls[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/status$/);
    } finally {
      await result.cleanup();
    }
  });

  it.skipIf(process.platform === 'win32')('captures the TLS fingerprint from stdout', async () => {
    const tempDir = makeTempDir();
    const goosePath = makeExecutable(
      path.join(tempDir, 'goose'),
      [
        '#!/usr/bin/env sh',
        'printf "GOOSED_CERT_FINGERPRINT=AA:BB:CC\\n"',
        'while true; do sleep 1; done',
        '',
      ].join('\n')
    );
    vi.stubEnv('GOOSE_BINARY', goosePath);

    let fingerprintLogged!: () => void;
    const fingerprintSeen = new Promise<void>((resolve) => {
      fingerprintLogged = resolve;
    });
    const logger = {
      info: vi.fn((message: unknown) => {
        if (String(message).includes('Pinned cert fingerprint')) {
          fingerprintLogged();
        }
      }),
      error: vi.fn(),
    };
    const readinessProbe = vi.fn(async (_url: string, _signal: AbortSignal, fingerprint: string | null) => {
      await fingerprintSeen;
      expect(fingerprint).toBe('AA:BB:CC');
      return { ok: true, statusCode: 200 };
    });

    const result = await startGooseServe({
      serverSecret: 'test-secret',
      dir: tempDir,
      tls: true,
      logger,
      readinessProbe,
    });

    try {
      expect(result.certFingerprint).toBe('AA:BB:CC');
    } finally {
      await result.cleanup();
    }
  });

  it.skipIf(process.platform === 'win32')('uses TLS URLs and args when TLS is enabled', async () => {
    const tempDir = makeTempDir();
    const argsPath = path.join(tempDir, 'args.txt');
    const goosePath = makeExecutable(
      path.join(tempDir, 'goose'),
      [
        '#!/usr/bin/env sh',
        'printf "%s\\n" "$@" > "$TEST_ARGS_PATH"',
        'printf "GOOSED_CERT_FINGERPRINT=DD:EE:FF\\n"',
        'while true; do sleep 1; done',
        '',
      ].join('\n')
    );
    vi.stubEnv('GOOSE_BINARY', goosePath);

    const readinessUrls: string[] = [];
    const logger = {
      info: vi.fn(),
      error: vi.fn(),
    };
    const readinessProbe = vi.fn(async (input: string) => {
      readinessUrls.push(input);
      return { ok: true, statusCode: 200 };
    });

    const result = await startGooseServe({
      serverSecret: 'test-secret',
      dir: tempDir,
      tls: true,
      env: {
        TEST_ARGS_PATH: argsPath,
      },
      logger,
      readinessProbe,
    });

    try {
      expect(readinessUrls[0]).toMatch(/^https:\/\/127\.0\.0\.1:\d+\/status$/);
      expect(result.acpUrl).toMatch(/^wss:\/\/127\.0\.0\.1:\d+\/acp\?token=test-secret$/);
      expect(result.certFingerprint).toBe('DD:EE:FF');
      const args = await waitForFileLines(argsPath);
      expect(args).toContain('--tls');
      expect(args).toContain('--enable-scheduler');
    } finally {
      await result.cleanup();
    }
  });

  it.skipIf(process.platform === 'win32')('waits for TLS fingerprint before readiness succeeds', async () => {
    const tempDir = makeTempDir();
    const goosePath = makeExecutable(
      path.join(tempDir, 'goose'),
      [
        '#!/usr/bin/env sh',
        'sleep 0.1',
        'printf "GOOSED_CERT_FINGERPRINT=11:22:33\\n"',
        'while true; do sleep 1; done',
        '',
      ].join('\n')
    );
    vi.stubEnv('GOOSE_BINARY', goosePath);

    const readinessProbe = vi.fn(async () => ({ ok: true, statusCode: 200 }));

    const result = await startGooseServe({
      serverSecret: 'test-secret',
      dir: tempDir,
      tls: true,
      readinessProbe,
    });

    try {
      expect(readinessProbe).toHaveBeenCalled();
      expect(result.certFingerprint).toBe('11:22:33');
    } finally {
      await result.cleanup();
    }
  });
});

describe('waitForGooseServeReady', () => {
  it('rejects a successful probe if the child exits while the request is pending', async () => {
    let childUnavailable = false;
    const events: Array<{ name: string; details?: Record<string, unknown> }> = [];
    const readinessProbe = vi.fn(async () => {
      childUnavailable = true;
      return { ok: true, statusCode: 200 };
    });

    await expect(
      waitForGooseServeReady(
        'https://127.0.0.1:1234/status',
        [],
        () => childUnavailable,
        {
          healthUrl: 'https://127.0.0.1:1234/health',
          readinessProbe,
          expectedFingerprint: 'AA:BB:CC',
          timeoutMs: 20,
          intervalMs: 1,
          attemptTimeoutMs: 5,
          onEvent: (name, details) => events.push({ name, details }),
        }
      )
    ).resolves.toBe(false);

    expect(events.map((event) => event.name)).toContain('healthcheck_fatal_error');
    expect(events.map((event) => event.name)).not.toContain('healthcheck_success');
  });

  it('records only the final safe error code and attempt count on timeout', async () => {
    const events: Array<{ name: string; details?: Record<string, unknown> }> = [];
    const readinessProbe = vi.fn(async () => ({ ok: false, errorCode: 'ECONNREFUSED' }));

    await expect(
      waitForGooseServeReady(
        'https://127.0.0.1:1234/status',
        [],
        () => false,
        {
          healthUrl: 'https://127.0.0.1:1234/health',
          readinessProbe,
          expectedFingerprint: 'AA:BB:CC',
          timeoutMs: 20,
          intervalMs: 1,
          attemptTimeoutMs: 5,
          onEvent: (name, details) => events.push({ name, details }),
        }
      )
    ).resolves.toBe(false);

    const timeout = events.find((event) => event.name === 'healthcheck_timeout');
    expect(timeout?.details).toMatchObject({
      attempts: expect.any(Number),
      lastErrorCode: 'ECONNREFUSED',
    });
    expect(timeout?.details?.attempts).toBeGreaterThan(1);
    expect(JSON.stringify(timeout)).not.toContain('test-secret');
  });

  it('aborts a stuck probe at the lesser per-attempt or total deadline', async () => {
    const events: Array<{ name: string; details?: Record<string, unknown> }> = [];
    const readinessProbe = vi.fn(
      (_url: string, signal: AbortSignal) =>
        new Promise<{ ok: false; errorCode: string }>((resolve) => {
          signal.addEventListener(
            'abort',
            () => resolve({ ok: false, errorCode: 'ABORT_ERR' }),
            { once: true }
          );
        })
    );

    await expect(
      waitForGooseServeReady(
        'https://127.0.0.1:1234/status',
        [],
        () => false,
        {
          healthUrl: 'https://127.0.0.1:1234/health',
          readinessProbe,
          expectedFingerprint: 'AA:BB:CC',
          timeoutMs: 20,
          intervalMs: 1,
          attemptTimeoutMs: 5,
          onEvent: (name, details) => events.push({ name, details }),
        }
      )
    ).resolves.toBe(false);

    expect(events.find((event) => event.name === 'healthcheck_timeout')?.details).toMatchObject({
      attempts: expect.any(Number),
      lastErrorCode: 'ABORT_ERR',
    });
    expect(readinessProbe).toHaveBeenCalled();
  });
});
