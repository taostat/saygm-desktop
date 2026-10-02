import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

type FetchRequestInput = Parameters<typeof globalThis.fetch>[0];
type FetchRequestInit = NonNullable<Parameters<typeof globalThis.fetch>[1]>;

const electronState = vi.hoisted(() => ({
  userDataDirectory: '',
  secureStorageAvailable: true,
  throwOnStorageCheck: false,
  throwOnDecrypt: false,
  throwOnEncrypt: false,
  secureStorageChecks: 0,
  decryptCalls: 0,
  encryptCalls: 0,
}));

vi.mock('electron', () => ({
  app: {
    getName: () => 'SayGM Test',
    getPath: () => electronState.userDataDirectory,
  },
  safeStorage: {
    isEncryptionAvailable: () => {
      electronState.secureStorageChecks += 1;
      if (electronState.throwOnStorageCheck) throw new Error('secure storage probe failed');
      return electronState.secureStorageAvailable;
    },
    getSelectedStorageBackend: () => 'OSCrypt',
    encryptString: (value: string) => {
      electronState.encryptCalls += 1;
      if (electronState.throwOnEncrypt) throw new Error('secure storage encrypt failed');
      return Buffer.from(value, 'utf8');
    },
    decryptString: (value: Uint8Array) => {
      electronState.decryptCalls += 1;
      if (electronState.throwOnDecrypt) throw new Error('secure storage decrypt failed');
      return Buffer.from(value).toString('utf8');
    },
  },
}));

import { GmAccountService, type GmAcpTarget, type GmProviderBridge } from './gmAccountService';

const accountBase = 'https://account.saygm.com/v1';
const gatewayBase = 'https://api.saygm.com/v1';
const targetA: GmAcpTarget = { url: 'wss://127.0.0.1:9001/acp', certificateFingerprint: 'AA' };
const targetB: GmAcpTarget = { url: 'wss://127.0.0.1:9002/acp', certificateFingerprint: 'BB' };

let fetchMock: ReturnType<typeof vi.fn>;
let userDataDirectory: string;

beforeEach(async () => {
  userDataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'saygm-account-test-'));
  electronState.userDataDirectory = userDataDirectory;
  electronState.secureStorageAvailable = true;
  electronState.throwOnStorageCheck = false;
  electronState.throwOnDecrypt = false;
  electronState.throwOnEncrypt = false;
  electronState.secureStorageChecks = 0;
  electronState.decryptCalls = 0;
  electronState.encryptCalls = 0;
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-01T12:00:00Z'));
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await fs.rm(userDataDirectory, { recursive: true, force: true });
});

describe('GmAccountService lifecycle', () => {
  it('coalesces background status reads and latches a failed secure-storage probe', async () => {
    electronState.secureStorageAvailable = false;
    const service = new GmAccountService(providerBridge());

    const concurrentStatus = await Promise.all(
      Array.from({ length: 8 }, () => service.getStatus())
    );
    expect(concurrentStatus).toHaveLength(8);
    expect(concurrentStatus.every((status) => !status.secureStorageAvailable)).toBe(true);
    expect(electronState.secureStorageChecks).toBe(1);

    const cleanupRetries = await Promise.all(
      Array.from({ length: 8 }, () => service.retryPendingCleanup([]))
    );
    expect(cleanupRetries.every((changed) => changed === false)).toBe(true);
    await Promise.all(Array.from({ length: 8 }, () => service.getStatus()));
    expect(electronState.secureStorageChecks).toBe(1);
    expect(electronState.decryptCalls).toBe(0);
  });

  it('shares an in-flight successful status decrypt across concurrent callers', async () => {
    const credentials = {
      version: 1,
      mode: 'api_key',
      key: 'gm_test_key',
      keyPrefix: 'gm_test_',
      providerConfigured: true,
    };
    await fs.writeFile(
      path.join(userDataDirectory, 'saygm-account.safe'),
      Buffer.from(JSON.stringify(credentials)).toString('base64'),
      'utf8'
    );
    await fs.writeFile(
      path.join(userDataDirectory, 'saygm-account-cleanup.safe'),
      Buffer.from(JSON.stringify({ version: 1, cleanups: [] })).toString('base64'),
      'utf8'
    );
    const service = new GmAccountService(providerBridge());

    const statuses = await Promise.all(Array.from({ length: 8 }, () => service.getStatus()));
    expect(statuses.every((status) => status.connected && status.secureStorageAvailable)).toBe(
      true
    );
    expect(electronState.secureStorageChecks).toBe(1);
    expect(electronState.decryptCalls).toBe(2);
  });

  it('latches a throwing background storage probe without repeating the OS access', async () => {
    electronState.throwOnStorageCheck = true;
    const service = new GmAccountService(providerBridge());
    await expect(service.getStatus()).resolves.toMatchObject({ secureStorageAvailable: false });
    await Promise.all(Array.from({ length: 8 }, () => service.getStatus()));
    await service.retryPendingCleanup([]);
    expect(electronState.secureStorageChecks).toBe(1);
    expect(electronState.decryptCalls).toBe(0);
  });

  it('does not reprobe unavailable storage during automatic balance refreshes', async () => {
    electronState.secureStorageAvailable = false;
    const service = new GmAccountService(providerBridge());

    const results = await Promise.allSettled(Array.from({ length: 8 }, () => service.getBalance()));

    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    expect(electronState.secureStorageChecks).toBe(1);
    expect(electronState.decryptCalls).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not retry failed credential decrypts during automatic balance refreshes', async () => {
    electronState.throwOnDecrypt = true;
    await fs.writeFile(
      path.join(userDataDirectory, 'saygm-account.safe'),
      Buffer.from(
        JSON.stringify({
          version: 1,
          mode: 'api_key',
          key: 'synthetic-private-key',
          keyPrefix: 'synthetic',
          providerConfigured: true,
        })
      ).toString('base64'),
      'utf8'
    );
    const service = new GmAccountService(providerBridge());

    const results = await Promise.allSettled(Array.from({ length: 8 }, () => service.getBalance()));

    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    expect(electronState.secureStorageChecks).toBe(1);
    expect(electronState.decryptCalls).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
    for (const result of results) {
      if (result.status === 'rejected') {
        expect(String(result.reason)).not.toContain('synthetic-private-key');
      }
    }
  });

  it('latches a failed encrypted token rotation through automatic balance refreshes', async () => {
    await fs.writeFile(
      path.join(userDataDirectory, 'saygm-account.safe'),
      Buffer.from(
        JSON.stringify({
          version: 1,
          mode: 'session',
          sessionId: 'session-1',
          email: 'test@saygm.com',
          accessToken: 'access-0',
          refreshToken: 'refresh-0',
          providerConfigured: true,
        })
      ).toString('base64'),
      'utf8'
    );
    electronState.throwOnEncrypt = true;
    fetchMock.mockImplementation(async (input: FetchRequestInput) => {
      if (String(input) === `${accountBase}/balance`) {
        return jsonResponse(401, { error: 'expired_token' });
      }
      if (String(input) === `${accountBase}/oauth/token`) {
        return jsonResponse(200, tokens('access-1', 'refresh-1'));
      }
      throw new Error(`Unexpected test request: ${String(input)}`);
    });
    const service = new GmAccountService(providerBridge());

    await expect(service.getBalance()).rejects.toThrow('could not secure saved account data');
    const retryResults = await Promise.allSettled(
      Array.from({ length: 8 }, () => service.getBalance())
    );

    expect(retryResults.every((result) => result.status === 'rejected')).toBe(true);
    expect(electronState.secureStorageChecks).toBe(1);
    expect(electronState.decryptCalls).toBe(1);
    expect(electronState.encryptCalls).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const result of retryResults) {
      if (result.status === 'rejected') {
        expect(String(result.reason)).not.toContain('refresh-1');
      }
    }
  });

  it('latches a failed credentials decrypt instead of repeating the keychain read', async () => {
    electronState.throwOnDecrypt = true;
    await fs.writeFile(
      path.join(userDataDirectory, 'saygm-account.safe'),
      Buffer.from('encrypted').toString('base64'),
      'utf8'
    );
    const service = new GmAccountService(providerBridge());

    await expect(service.getStatus()).rejects.toThrow(
      'Saved SayGM account data could not be unlocked.'
    );
    await expect(service.getStatus()).resolves.toMatchObject({ secureStorageAvailable: false });
    await expect(service.getStatus()).resolves.toMatchObject({ secureStorageAvailable: false });
    expect(electronState.secureStorageChecks).toBe(1);
    expect(electronState.decryptCalls).toBe(1);
  });

  it('does not repeatedly decrypt an unreadable pending-cleanup file', async () => {
    await fs.writeFile(
      path.join(userDataDirectory, 'saygm-account-cleanup.safe'),
      Buffer.from('not-json').toString('base64'),
      'utf8'
    );
    const service = new GmAccountService(providerBridge());

    await expect(service.retryPendingCleanup([])).rejects.toThrow(
      'Saved SayGM cleanup data could not be unlocked.'
    );
    await expect(service.retryPendingCleanup([])).resolves.toBe(false);
    expect(electronState.secureStorageChecks).toBe(1);
    expect(electronState.decryptCalls).toBe(1);
  });

  it('backs off pending cleanup after a remote failure instead of retrying on each status call', async () => {
    const cleanup = {
      sessionId: 'session-cleanup',
      accessToken: 'access-cleanup',
      refreshToken: 'refresh-cleanup',
      revokeSession: true,
      sessionRevoked: false,
      managedKeyRevoked: true,
      providerKeyCleared: true,
      state: 'cleanup',
    };
    await fs.writeFile(
      path.join(userDataDirectory, 'saygm-account-cleanup.safe'),
      Buffer.from(JSON.stringify({ version: 1, cleanups: [cleanup] })).toString('base64'),
      'utf8'
    );
    fetchMock.mockResolvedValue(jsonResponse(500, { error: 'server_error' }));
    const service = new GmAccountService(providerBridge());

    await expect(service.retryPendingCleanup([])).resolves.toBe(false);
    await expect(service.retryPendingCleanup([])).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(electronState.decryptCalls).toBe(1);
  });

  it('shows a safe actionable ACP keyring category without exposing error data', async () => {
    const safeMessage =
      'SayGM could not access saved secrets in the system credential store. Check keyring access settings, then retry model setup.';
    fetchMock.mockResolvedValue(
      jsonResponse(200, { balance: { usd: '8.00', nano_usd: 8_000_000 } })
    );
    const provider = providerBridge({
      saveApiKey: vi.fn(async () => {
        throw Object.assign(new Error(safeMessage), {
          code: -32603,
          data: { code: 'secure_storage_access_denied', diagnostic: 'synthetic-private-value' },
        });
      }),
    });
    const service = new GmAccountService(provider);

    const error = await service.connectApiKey('gm_test_key', [targetA]).catch((caught) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(safeMessage);
    expect((error as Error).message).not.toContain('synthetic-private-value');
    expect(provider.clearApiKeyIfMatches).toHaveBeenCalledOnce();
  });

  it('persists rotated refresh credentials when the retried key creation fails', async () => {
    const refreshTokens: string[] = [];
    let rotationCount = 0;
    fetchMock.mockImplementation(async (input: FetchRequestInput, init?: FetchRequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === `${accountBase}/oauth/device_authorization`) {
        return jsonResponse(200, deviceAuthorization());
      }
      if (url === `${accountBase}/oauth/token`) {
        const values = new URLSearchParams(String(init?.body ?? ''));
        if (values.get('grant_type') === 'urn:ietf:params:oauth:grant-type:device_code') {
          return jsonResponse(200, tokens('access-0', 'refresh-0'));
        }
        refreshTokens.push(values.get('refresh_token') ?? '');
        rotationCount += 1;
        return jsonResponse(200, tokens(`access-${rotationCount}`, `refresh-${rotationCount}`));
      }
      if (url === `${accountBase}/me`) return jsonResponse(200, { email: 'test@saygm.com' });
      if (url === `${accountBase}/keys` && method === 'POST') {
        if (
          init?.headers &&
          new globalThis.Headers(init.headers).get('authorization') === 'Bearer access-0'
        ) {
          return jsonResponse(401, { error: 'expired_token' });
        }
        return jsonResponse(500, { error: 'server_error' });
      }
      if (url === `${accountBase}/balance`) {
        const authorization = new globalThis.Headers(init?.headers).get('authorization');
        if (authorization === 'Bearer access-2')
          return jsonResponse(200, { balance: { usd: '12.50' } });
        return jsonResponse(401, { error: 'expired_token' });
      }
      throw new Error(`Unexpected test request: ${method} ${url}`);
    });

    const service = new GmAccountService(providerBridge());
    await startDeviceFlow(service, 11);
    await expect(service.pollDeviceLogin(11, [targetA])).rejects.toThrow(
      'SayGM Desktop could not finish model setup'
    );

    await expect(service.getBalance()).resolves.toMatchObject({ kind: 'account', usd: '12.50' });
    expect(refreshTokens).toEqual(['refresh-0', 'refresh-1']);
  });

  it('waits for every backend key save before rolling back a partial key-only connection', async () => {
    let finishSecondSave!: () => void;
    const secondSave = new Promise<void>((resolve) => {
      finishSecondSave = resolve;
    });
    const provider = providerBridge({
      saveApiKey: vi.fn(async (target) => {
        if (target.url === targetA.url) throw new Error('first backend failed');
        await secondSave;
      }),
    });
    fetchMock.mockImplementation(async (input: FetchRequestInput) => {
      if (String(input) === `${gatewayBase}/credits`) {
        return jsonResponse(200, { balance: { usd: '8.00', nano_usd: 8_000_000 } });
      }
      throw new Error(`Unexpected test request: ${String(input)}`);
    });

    const service = new GmAccountService(provider);
    const connecting = service.connectApiKey('gm_test_key', [targetA, targetB]);
    const connectionFailure = expect(connecting).rejects.toThrow(
      'SayGM Desktop could not securely store the API key'
    );
    await vi.waitFor(() => expect(provider.saveApiKey).toHaveBeenCalledTimes(2));
    await Promise.resolve();
    expect(provider.clearApiKeyIfMatches).not.toHaveBeenCalled();

    finishSecondSave();
    await connectionFailure;
    expect(provider.clearApiKeyIfMatches).toHaveBeenCalledTimes(2);
    await expect(service.getStatus()).resolves.toMatchObject({ connected: false });
  });

  it('keeps the session connected if remote key revocation and local key clearing both fail', async () => {
    fetchMock.mockImplementation(async (input: FetchRequestInput, init?: FetchRequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === `${accountBase}/oauth/device_authorization`) {
        return jsonResponse(200, deviceAuthorization());
      }
      if (url === `${accountBase}/oauth/token`) {
        return jsonResponse(200, tokens('access-0', 'refresh-0'));
      }
      if (url === `${accountBase}/me`) return jsonResponse(200, { email: 'test@saygm.com' });
      if (url === `${accountBase}/keys` && method === 'POST') {
        return jsonResponse(201, { id: 'managed-1', secret: 'gm_managed_secret' });
      }
      if (url === `${accountBase}/keys/managed-1` && method === 'DELETE') {
        return jsonResponse(500, { error: 'server_error' });
      }
      if (url === `${accountBase}/oauth/revoke`) {
        throw new Error('Session revocation must not happen while the model key remains active.');
      }
      throw new Error(`Unexpected test request: ${method} ${url}`);
    });
    const provider = providerBridge({
      clearApiKeyIfMatches: vi.fn(async () => {
        throw new Error('secure store unavailable');
      }),
    });
    const service = new GmAccountService(provider);
    await startDeviceFlow(service, 12);
    await expect(service.pollDeviceLogin(12, [targetA])).resolves.toMatchObject({
      status: 'connected',
    });

    await expect(service.logout([targetA])).resolves.toMatchObject({
      warning: expect.stringContaining('connection remains active'),
    });
    await expect(service.getStatus()).resolves.toMatchObject({
      connected: true,
      mode: 'session',
      providerConfigured: true,
    });
    expect(provider.clearApiKeyIfMatches).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: 'falls back to the journal refresh token only after invalid_grant',
      liveRefreshAccepted: false,
      alreadyRevoked: true,
      expectedRefreshes: ['refresh-live', 'refresh-journal'],
      expectedDeleteCount: 0,
    },
    {
      name: 'uses a valid live refresh token even when its access token is still accepted',
      liveRefreshAccepted: true,
      alreadyRevoked: true,
      expectedRefreshes: ['refresh-live'],
      expectedDeleteCount: 0,
    },
    {
      name: 'reconciles tokens before retrying an outstanding remote key revocation',
      liveRefreshAccepted: false,
      alreadyRevoked: false,
      expectedRefreshes: ['refresh-live', 'refresh-journal'],
      expectedDeleteCount: 1,
    },
  ])('reconciles pending cleanup credentials: $name', async (scenario) => {
    await writeEncryptedFixture('saygm-account.safe', {
      version: 1,
      mode: 'session',
      sessionId: 'session-1',
      email: 'test@saygm.com',
      accessToken: 'access-live',
      refreshToken: 'refresh-live',
      providerConfigured: false,
    });
    await writeEncryptedFixture('saygm-account-cleanup.safe', {
      version: 1,
      cleanups: [
        {
          sessionId: 'session-1',
          accessToken: 'access-journal',
          refreshToken: 'refresh-journal',
          revokeSession: false,
          sessionRevoked: false,
          managedKeyRevoked: scenario.alreadyRevoked,
          providerKeyCleared: true,
          managedProviderKeyId: 'managed-old',
          managedProviderKeyHash: 'a'.repeat(64),
          state: 'cleanup',
        },
      ],
    });

    const refreshAttempts: string[] = [];
    const deleteAuthorizations: string[] = [];
    const createAuthorizations: string[] = [];
    fetchMock.mockImplementation(async (input: FetchRequestInput, init?: FetchRequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const headers = new globalThis.Headers(init?.headers);
      if (url === `${accountBase}/oauth/token`) {
        const refreshToken = new URLSearchParams(String(init?.body ?? '')).get('refresh_token');
        refreshAttempts.push(refreshToken ?? '');
        if (refreshToken === 'refresh-live' && !scenario.liveRefreshAccepted) {
          return jsonResponse(400, { error: { code: 'invalid_grant' } });
        }
        if (
          refreshToken === 'refresh-live' ||
          (refreshToken === 'refresh-journal' && !scenario.liveRefreshAccepted)
        ) {
          return jsonResponse(200, tokens('access-verified', 'refresh-verified'));
        }
        throw new Error('Unexpected cleanup refresh candidate.');
      }
      if (url === `${accountBase}/keys/managed-old` && method === 'DELETE') {
        deleteAuthorizations.push(headers.get('authorization') ?? '');
        return jsonResponse(204, null);
      }
      if (url === `${accountBase}/keys` && method === 'POST') {
        createAuthorizations.push(headers.get('authorization') ?? '');
        return jsonResponse(201, { id: 'managed-new', secret: 'gm_new_secret' });
      }
      throw new Error(`Unexpected test request: ${method} ${url}`);
    });

    const service = new GmAccountService(providerBridge());
    await expect(service.finishProviderSetup([targetA])).resolves.toMatchObject({
      providerConfigured: true,
    });

    expect(refreshAttempts).toEqual(scenario.expectedRefreshes);
    expect(deleteAuthorizations).toHaveLength(scenario.expectedDeleteCount);
    if (scenario.expectedDeleteCount > 0) {
      expect(deleteAuthorizations).toEqual(['Bearer access-verified']);
    }
    expect(createAuthorizations).toEqual(['Bearer access-verified']);
    expect(fetchMock.mock.calls.some(([input]) => String(input) === `${accountBase}/me`)).toBe(
      false
    );

    const saved = JSON.parse(
      Buffer.from(
        await fs.readFile(path.join(userDataDirectory, 'saygm-account.safe'), 'utf8'),
        'base64'
      ).toString('utf8')
    ) as Record<string, unknown>;
    expect(saved).toMatchObject({
      email: 'test@saygm.com',
      accessToken: 'access-verified',
      refreshToken: 'refresh-verified',
      managedProviderKeyId: 'managed-new',
    });
  });

  it('clears a drained owned-key cleanup once before creating a replacement key', async () => {
    const oldHash = 'b'.repeat(64);
    await writeEncryptedFixture('saygm-account.safe', {
      version: 1,
      mode: 'session',
      sessionId: 'session-1',
      email: 'test@saygm.com',
      accessToken: 'access-current',
      refreshToken: 'refresh-current',
      providerConfigured: false,
      managedProviderKeyId: 'managed-old',
      managedProviderKeyHash: oldHash,
    });
    await writeEncryptedFixture('saygm-account-cleanup.safe', {
      version: 1,
      cleanups: [
        {
          sessionId: 'session-1',
          accessToken: 'access-current',
          refreshToken: 'refresh-current',
          revokeSession: false,
          sessionRevoked: false,
          managedKeyRevoked: true,
          providerKeyCleared: false,
          managedProviderKeyId: 'managed-old',
          managedProviderKeyHash: oldHash,
          state: 'cleanup',
        },
      ],
    });
    fetchMock.mockImplementation(async (input: FetchRequestInput, init?: FetchRequestInit) => {
      if (String(input) === `${accountBase}/keys` && init?.method === 'POST') {
        return jsonResponse(201, { id: 'managed-new', secret: 'gm_new_secret' });
      }
      throw new Error(`Unexpected test request: ${String(init?.method ?? 'GET')} ${String(input)}`);
    });
    const provider = providerBridge();

    await expect(
      new GmAccountService(provider).finishProviderSetup([targetA])
    ).resolves.toMatchObject({
      providerConfigured: true,
    });

    expect(provider.clearApiKeyIfMatches).toHaveBeenCalledOnce();
    expect(provider.clearApiKeyIfMatches).toHaveBeenCalledWith(targetA, oldHash);
    expect(
      fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/managed-old'))
    ).toHaveLength(0);
  });

  it('invalidates a late device authorization response after another window starts sign-in', async () => {
    let resolveFirst!: (response: Response) => void;
    const firstAuthorization = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    let authorizationCount = 0;
    fetchMock.mockImplementation(async (input: FetchRequestInput) => {
      if (String(input) !== `${accountBase}/oauth/device_authorization`) {
        throw new Error(`Unexpected test request: ${String(input)}`);
      }
      authorizationCount += 1;
      if (authorizationCount === 1) return firstAuthorization;
      return jsonResponse(200, deviceAuthorization('DEVICE-B', 'B2C4-D6E8'));
    });

    const service = new GmAccountService(providerBridge());
    const firstLogin = service.beginDeviceLogin(21);
    await vi.waitFor(() => expect(authorizationCount).toBe(1));
    await expect(service.beginDeviceLogin(22)).resolves.toMatchObject({ userCode: 'B2C4-D6E8' });
    resolveFirst(jsonResponse(200, deviceAuthorization('DEVICE-A', 'A1B2-C3D4')));
    await expect(firstLogin).rejects.toThrow('cancelled');
  });

  it('loads and saves scoped guardrails without sending a stale queued edit after logout', async () => {
    const initialBody = {
      'native:ban-substrings': {
        mode: 'redact',
        substrings: ['keep existing'],
        case_sensitive: false,
      },
      'native:future-scanner': { config: { retain: true } },
    };
    let currentBody: Record<string, unknown> | null = initialBody;
    let returnNullPutResponse = false;
    const putBodies: unknown[] = [];
    let releaseBalance!: (response: Response) => void;
    let balanceStarted!: () => void;
    const balanceStartedPromise = new Promise<void>((resolve) => {
      balanceStarted = resolve;
    });
    fetchMock.mockImplementation(async (input: FetchRequestInput, init?: FetchRequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === `${accountBase}/oauth/device_authorization`) {
        return jsonResponse(200, deviceAuthorization());
      }
      if (url === `${accountBase}/oauth/token`) {
        const values = new URLSearchParams(String(init?.body ?? ''));
        if (values.get('grant_type') === 'urn:ietf:params:oauth:grant-type:device_code') {
          return jsonResponse(200, tokens('access-0', 'refresh-0'));
        }
        return jsonResponse(200, tokens('access-0', 'refresh-0'));
      }
      if (url === `${accountBase}/me`) return jsonResponse(200, { email: 'test@saygm.com' });
      if (url === `${accountBase}/capabilities`) {
        return jsonResponse(200, capabilitiesFixture());
      }
      if (url === `${accountBase}/keys` && method === 'POST') {
        return jsonResponse(201, { id: 'managed-1', secret: 'gm_managed_secret' });
      }
      if (url === `${accountBase}/keys/managed-1/guardrails` && method === 'GET') {
        return jsonResponse(200, { body: currentBody });
      }
      if (url === `${accountBase}/keys/managed-1/guardrails` && method === 'PUT') {
        const payload = JSON.parse(String(init?.body ?? '{}')) as { body: unknown };
        putBodies.push(payload.body);
        currentBody = payload.body as Record<string, unknown>;
        if (returnNullPutResponse) return jsonResponse(200, { body: null });
        return jsonResponse(200, payload);
      }
      if (url === `${accountBase}/balance`) {
        balanceStarted();
        return new Promise<Response>((resolve) => {
          releaseBalance = resolve;
        });
      }
      if (url === `${accountBase}/keys/managed-1` && method === 'DELETE') {
        return jsonResponse(204, null);
      }
      if (url === `${accountBase}/oauth/revoke`) return jsonResponse(200, {});
      throw new Error(`Unexpected test request: ${method} ${url}`);
    });

    const service = new GmAccountService(providerBridge());
    const authorization = await service.beginDeviceLogin(31);
    expect(authorization.userCode).toBe('A1B2-C3D4');
    const deviceRequest = fetchMock.mock.calls.find(
      ([input]) => String(input) === `${accountBase}/oauth/device_authorization`
    );
    expect(new URLSearchParams(String(deviceRequest?.[1]?.body)).get('scope')).toBeNull();
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(service.pollDeviceLogin(31, [targetA])).resolves.toMatchObject({
      status: 'connected',
    });

    const loaded = await service.getGuardrails();
    expect(loaded.body).toEqual(initialBody);
    expect(loaded.context).toMatch(/^[a-f0-9]{64}$/);
    const replacementBody = {
      ...initialBody,
      'native:ban-substrings': {
        ...initialBody['native:ban-substrings'],
        mode: 'block',
        substrings: ['blocked term'],
      },
    };
    const saved = await service.saveGuardrails(replacementBody, loaded.context);
    expect(saved).toMatchObject({
      body: { 'native:future-scanner': { config: { retain: true } } },
    });
    expect(putBodies).toHaveLength(1);

    returnNullPutResponse = true;
    await expect(
      service.saveGuardrails(
        {
          ...replacementBody,
          'native:ban-substrings': {
            ...replacementBody['native:ban-substrings'],
            substrings: ['another term'],
          },
        },
        saved.context
      )
    ).rejects.toThrow('unexpected guardrail policy');
    returnNullPutResponse = false;
    expect(putBodies).toHaveLength(2);
    await expect(service.saveGuardrails(initialBody, loaded.context)).rejects.toThrow(
      'saved guardrails or SayGM account changed'
    );
    expect(putBodies).toHaveLength(2);

    const balance = service.getBalance();
    await balanceStartedPromise;
    const queuedSave = service.saveGuardrails(initialBody, loaded.context);
    const logout = service.logout([targetA]);
    releaseBalance(jsonResponse(200, { balance: { usd: '10.00' } }));

    await expect(balance).rejects.toThrow('cancelled');
    await expect(queuedSave).rejects.toThrow('cancelled');
    await expect(logout).resolves.toEqual({});
    expect(putBodies).toHaveLength(2);
  });

  it('requires browser-connected account credentials for managed guardrails', async () => {
    fetchMock.mockImplementation(async (input: FetchRequestInput) => {
      if (String(input) === `${gatewayBase}/credits`) {
        return jsonResponse(200, { balance: { usd: '8.00', nano_usd: 8_000_000 } });
      }
      throw new Error(`Unexpected test request: ${String(input)}`);
    });
    const service = new GmAccountService(providerBridge());
    await service.connectApiKey('gm_test_key', [targetA]);
    await expect(service.getGuardrails()).rejects.toThrow('browser sign-in');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('previews one current draft scanner through the account OAuth route without inference', async () => {
    const scannerBody = { 'native:pii': { mode: 'redact-restore' } };
    const previewPayloads: unknown[] = [];
    const previewRequests: FetchRequestInit[] = [];
    fetchMock.mockImplementation(async (input: FetchRequestInput, init?: FetchRequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === `${accountBase}/oauth/device_authorization`) {
        return jsonResponse(200, deviceAuthorization());
      }
      if (url === `${accountBase}/oauth/token`) {
        return jsonResponse(200, tokens('access-0', 'refresh-0'));
      }
      if (url === `${accountBase}/me`) {
        return jsonResponse(200, { user_id: 'user-1', email: 'test@saygm.com' });
      }
      if (url === `${accountBase}/capabilities`) {
        return jsonResponse(200, capabilitiesFixture());
      }
      if (url === `${accountBase}/keys` && method === 'POST') {
        return jsonResponse(201, { id: 'managed-1', secret: 'gm_managed_secret' });
      }
      if (url === `${accountBase}/keys/managed-1/guardrails` && method === 'GET') {
        return jsonResponse(200, { body: null });
      }
      if (url === `${accountBase}/keys/managed-1/guardrails/preview` && method === 'POST') {
        previewPayloads.push(JSON.parse(String(init?.body ?? '{}')));
        previewRequests.push(init ?? {});
        return jsonResponse(200, {
          blocked: false,
          blocked_by: null,
          forwarded_text: 'Email [REDACTED_EMAIL_1_ab12cd34].',
          returned_text: 'Email alex@example.com.',
          per_scanner: {
            'native:pii': {
              detections: 1,
              redacted: 1,
              restored: 1,
              blocked: 0,
              by_entity_type: { EMAIL: 1 },
            },
          },
          by_entity_type: { EMAIL: 1 },
          not_run: [],
        });
      }
      throw new Error(`Unexpected test request: ${method} ${url}`);
    });

    const service = new GmAccountService(providerBridge());
    await startDeviceFlow(service, 41);
    await expect(service.pollDeviceLogin(41, [targetA])).resolves.toMatchObject({
      status: 'connected',
    });
    await expect(service.getStatus()).resolves.toMatchObject({
      connected: true,
      managedKeyAvailable: true,
    });
    const snapshot = await service.getGuardrails();
    await expect(
      service.previewGuardrails(
        'native:pii',
        scannerBody,
        'Email alex@example.com.',
        'b'.repeat(64)
      )
    ).rejects.toThrow('saved guardrails or SayGM account changed');
    expect(previewRequests).toHaveLength(0);

    const preview = await service.previewGuardrails(
      'native:pii',
      scannerBody,
      'Email alex@example.com.',
      snapshot.context
    );

    expect(preview.per_scanner['native:pii']?.restored).toBe(1);
    expect(previewPayloads).toEqual([{ scanners: scannerBody, text: 'Email alex@example.com.' }]);
    expect(previewRequests[0]?.redirect).toBe('error');
    expect(previewRequests[0]?.cache).toBe('no-store');
    expect(new globalThis.Headers(previewRequests[0]?.headers).get('authorization')).toBe(
      'Bearer access-0'
    );
    expect(
      fetchMock.mock.calls.some(([input]) => String(input) === `${gatewayBase}/chat/completions`)
    ).toBe(false);

    await expect(
      service.previewGuardrails('native:pii', scannerBody, '😀'.repeat(32_769), snapshot.context)
    ).rejects.toThrow('128 KiB');
    expect(previewRequests).toHaveLength(1);

    const credentialsPath = path.join(userDataDirectory, 'saygm-account.safe');
    const encrypted = await fs.readFile(credentialsPath, 'utf8');
    const stored = JSON.parse(Buffer.from(encrypted, 'base64').toString('utf8')) as Record<
      string,
      unknown
    >;
    delete stored.managedProviderKey;
    await fs.writeFile(credentialsPath, Buffer.from(JSON.stringify(stored)).toString('base64'));
    await expect(service.getStatus()).resolves.toMatchObject({ managedKeyAvailable: true });
    const secondSnapshot = await service.getGuardrails();
    await expect(
      service.previewGuardrails(
        'native:pii',
        scannerBody,
        'Email alex@example.com.',
        secondSnapshot.context
      )
    ).resolves.toMatchObject({ blocked: false });
    expect(previewRequests).toHaveLength(2);
    expect(
      fetchMock.mock.calls.some(([input]) => String(input) === `${gatewayBase}/guard/preview`)
    ).toBe(false);
  });

  it('allows existing OAuth account sessions to use available customer guardrail routes', async () => {
    const provider = providerBridge();
    fetchMock.mockImplementation(async (input: FetchRequestInput, init?: FetchRequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === `${accountBase}/oauth/device_authorization`)
        return jsonResponse(200, deviceAuthorization());
      if (url === `${accountBase}/oauth/token`)
        return jsonResponse(200, tokens('access-0', 'refresh-0'));
      if (url === `${accountBase}/me`) {
        return jsonResponse(200, { user_id: 'user-1', email: 'test@saygm.com' });
      }
      if (url === `${accountBase}/keys` && method === 'POST') {
        return jsonResponse(201, { id: 'managed-1', secret: 'gm_managed_secret' });
      }
      if (url === `${accountBase}/capabilities`) return jsonResponse(200, capabilitiesFixture());
      if (url === `${accountBase}/keys/managed-1/guardrails` && method === 'GET') {
        return jsonResponse(200, { body: null });
      }
      throw new Error(`Unexpected test request: ${method} ${url}`);
    });
    const service = new GmAccountService(provider);
    await service.beginDeviceLogin(33);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(service.pollDeviceLogin(33, [targetA])).resolves.toMatchObject({
      status: 'connected',
    });

    const credentialsPath = path.join(userDataDirectory, 'saygm-account.safe');
    const before = JSON.parse(
      Buffer.from(await fs.readFile(credentialsPath, 'utf8'), 'base64').toString('utf8')
    ) as Record<string, unknown>;
    await expect(service.getGuardrails()).resolves.toMatchObject({ body: null });
    await expect(service.getStatus()).resolves.toMatchObject({
      connected: true,
      mode: 'session',
      email: 'test@saygm.com',
      managedKeyAvailable: true,
    });
    const after = JSON.parse(
      Buffer.from(await fs.readFile(credentialsPath, 'utf8'), 'base64').toString('utf8')
    ) as Record<string, unknown>;
    expect(after).toMatchObject({
      sessionId: before.sessionId,
      managedProviderKeyId: before.managedProviderKeyId,
      managedProviderKeyHash: before.managedProviderKeyHash,
      managedProviderKey: before.managedProviderKey,
      providerConfigured: true,
    });
    expect(after.grantedScopes).toBeUndefined();
    expect(provider.clearApiKeyIfMatches).not.toHaveBeenCalled();
    expect(
      fetchMock.mock.calls.some(
        ([input, request]) =>
          String(input) === `${accountBase}/keys/managed-1` && request?.method === 'DELETE'
      )
    ).toBe(false);
    expect(
      fetchMock.mock.calls.some(
        ([input]) => String(input) === `${accountBase}/keys/managed-1/guardrails`
      )
    ).toBe(true);
  });

  it.each([404, 503])(
    'uses persisted rotated credentials after capability discovery returns HTTP %i',
    async (capabilityStatus) => {
      await writeEncryptedFixture('saygm-account.safe', {
        version: 1,
        mode: 'session',
        sessionId: 'session-1',
        email: 'test@saygm.com',
        accessToken: 'access-0',
        refreshToken: 'refresh-0',
        providerConfigured: true,
        managedProviderKeyId: 'managed-1',
        managedProviderKeyHash: 'a'.repeat(64),
      });

      let rotationCount = 0;
      const capabilityAuthorizations: string[] = [];
      const guardrailAuthorizations: string[] = [];
      fetchMock.mockImplementation(async (input: FetchRequestInput, init?: FetchRequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        const authorization = new globalThis.Headers(init?.headers).get('authorization');
        if (url === `${accountBase}/capabilities`) {
          capabilityAuthorizations.push(authorization ?? '');
          return authorization === 'Bearer access-0'
            ? jsonResponse(401, { error: 'expired_token' })
            : jsonResponse(capabilityStatus, {});
        }
        if (url === `${accountBase}/oauth/token`) {
          const refreshToken = new URLSearchParams(String(init?.body ?? '')).get('refresh_token');
          expect(refreshToken).toBe(rotationCount === 0 ? 'refresh-0' : 'unexpected-refresh');
          rotationCount += 1;
          return jsonResponse(200, tokens('access-1', 'refresh-1'));
        }
        if (url === `${accountBase}/keys/managed-1/guardrails` && method === 'GET') {
          guardrailAuthorizations.push(authorization ?? '');
          return jsonResponse(200, { body: null });
        }
        throw new Error(`Unexpected test request: ${method} ${url}`);
      });

      const service = new GmAccountService(providerBridge());
      await expect(service.getGuardrails()).resolves.toMatchObject({ body: null });
      expect(capabilityAuthorizations).toEqual(['Bearer access-0', 'Bearer access-1']);
      expect(guardrailAuthorizations).toEqual(['Bearer access-1']);
      expect(rotationCount).toBe(1);
      const stored = JSON.parse(
        Buffer.from(
          await fs.readFile(path.join(userDataDirectory, 'saygm-account.safe'), 'utf8'),
          'base64'
        ).toString('utf8')
      ) as Record<string, unknown>;
      expect(stored).toMatchObject({ accessToken: 'access-1', refreshToken: 'refresh-1' });
    }
  );

  it('refreshes and retries OAuth guardrail preview with its dedicated request options', async () => {
    await writeEncryptedFixture('saygm-account.safe', {
      version: 1,
      mode: 'session',
      sessionId: 'session-1',
      email: 'test@saygm.com',
      accessToken: 'access-0',
      refreshToken: 'refresh-0',
      providerConfigured: true,
      managedProviderKeyId: 'managed-1',
      managedProviderKeyHash: 'a'.repeat(64),
    });

    const scannerBody = { 'native:pii': { mode: 'redact' } };
    const previewPayloads: unknown[] = [];
    const previewRequests: FetchRequestInit[] = [];
    let refreshCount = 0;
    fetchMock.mockImplementation(async (input: FetchRequestInput, init?: FetchRequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const authorization = new globalThis.Headers(init?.headers).get('authorization');
      if (url === `${accountBase}/capabilities`) return jsonResponse(200, capabilitiesFixture());
      if (url === `${accountBase}/keys/managed-1/guardrails` && method === 'GET') {
        return jsonResponse(200, { body: null });
      }
      if (url === `${accountBase}/oauth/token`) {
        expect(new URLSearchParams(String(init?.body ?? '')).get('refresh_token')).toBe(
          'refresh-0'
        );
        refreshCount += 1;
        return jsonResponse(200, tokens('access-1', 'refresh-1'));
      }
      if (url === `${accountBase}/keys/managed-1/guardrails/preview` && method === 'POST') {
        previewPayloads.push(JSON.parse(String(init?.body ?? '{}')));
        previewRequests.push(init ?? {});
        if (authorization === 'Bearer access-0')
          return jsonResponse(401, { error: 'expired_token' });
        return jsonResponse(200, {
          blocked: false,
          blocked_by: null,
          forwarded_text: 'sample',
          returned_text: 'sample',
          per_scanner: {},
          by_entity_type: {},
          not_run: [],
        });
      }
      throw new Error(`Unexpected test request: ${method} ${url}`);
    });

    const service = new GmAccountService(providerBridge());
    const snapshot = await service.getGuardrails();
    await expect(
      service.previewGuardrails('native:pii', scannerBody, 'sample', snapshot.context)
    ).resolves.toMatchObject({ blocked: false });
    expect(refreshCount).toBe(1);
    expect(previewPayloads).toEqual([
      { scanners: scannerBody, text: 'sample' },
      { scanners: scannerBody, text: 'sample' },
    ]);
    expect(previewRequests).toHaveLength(2);
    expect(previewRequests.every((request) => request.redirect === 'error')).toBe(true);
    expect(previewRequests.every((request) => request.cache === 'no-store')).toBe(true);
    expect(new globalThis.Headers(previewRequests[0]?.headers).get('authorization')).toBe(
      'Bearer access-0'
    );
    expect(new globalThis.Headers(previewRequests[1]?.headers).get('authorization')).toBe(
      'Bearer access-1'
    );
    expect(previewRequests.every((request) => request.signal !== undefined)).toBe(true);
    const stored = JSON.parse(
      Buffer.from(
        await fs.readFile(path.join(userDataDirectory, 'saygm-account.safe'), 'utf8'),
        'base64'
      ).toString('utf8')
    ) as Record<string, unknown>;
    expect(stored).toMatchObject({ accessToken: 'access-1', refreshToken: 'refresh-1' });
  });

  it.each([
    ['HTML unknown-route response', '<!doctype html><title>Not Found</title>'],
    ['generic not_found response', { error: { code: 'not_found' } }],
    ['key-sounding generic response', { error: 'API key not found' }],
  ])('does not treat a 404 %s as a missing managed key', async (_description, body) => {
    const provider = providerBridge();
    fetchMock.mockImplementation(async (input: FetchRequestInput, init?: FetchRequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === `${accountBase}/oauth/device_authorization`) {
        return jsonResponse(200, deviceAuthorization());
      }
      if (url === `${accountBase}/oauth/token`) {
        return jsonResponse(200, tokens('access-0', 'refresh-0'));
      }
      if (url === `${accountBase}/me`) return jsonResponse(200, { email: 'test@saygm.com' });
      if (url === `${accountBase}/capabilities`) {
        return jsonResponse(200, capabilitiesFixture());
      }
      if (url === `${accountBase}/keys` && method === 'POST') {
        return jsonResponse(201, { id: 'managed-1', secret: 'gm_managed_secret' });
      }
      if (url === `${accountBase}/keys/managed-1/guardrails`) {
        return {
          status: 404,
          text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
        } as Response;
      }
      throw new Error(`Unexpected test request: ${method} ${url}`);
    });

    const service = new GmAccountService(provider);
    await startDeviceFlow(service, 34);
    await expect(service.pollDeviceLogin(34, [targetA])).resolves.toMatchObject({
      status: 'connected',
    });
    const credentialsPath = path.join(userDataDirectory, 'saygm-account.safe');
    const credentialsBefore = await fs.readFile(credentialsPath, 'utf8');

    await expect(service.getGuardrails()).rejects.toThrow(
      'Could not read guardrails (SayGM account service HTTP 404).'
    );
    await expect(service.getStatus()).resolves.toMatchObject({
      connected: true,
      mode: 'session',
      email: 'test@saygm.com',
    });
    expect(await fs.readFile(credentialsPath, 'utf8')).toBe(credentialsBefore);
    expect(provider.clearApiKeyIfMatches).not.toHaveBeenCalled();
    expect(
      fetchMock.mock.calls.some(([input]) => String(input) === `${accountBase}/oauth/revoke`)
    ).toBe(false);
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) =>
          String(input) === `${accountBase}/keys/managed-1` && init?.method === 'DELETE'
      )
    ).toBe(false);
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) =>
          String(input) === `${accountBase}/keys/managed-1/guardrails` && init?.method === 'PUT'
      )
    ).toBe(false);
  });

  it('does not retry a guardrail PUT after logout starts during token refresh', async () => {
    let finishRefresh!: (response: Response) => void;
    let refreshStarted!: () => void;
    const refreshStartedPromise = new Promise<void>((resolve) => {
      refreshStarted = resolve;
    });
    let putCount = 0;
    fetchMock.mockImplementation(async (input: FetchRequestInput, init?: FetchRequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === `${accountBase}/oauth/device_authorization`) {
        return jsonResponse(200, deviceAuthorization());
      }
      if (url === `${accountBase}/oauth/token`) {
        const values = new URLSearchParams(String(init?.body ?? ''));
        if (values.get('grant_type') === 'urn:ietf:params:oauth:grant-type:device_code') {
          return jsonResponse(200, tokens('access-0', 'refresh-0'));
        }
        refreshStarted();
        return new Promise<Response>((resolve) => {
          finishRefresh = resolve;
        });
      }
      if (url === `${accountBase}/me`) return jsonResponse(200, { email: 'test@saygm.com' });
      if (url === `${accountBase}/capabilities`) {
        return jsonResponse(200, capabilitiesFixture());
      }
      if (url === `${accountBase}/keys` && method === 'POST') {
        return jsonResponse(201, { id: 'managed-1', secret: 'gm_managed_secret' });
      }
      if (url === `${accountBase}/keys/managed-1/guardrails` && method === 'GET') {
        return jsonResponse(200, { body: null });
      }
      if (url === `${accountBase}/keys/managed-1/guardrails` && method === 'PUT') {
        putCount += 1;
        return jsonResponse(401, { error: 'expired_token' });
      }
      if (url === `${accountBase}/keys/managed-1` && method === 'DELETE') {
        expect(new globalThis.Headers(init?.headers).get('authorization')).toBe('Bearer access-1');
        return jsonResponse(204, null);
      }
      if (url === `${accountBase}/oauth/revoke`) return jsonResponse(200, {});
      throw new Error(`Unexpected test request: ${method} ${url}`);
    });

    const service = new GmAccountService(providerBridge());
    await service.beginDeviceLogin(32);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(service.pollDeviceLogin(32, [targetA])).resolves.toMatchObject({
      status: 'connected',
    });
    const loaded = await service.getGuardrails();
    const saving = service.saveGuardrails(
      { 'native:ban-substrings': { mode: 'block', substrings: ['blocked'] } },
      loaded.context
    );
    await refreshStartedPromise;
    const loggingOut = service.logout([targetA]);
    finishRefresh(jsonResponse(200, tokens('access-1', 'refresh-1')));

    await expect(saving).rejects.toThrow('cancelled');
    await expect(loggingOut).resolves.toEqual({});
    expect(putCount).toBe(1);
  });
});

async function startDeviceFlow(service: GmAccountService, windowId: number): Promise<void> {
  await service.beginDeviceLogin(windowId);
  await vi.advanceTimersByTimeAsync(5_000);
}

async function writeEncryptedFixture(fileName: string, value: unknown): Promise<void> {
  await fs.writeFile(
    path.join(userDataDirectory, fileName),
    Buffer.from(JSON.stringify(value), 'utf8').toString('base64'),
    'utf8'
  );
}

function providerBridge(overrides: Partial<GmProviderBridge> = {}): GmProviderBridge {
  return {
    saveApiKey: vi.fn(async () => undefined),
    clearApiKeyIfMatches: vi.fn(async () => undefined),
    ...overrides,
  };
}

function deviceAuthorization(deviceCode = 'DEVICE-A', userCode = 'A1B2-C3D4') {
  return {
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: 'https://saygm.com/device',
    expires_in: 600,
    interval: 5,
  };
}

function tokens(accessToken: string, refreshToken: string, sessionId = 'session-1') {
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    session_id: sessionId,
  };
}

function capabilitiesFixture(options: { guardrailsDeployed?: boolean } = {}) {
  const base = (operationId: string, path: string, method = 'GET') => ({
    operation_id: operationId,
    method,
    path,
    adapter_support: 'supported' as 'supported' | 'not_supported',
    entitlement_state: 'unknown' as const,
    dependency_state: 'unknown' as const,
    available: null as boolean | null,
    availability_reason: 'Dependency health is unknown.' as string | null,
  });
  const read = base('guardrails.key.read', '/v1/keys/{id}/guardrails');
  const write = base('guardrails.key.write', '/v1/keys/{id}/guardrails', 'PUT');
  const preview = base('guardrails.draft_preview', '/v1/keys/{id}/guardrails/preview', 'POST');
  if (options.guardrailsDeployed === false) {
    for (const operation of [read, write, preview]) {
      operation.adapter_support = 'not_supported';
      operation.available = false;
      operation.availability_reason = 'This account service does not support the route.';
    }
  }
  return {
    contract_version: 1,
    operations: [
      base('account.profile.read', '/v1/me'),
      base('billing.balance.read', '/v1/balance'),
      base('keys.list_metadata', '/v1/keys'),
      base('keys.create', '/v1/keys', 'POST'),
      base('keys.rename', '/v1/keys/{id}', 'PATCH'),
      base('keys.revoke', '/v1/keys/{id}', 'DELETE'),
      read,
      write,
      preview,
    ],
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    text: async () => JSON.stringify(body),
  } as Response;
}
