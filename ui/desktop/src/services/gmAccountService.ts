import { app, safeStorage } from 'electron';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type {
  GmAccountBalance,
  GmGuardrailsPolicyBody,
  GmGuardrailsPolicySnapshot,
  GmGuardrailsPreviewResponse,
  GmGuardrailsPreviewScannerId,
  GmAccountStatus,
  GmCapabilities,
  GmDeviceLoginInstructions,
  GmDevicePollResult,
  GmOAuthCapability,
} from '../types/gmAccount';
import { SAYGM_PRODUCT } from '../product/saygmProduct';

const ACCOUNT_API = SAYGM_PRODUCT.accountApiBaseUrl;
const GATEWAY_API = SAYGM_PRODUCT.gatewayApiBaseUrl;
const CLIENT_ID = SAYGM_PRODUCT.oauthClientId;
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const DEFAULT_POLL_INTERVAL_SECONDS = 5;
const SLOW_DOWN_SECONDS = 5;
const REQUEST_TIMEOUT_MS = 15_000;
const GUARDRAIL_PREVIEW_TIMEOUT_MS = 30_000;
const GUARDRAIL_PREVIEW_MAX_TEXT_BYTES = 128 * 1024;
const GUARDRAIL_PREVIEW_MAX_BODY_BYTES = 1024 * 1024;
const GUARDRAIL_PREVIEW_MAX_CONFIG_BYTES = 16 * 1024;
const CREDENTIALS_FILE = SAYGM_PRODUCT.accountCredentialsFile;
const LEGACY_KEY_CLEANUP_FILE = 'saygm-legacy-key-cleanup.safe';
const API_KEY_NAME = SAYGM_PRODUCT.providerKeyName;
const CLEANUP_RETRY_COOLDOWN_MS = 60_000;
type FetchInit = NonNullable<Parameters<typeof globalThis.fetch>[1]>;
type SessionRequestOptions = {
  timeoutMs?: number;
  redirect?: FetchInit['redirect'];
  cache?: FetchInit['cache'];
};

type SessionCredentials = {
  mode: 'session';
  sessionId: string;
  email: string;
  accessToken: string;
  refreshToken: string;
  providerConfigured: boolean;
  managedProviderKeyId?: string;
  managedProviderKeyHash?: string;
  managedProviderKey?: string;
  managedProviderKeyState?: 'pending' | 'active' | 'disabled';
};

type ApiKeyCredentials = {
  mode: 'api_key';
  key: string;
  keyPrefix: string;
  providerConfigured: boolean;
  keyAuthorityState?: 'pending' | 'active' | 'disabled';
};

type StoredCredentials = (SessionCredentials | ApiKeyCredentials) & { version: 1 };

type PendingCleanup = {
  sessionId: string;
  accessToken: string;
  refreshToken: string;
  revokeSession: boolean;
  sessionRevoked: boolean;
  managedKeyRevoked: boolean;
  providerKeyCleared: boolean;
  managedProviderKeyId?: string;
  managedProviderKeyHash?: string;
  state: 'cleanup' | 'active';
};

type LegacyKeyCleanup = { version: 1; sha256s: string[] };

type DeviceAuthorization = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
};

type PendingDeviceAuthorization = DeviceAuthorization & {
  generation: number;
  operationGeneration: number;
  expiresAt: number;
  intervalSeconds: number;
  nextPollAt: number;
};

type TokenResponse = {
  access_token: string;
  refresh_token: string;
  session_id: string;
};

type JsonResponse = { status: number; body: unknown };

export type GmProviderBridge = {
  saveApiKey: (target: GmAcpTarget, key: string) => Promise<void>;
  clearApiKeyIfMatches: (target: GmAcpTarget, sha256: string) => Promise<void>;
  clearLegacyApiKeyIfMatches?: (target: GmAcpTarget, sha256: string) => Promise<boolean>;
};

export type ManagedModelKeyBrokerResult =
  | { ok: true; key: string | null }
  | { ok: true; matches: boolean }
  | {
      ok: false;
      code: 'unavailable' | 'denied' | 'revoked' | 'invalid_request' | 'internal_error';
    };

export type GmAcpTarget = {
  url: string;
  certificateFingerprint: string | null;
};

export class GmAccountService {
  private readonly pendingLogins = new Map<number, PendingDeviceAuthorization>();
  private readonly deviceGenerations = new Map<number, number>();
  private operationGeneration = 0;
  private lock: Promise<void> = Promise.resolve();
  private backgroundStorageUnavailable = false;
  private backgroundStorageProbe: Promise<boolean> | null = null;
  private statusRead: Promise<GmAccountStatus> | null = null;
  private pendingCleanupRead: Promise<PendingCleanup[]> | null = null;
  private cleanupRetry: Promise<boolean> | null = null;
  private cleanupRetryFailureLatched = false;
  private cleanupRetryAfter = 0;
  private modelKeyAuthorityReady = false;
  private modelKeyAuthorityFailureLatched = false;
  private modelKeyAuthorityBlocked = false;
  private modelKeyAuthorityGeneration = 0;
  private modelKeyAuthority: StoredCredentials | null = null;
  private modelKeyAuthorityInitialization: Promise<void> | null = null;

  constructor(
    private readonly provider: GmProviderBridge,
    private readonly managedKeyBrokerEnabled = false
  ) {}

  initializeManagedModelKeyAuthority(): Promise<void> {
    if (this.modelKeyAuthorityInitialization) return this.modelKeyAuthorityInitialization;
    if (this.modelKeyAuthorityReady || this.modelKeyAuthorityFailureLatched)
      return Promise.resolve();
    const generation = this.modelKeyAuthorityGeneration;
    const request = (async () => {
      try {
        if (!(await this.backgroundSecureStorageReady())) return;
        const credentials = await this.readCredentials(true);
        if (generation !== this.modelKeyAuthorityGeneration) return;
        this.publishModelKeyAuthority(credentials);
      } catch {
        if (generation === this.modelKeyAuthorityGeneration) {
          this.modelKeyAuthorityFailureLatched = true;
        }
      }
    })().finally(() => {
      if (this.modelKeyAuthorityInitialization === request) {
        this.modelKeyAuthorityInitialization = null;
      }
    });
    this.modelKeyAuthorityInitialization = request;
    return request;
  }

  async readManagedModelKeyForBackend(): Promise<ManagedModelKeyBrokerResult> {
    if (!this.managedKeyBrokerEnabled) return { ok: false, code: 'unavailable' };
    if (!this.modelKeyAuthorityReady || this.modelKeyAuthorityFailureLatched) {
      return { ok: false, code: 'unavailable' };
    }
    if (this.modelKeyAuthorityBlocked) return { ok: false, code: 'revoked' };
    const credentials = this.modelKeyAuthority;
    const key = credentials ? stagedModelKey(credentials) : null;
    return { ok: true, key };
  }

  async managedModelKeyMatchesForBackend(sha256: string): Promise<ManagedModelKeyBrokerResult> {
    if (!this.managedKeyBrokerEnabled) return { ok: false, code: 'unavailable' };
    if (!/^[a-f0-9]{64}$/.test(sha256)) return { ok: false, code: 'invalid_request' };
    if (!this.modelKeyAuthorityReady || this.modelKeyAuthorityFailureLatched) {
      return { ok: false, code: 'unavailable' };
    }
    if (this.modelKeyAuthorityBlocked) return { ok: true, matches: false };
    const credentials = this.modelKeyAuthority;
    return { ok: true, matches: !!credentials && activeModelKeyMatches(credentials, sha256) };
  }

  private blockManagedModelKeyAuthority(): void {
    if (!this.managedKeyBrokerEnabled) return;
    this.modelKeyAuthorityBlocked = true;
    this.modelKeyAuthorityGeneration += 1;
    this.modelKeyAuthority = null;
  }

  private enableManagedModelKeyAuthority(): void {
    if (!this.managedKeyBrokerEnabled) return;
    this.modelKeyAuthorityBlocked = false;
    this.modelKeyAuthorityGeneration += 1;
    this.modelKeyAuthorityFailureLatched = false;
  }

  private retryManagedModelKeyAuthorityAfterExplicitUnlock(credentials: StoredCredentials): void {
    if (!this.managedKeyBrokerEnabled || this.modelKeyAuthorityBlocked) return;
    // A deliberate account action has just unlocked the encrypted envelope.
    // Invalidate any earlier startup load so it cannot publish stale state.
    this.modelKeyAuthorityGeneration += 1;
    this.modelKeyAuthorityFailureLatched = false;
    this.publishModelKeyAuthority(credentials);
  }

  private publishModelKeyAuthority(credentials: StoredCredentials | null): void {
    if (!this.managedKeyBrokerEnabled) return;
    if (this.modelKeyAuthorityFailureLatched) return;
    if (this.modelKeyAuthorityBlocked) {
      this.modelKeyAuthority = null;
      return;
    }
    this.modelKeyAuthority = credentials;
    this.modelKeyAuthorityReady = true;
  }

  getStatus(): Promise<GmAccountStatus> {
    if (this.statusRead) return this.statusRead;
    const request = this.loadStatus();
    this.statusRead = request;
    const clear = () => {
      if (this.statusRead === request) this.statusRead = null;
    };
    void request.then(clear, clear);
    return request;
  }

  private async loadStatus(): Promise<GmAccountStatus> {
    const secureStorageAvailable = await this.backgroundSecureStorageReady();
    if (!secureStorageAvailable) return statusFor(null, false, this.managedKeyBrokerEnabled);
    try {
      const credentials = await this.readCredentials(true);
      const pendingCleanup = await this.readPendingCleanups();
      const legacyKeyCleanup = await this.readLegacyKeyCleanup(true);
      return {
        ...statusFor(credentials, true, this.managedKeyBrokerEnabled),
        remoteCleanupPending: pendingCleanup.some(
          (cleanup) =>
            cleanup.state === 'cleanup' && !cleanupRetainsStoredModelKey(credentials, cleanup)
        ),
        legacyKeyCleanupPending: legacyKeyCleanup !== null,
      };
    } catch (error) {
      this.latchBackgroundStorageFailure();
      throw error;
    }
  }

  private backgroundSecureStorageReady(): Promise<boolean> {
    if (this.backgroundStorageUnavailable) return Promise.resolve(false);
    if (this.backgroundStorageProbe) return this.backgroundStorageProbe;
    const probe = Promise.resolve()
      .then(() => this.checkSecureStorageForOperation())
      .catch(() => {
        this.latchBackgroundStorageFailure();
        return false;
      })
      .finally(() => {
        if (this.backgroundStorageProbe === probe) this.backgroundStorageProbe = null;
      });
    this.backgroundStorageProbe = probe;
    return probe;
  }

  private checkSecureStorageForOperation(): boolean {
    try {
      const available = secureStorageReady();
      const wasUnavailable = this.backgroundStorageUnavailable;
      if (!available) {
        this.latchBackgroundStorageFailure();
        return false;
      }
      this.backgroundStorageUnavailable = false;
      if (wasUnavailable) {
        this.statusRead = null;
        this.cleanupRetryFailureLatched = false;
        this.cleanupRetryAfter = 0;
      }
      return available;
    } catch {
      this.latchBackgroundStorageFailure();
      return false;
    }
  }

  private latchBackgroundStorageFailure(): void {
    this.backgroundStorageUnavailable = true;
    this.statusRead = null;
  }

  async beginDeviceLogin(windowId: number): Promise<GmDeviceLoginInstructions> {
    if (!this.checkSecureStorageForOperation()) {
      throw new Error('Secure storage is unavailable on this device.');
    }
    this.invalidateDeviceLogins();
    const operationGeneration = this.operationGeneration;
    const generation = this.bumpDeviceGeneration(windowId);
    if (await this.readCredentials(true)) {
      throw new Error('Sign out of the current SayGM connection before starting another sign-in.');
    }
    this.enableManagedModelKeyAuthority();
    if (
      this.deviceGenerations.get(windowId) !== generation ||
      this.operationGeneration !== operationGeneration
    ) {
      throw new Error('Sign-in was cancelled.');
    }
    const response = await oauthPost('device_authorization', {
      client_id: CLIENT_ID,
      device_name: `${app.getName()} ${os.hostname()}`.slice(0, 120),
    });
    if (response.status !== 200) {
      throw accountError(response, 'start sign-in');
    }
    if (
      this.deviceGenerations.get(windowId) !== generation ||
      this.operationGeneration !== operationGeneration
    ) {
      throw new Error('Sign-in was cancelled.');
    }
    const device = parseDeviceAuthorization(response.body);
    const intervalSeconds = device.interval > 0 ? device.interval : DEFAULT_POLL_INTERVAL_SECONDS;
    const expiresAt = Date.now() + device.expires_in * 1000;
    this.pendingLogins.set(windowId, {
      ...device,
      generation,
      operationGeneration,
      intervalSeconds,
      expiresAt,
      nextPollAt: Date.now() + intervalSeconds * 1000,
    });
    return {
      userCode: device.user_code,
      verificationUri: trustedVerificationUri(
        device.verification_uri_complete ?? device.verification_uri
      ),
      expiresAt,
      intervalSeconds,
    };
  }

  async pollDeviceLogin(windowId: number, acpTargets: GmAcpTarget[]): Promise<GmDevicePollResult> {
    return this.exclusive(async () => {
      const pending = this.pendingLogins.get(windowId);
      if (!pending) throw new Error('No SayGM sign-in is waiting for approval.');
      if (await this.readCredentials()) {
        this.pendingLogins.delete(windowId);
        throw new Error('A SayGM connection was completed in another window.');
      }
      if (Date.now() >= pending.expiresAt) {
        this.pendingLogins.delete(windowId);
        throw new Error('The sign-in code expired. Start again to get a new code.');
      }
      if (Date.now() < pending.nextPollAt) {
        return {
          status: 'pending',
          retryAfterSeconds: Math.max(1, Math.ceil((pending.nextPollAt - Date.now()) / 1000)),
        };
      }

      const response = await oauthPost('token', {
        grant_type: DEVICE_GRANT,
        device_code: pending.device_code,
        client_id: CLIENT_ID,
      });
      if (response.status !== 200) {
        if (!this.isCurrentDeviceLogin(windowId, pending)) {
          throw new Error('Sign-in was cancelled.');
        }
        const { code } = errorFields(response.body);
        if (code === 'authorization_pending') {
          pending.nextPollAt = Date.now() + pending.intervalSeconds * 1000;
          return { status: 'pending', retryAfterSeconds: pending.intervalSeconds };
        }
        if (code === 'slow_down') {
          pending.intervalSeconds += SLOW_DOWN_SECONDS;
          pending.nextPollAt = Date.now() + pending.intervalSeconds * 1000;
          return { status: 'pending', retryAfterSeconds: pending.intervalSeconds };
        }
        this.pendingLogins.delete(windowId);
        throw deviceGrantError(response);
      }

      const tokens = parseTokens(response.body);
      const initial: SessionCredentials = {
        mode: 'session',
        sessionId: tokens.session_id,
        email: '',
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        providerConfigured: false,
        managedProviderKeyState: 'pending',
      };
      if (!this.isCurrentDeviceLogin(windowId, pending)) {
        await this.revokeSessionForCleanup(initial, acpTargets);
        throw new Error('Sign-in was cancelled.');
      }
      let me: JsonResponse & { credentials: SessionCredentials };
      try {
        await this.writeCredentials({ version: 1, ...initial });
        me = await sessionRequest(initial, 'GET', '/me', undefined, (rotated) =>
          this.persistRotatedTokens(rotated)
        );
        if (me.status >= 400) throw accountError(me, 'read the SayGM account');
      } catch (error) {
        const stored = await this.readCredentials().catch(() => null);
        const refreshToken =
          stored?.mode === 'session' && stored.sessionId === initial.sessionId
            ? stored.refreshToken
            : initial.refreshToken;
        const latest =
          stored?.mode === 'session' && stored.sessionId === initial.sessionId
            ? { ...initial, accessToken: stored.accessToken, refreshToken: stored.refreshToken }
            : { ...initial, refreshToken };
        await this.revokeSessionForCleanup(latest, acpTargets);
        await this.deleteCredentialsIfSessionMatches(initial.sessionId);
        throw error;
      }
      if (!this.isCurrentDeviceLogin(windowId, pending)) {
        await this.revokeSessionForCleanup(me.credentials, acpTargets);
        await this.deleteCredentialsIfSessionMatches(initial.sessionId);
        throw new Error('Sign-in was cancelled.');
      }
      const email = isRecord(me.body) && typeof me.body.email === 'string' ? me.body.email : '';
      let credentials: SessionCredentials = {
        mode: 'session',
        sessionId: tokens.session_id,
        email,
        accessToken: me.credentials.accessToken,
        refreshToken: me.credentials.refreshToken,
        providerConfigured: false,
      };
      await this.writeCredentials({ version: 1, ...credentials });

      try {
        credentials = await this.configureSessionProvider(credentials, acpTargets, () =>
          this.isCurrentDeviceLogin(windowId, pending)
        );
        if (!this.isCurrentDeviceLogin(windowId, pending)) {
          if (credentials.managedProviderKeyId && credentials.managedProviderKeyHash) {
            await this.cleanupManagedKey(
              credentials,
              credentials.managedProviderKeyId,
              credentials.managedProviderKeyHash,
              acpTargets,
              false
            );
          }
          await this.revokeSessionForCleanup(
            await this.latestSessionCredentials(credentials),
            acpTargets
          );
          await this.deleteCredentialsIfSessionMatches(credentials.sessionId);
          throw new Error('Sign-in was cancelled.');
        }
        await this.writeCredentials({ version: 1, ...credentials });
        await this.markCleanupActive(credentials.sessionId).catch(() => undefined);
        this.invalidateOtherDeviceLogins(windowId);
      } catch (error) {
        if (!this.isCurrentDeviceLogin(windowId, pending)) {
          if (credentials.managedProviderKeyId && credentials.managedProviderKeyHash) {
            await this.cleanupManagedKey(
              credentials,
              credentials.managedProviderKeyId,
              credentials.managedProviderKeyHash,
              acpTargets,
              false
            );
          }
          await this.revokeSessionForCleanup(
            await this.latestSessionCredentials(credentials),
            acpTargets
          );
          await this.deleteCredentialsIfSessionMatches(credentials.sessionId);
          throw new Error('Sign-in was cancelled.', { cause: error });
        }
        throw new Error(
          `Signed in, but SayGM Desktop could not finish model setup. ${safeReason(error)}`,
          { cause: error }
        );
      }
      this.pendingLogins.delete(windowId);
      return {
        status: 'connected',
        account: statusFor({ version: 1, ...credentials }, true, this.managedKeyBrokerEnabled),
      };
    });
  }

  cancelDeviceLogin(windowId: number): void {
    this.bumpDeviceGeneration(windowId);
    this.pendingLogins.delete(windowId);
  }

  deviceVerificationUri(windowId: number): string {
    const pending = this.pendingLogins.get(windowId);
    if (!pending) throw new Error('No SayGM sign-in is waiting for approval.');
    return trustedVerificationUri(pending.verification_uri_complete ?? pending.verification_uri);
  }

  async getBalance(): Promise<GmAccountBalance> {
    return this.exclusive(async () => {
      const generation = this.operationGeneration;
      const credentials = await this.requireBackgroundCredentials();
      if (credentials.mode === 'api_key') {
        const balance = await keyBalance(credentials.key);
        return { kind: 'key_spendable', usd: balance.usd };
      }
      const result = await sessionRequest(credentials, 'GET', '/balance', undefined, (rotated) =>
        this.persistRotatedTokens(rotated, true, credentials)
      );
      if (result.status >= 400) throw accountError(result, 'read the SayGM balance');
      this.assertOperationCurrent(generation);
      const fields = isRecord(result.body) ? result.body : {};
      const balance = isRecord(fields.balance) ? fields.balance : {};
      if (typeof balance.usd !== 'string') {
        throw new Error('The SayGM account service returned an unexpected balance.');
      }
      return {
        kind: 'account',
        usd: balance.usd,
        ...(typeof fields.shared_balance === 'boolean'
          ? { sharedBalance: fields.shared_balance }
          : {}),
      };
    });
  }

  async getCapabilities(): Promise<GmCapabilities> {
    return this.exclusive(async () => {
      const credentials = await this.requireCredentials();
      if (credentials.mode !== 'session') {
        throw new Error('Connect with SayGM browser sign-in to check account capabilities.');
      }
      const result = await this.fetchCapabilities(credentials);
      return result.capabilities;
    });
  }

  async getGuardrails(): Promise<GmGuardrailsPolicySnapshot> {
    const generation = this.operationGeneration;
    return this.exclusive(async () => {
      this.assertOperationCurrent(generation);
      const initialCredentials = await this.requireGuardrailsSession();
      const credentials = await this.requireOperationCapabilities(
        initialCredentials,
        'guardrails.key.read'
      );
      const keyId = credentials.managedProviderKeyId!;
      this.assertOperationCurrent(generation);
      const response = await sessionRequest(
        credentials,
        'GET',
        `/keys/${encodeURIComponent(keyId)}/guardrails`,
        undefined,
        (rotated) => this.persistRotatedTokens(rotated),
        () => this.assertOperationCurrent(generation)
      );
      if (response.status >= 400) throw guardrailsError(response, 'read guardrails');
      this.assertOperationCurrent(generation);
      const body = parseGuardrailsResponse(response.body);
      const updated = { ...credentials, ...response.credentials };
      await this.writeCredentials({ version: 1, ...updated });
      this.assertOperationCurrent(generation);
      return { body, context: guardrailsContext(updated, body) };
    });
  }

  async previewGuardrails(
    scannerId: GmGuardrailsPreviewScannerId,
    scanners: GmGuardrailsPolicyBody,
    text: string,
    expectedContext: string
  ): Promise<GmGuardrailsPreviewResponse> {
    validatePreviewRequest(scannerId, scanners, text, expectedContext);
    const generation = this.operationGeneration;
    return this.exclusive(async () => {
      this.assertOperationCurrent(generation);
      const initialCredentials = await this.requireGuardrailsSession();
      const credentials = await this.requireOperationCapabilities(
        initialCredentials,
        'guardrails.draft_preview'
      );
      const keyId = credentials.managedProviderKeyId!;

      const current = await sessionRequest(
        credentials,
        'GET',
        `/keys/${encodeURIComponent(keyId)}/guardrails`,
        undefined,
        (rotated) => this.persistRotatedTokens(rotated),
        () => this.assertOperationCurrent(generation)
      );
      if (current.status >= 400) throw guardrailsError(current, 'check the saved guardrails');
      this.assertOperationCurrent(generation);
      const currentBody = parseGuardrailsResponse(current.body);
      if (expectedContext !== guardrailsContext(current.credentials, currentBody)) {
        throw new Error('The saved guardrails or SayGM account changed. Reload before testing.');
      }

      this.assertOperationCurrent(generation);
      const response = await sessionRequest(
        current.credentials,
        'POST',
        `/keys/${encodeURIComponent(keyId)}/guardrails/preview`,
        { scanners, text },
        (rotated) => this.persistRotatedTokens(rotated),
        () => this.assertOperationCurrent(generation),
        { timeoutMs: GUARDRAIL_PREVIEW_TIMEOUT_MS, redirect: 'error', cache: 'no-store' }
      );
      this.assertOperationCurrent(generation);
      if (response.status >= 400) throw guardrailsPreviewError(response);
      return parseGuardrailsPreviewResponse(response.body);
    });
  }

  async saveGuardrails(
    body: GmGuardrailsPolicyBody,
    expectedContext: string
  ): Promise<GmGuardrailsPolicySnapshot> {
    if (!isRecord(body)) throw new Error('The guardrail policy is invalid.');
    let serialized: string;
    try {
      serialized = JSON.stringify(body);
    } catch {
      throw new Error('The guardrail policy is invalid.');
    }
    if (serialized.length > 65_536) throw new Error('The guardrail policy is too large.');

    const generation = this.operationGeneration;
    return this.exclusive(async () => {
      this.assertOperationCurrent(generation);
      const initialCredentials = await this.requireGuardrailsSession();
      const credentials = await this.requireOperationCapabilities(
        initialCredentials,
        'guardrails.key.write'
      );
      const keyId = credentials.managedProviderKeyId!;
      this.assertOperationCurrent(generation);
      const current = await sessionRequest(
        credentials,
        'GET',
        `/keys/${encodeURIComponent(keyId)}/guardrails`,
        undefined,
        (rotated) => this.persistRotatedTokens(rotated),
        () => this.assertOperationCurrent(generation)
      );
      if (current.status >= 400) throw guardrailsError(current, 'check the saved guardrails');
      this.assertOperationCurrent(generation);
      const currentBody = parseGuardrailsResponse(current.body);
      if (
        !expectedContext ||
        expectedContext !== guardrailsContext(current.credentials, currentBody)
      ) {
        throw new Error('The saved guardrails or SayGM account changed. Reload before saving.');
      }
      this.assertOperationCurrent(generation);
      const response = await sessionRequest(
        current.credentials,
        'PUT',
        `/keys/${encodeURIComponent(keyId)}/guardrails`,
        { body },
        (rotated) => this.persistRotatedTokens(rotated),
        () => this.assertOperationCurrent(generation)
      );
      if (response.status >= 400) throw guardrailsError(response, 'save guardrails');
      this.assertOperationCurrent(generation);
      const savedBody = parseGuardrailsResponse(response.body, false);
      const updated = { ...credentials, ...response.credentials };
      await this.writeCredentials({ version: 1, ...updated });
      this.assertOperationCurrent(generation);
      return { body: savedBody, context: guardrailsContext(updated, savedBody) };
    });
  }

  async connectApiKey(keyInput: string, acpTargets: GmAcpTarget[]): Promise<GmAccountStatus> {
    this.invalidateDeviceLogins();
    return this.exclusive(async () => {
      const generation = this.operationGeneration;
      if (await this.readCredentials()) {
        throw new Error('Sign out of the current SayGM connection before using another key.');
      }
      const key = keyInput.trim();
      if (!key || key.length > 4096 || /\s/.test(key)) {
        throw new Error('Enter a valid SayGM API key.');
      }
      await keyBalance(key);
      this.assertOperationCurrent(generation);
      if (acpTargets.length === 0)
        throw new Error('The SayGM local model service is not available yet.');
      const credentials: StoredCredentials = {
        version: 1,
        mode: 'api_key',
        key,
        keyPrefix: key.slice(0, 8),
        providerConfigured: false,
        keyAuthorityState: 'pending',
      };
      this.enableManagedModelKeyAuthority();
      await this.writeCredentials(credentials);
      try {
        await saveProviderKeyToTargets(this.provider, acpTargets, key);
        this.assertOperationCurrent(generation);
        const configured: StoredCredentials = {
          ...credentials,
          providerConfigured: true,
          keyAuthorityState: 'active',
        };
        await this.writeCredentials(configured);
        return statusFor(configured, true, this.managedKeyBrokerEnabled);
      } catch (error) {
        if (!this.managedKeyBrokerEnabled) {
          const cleanup = await Promise.allSettled(
            acpTargets.map((target) => this.provider.clearApiKeyIfMatches(target, keyHash(key)))
          );
          if (cleanup.every((result) => result.status === 'fulfilled')) {
            await this.deleteCredentialsIfApiKeyMatches(keyHash(key));
          }
        }
        throw new Error(
          `${
            this.managedKeyBrokerEnabled
              ? 'SayGM saved the API key securely, but local model setup needs a retry.'
              : 'SayGM Desktop could not securely store the API key.'
          } ${safeReason(error)}`,
          { cause: error }
        );
      }
    });
  }

  async finishProviderSetup(acpTargets: GmAcpTarget[]): Promise<GmAccountStatus> {
    this.invalidateDeviceLogins();
    return this.exclusive(async () => {
      const generation = this.operationGeneration;
      const credentials = await this.requireCredentials();
      this.retryManagedModelKeyAuthorityAfterExplicitUnlock(credentials);
      if (acpTargets.length === 0)
        throw new Error('The SayGM local model service is not available yet.');
      if (credentials.mode === 'api_key') {
        if (this.managedKeyBrokerEnabled && credentials.keyAuthorityState === 'disabled') {
          throw new Error(
            'This SayGM key was disabled during sign out. Connect again before setting up a key.'
          );
        }
        if (!this.managedKeyBrokerEnabled && credentials.providerConfigured) {
          return statusFor(credentials, true, this.managedKeyBrokerEnabled);
        }
        if (
          credentials.providerConfigured &&
          activeModelKeyMatches(credentials, keyHash(credentials.key))
        ) {
          return statusFor(credentials, true, this.managedKeyBrokerEnabled);
        }
        try {
          const staged: ApiKeyCredentials & { version: 1 } = {
            ...credentials,
            providerConfigured: false,
            keyAuthorityState: 'pending',
          };
          await this.writeCredentials(staged);
          await saveProviderKeyToTargets(this.provider, acpTargets, credentials.key);
          this.assertOperationCurrent(generation);
          const updated = {
            ...staged,
            providerConfigured: true,
            keyAuthorityState: 'active' as const,
          };
          await this.writeCredentials(updated);
          return statusFor(updated, true, this.managedKeyBrokerEnabled);
        } catch (error) {
          this.publishModelKeyAuthority({
            ...credentials,
            providerConfigured: false,
            keyAuthorityState: 'pending',
          });
          throw error;
        }
      }
      if (!this.managedKeyBrokerEnabled && credentials.providerConfigured) {
        return statusFor(credentials, true, this.managedKeyBrokerEnabled);
      }
      if (
        credentials.managedProviderKeyHash &&
        activeModelKeyMatches(credentials, credentials.managedProviderKeyHash)
      ) {
        return statusFor(credentials, true, this.managedKeyBrokerEnabled);
      }
      const updated = await this.configureSessionProvider(
        credentials,
        acpTargets,
        () => this.operationGeneration === generation
      );
      this.assertOperationCurrent(generation);
      try {
        await this.writeCredentials({ version: 1, ...updated });
        await this.markCleanupActive(updated.sessionId);
      } catch (error) {
        throw new Error(
          'The encrypted model key is saved and can be reused. SayGM could not finish local setup; retry setup.',
          { cause: error }
        );
      }
      return statusFor({ version: 1, ...updated }, true, this.managedKeyBrokerEnabled);
    });
  }

  async logout(acpTargets: GmAcpTarget[]): Promise<{ warning?: string }> {
    this.blockManagedModelKeyAuthority();
    this.operationGeneration += 1;
    this.invalidateDeviceLogins();
    return this.exclusive(async () => {
      this.pendingLogins.clear();
      const credentials = await this.readCredentials();
      if (!credentials) return {};
      if (credentials.mode === 'api_key') {
        if (!this.managedKeyBrokerEnabled) {
          if (acpTargets.length === 0) {
            return {
              warning:
                'Reconnect the local SayGM service to remove the API key from secure storage.',
            };
          }
          const results = await Promise.allSettled(
            acpTargets.map((target) =>
              this.provider.clearApiKeyIfMatches(target, keyHash(credentials.key))
            )
          );
          if (results.some((result) => result.status === 'rejected')) {
            return {
              warning:
                'The API key could not be cleared from every local SayGM service. Reconnect and try again.',
            };
          }
          await this.deleteCredentials();
          return {};
        }
        await this.writeCredentials({
          ...credentials,
          providerConfigured: false,
          keyAuthorityState: 'disabled',
        });
        const sha256 = keyHash(credentials.key);
        await this.writeLegacyKeyCleanup(sha256);
        await this.deleteCredentials();
        return {
          warning:
            'The API key was removed from SayGM. An older backend copy may remain in Keychain; use Remove legacy key to clear it.',
        };
      }

      if (this.managedKeyBrokerEnabled) {
        await this.writeCredentials({
          ...credentials,
          providerConfigured: false,
          managedProviderKeyState: 'disabled',
        });
      }

      let warning: string | undefined;
      let current: SessionCredentials = credentials;
      let managedKeyRevoked = !credentials.managedProviderKeyId;
      let providerKeyCleared =
        !credentials.managedProviderKeyHash && !credentials.managedProviderKeyId;
      if (credentials.managedProviderKeyId) {
        try {
          const revokeKey = await sessionRequest(
            current,
            'DELETE',
            `/keys/${encodeURIComponent(credentials.managedProviderKeyId)}`,
            undefined,
            (rotated) => this.persistRotatedTokens(rotated)
          );
          current = { ...current, ...revokeKey.credentials };
          managedKeyRevoked = revokeKey.status < 400 || revokeKey.status === 404;
          if (!managedKeyRevoked) {
            warning = 'The SayGM model key could not be revoked remotely.';
          }
        } catch {
          current = await this.latestSessionCredentials(current);
          warning = 'The SayGM model key could not be revoked remotely.';
        }
      }
      if (
        !this.managedKeyBrokerEnabled &&
        credentials.managedProviderKeyHash &&
        acpTargets.length > 0
      ) {
        const results = await Promise.allSettled(
          acpTargets.map((target) =>
            this.provider.clearApiKeyIfMatches(target, credentials.managedProviderKeyHash!)
          )
        );
        providerKeyCleared = results.every((result) => result.status === 'fulfilled');
      }
      if (
        !this.managedKeyBrokerEnabled &&
        !credentials.managedProviderKeyHash &&
        managedKeyRevoked
      ) {
        providerKeyCleared = true;
      }
      if (this.managedKeyBrokerEnabled && managedKeyRevoked) {
        providerKeyCleared = true;
      }
      if (!managedKeyRevoked && !providerKeyCleared) {
        return {
          warning: this.managedKeyBrokerEnabled
            ? 'The SayGM model key is disabled on this desktop, but remote revocation and local cleanup are still pending. Retry sign out.'
            : 'Your SayGM connection remains active because remote revocation and local cleanup are still pending. Retry sign out.',
        };
      }

      let sessionRevoked = false;
      if (this.managedKeyBrokerEnabled && credentials.managedProviderKeyHash && managedKeyRevoked) {
        try {
          await this.writeLegacyKeyCleanup(credentials.managedProviderKeyHash);
        } catch {
          return {
            warning:
              'The model key was revoked remotely, but SayGM could not save the legacy-key cleanup note. Sign out again to finish safely.',
          };
        }
      }
      // Keep refresh credentials usable until a remotely managed model key has
      // been revoked. Otherwise a failed key revocation could become permanent.
      if (managedKeyRevoked) {
        try {
          const revoked = await oauthPost('revoke', {
            token: current.refreshToken,
            token_type_hint: 'refresh_token',
            client_id: CLIENT_ID,
          });
          if (revoked.status !== 200 && errorFields(revoked.body).code !== 'invalid_token') {
            throw accountError(revoked, 'sign out');
          }
          sessionRevoked = true;
        } catch {
          current = await this.latestSessionCredentials(current);
          warning = `${warning ? `${warning} ` : ''}The SayGM session could not be revoked remotely.`;
        }
      }
      if (!sessionRevoked || !managedKeyRevoked || !providerKeyCleared) {
        try {
          await this.writePendingCleanup({
            sessionId: current.sessionId,
            accessToken: current.accessToken,
            refreshToken: current.refreshToken,
            revokeSession: true,
            sessionRevoked,
            managedKeyRevoked,
            providerKeyCleared,
            ...(credentials.managedProviderKeyId
              ? { managedProviderKeyId: credentials.managedProviderKeyId }
              : {}),
            ...(credentials.managedProviderKeyHash
              ? { managedProviderKeyHash: credentials.managedProviderKeyHash }
              : {}),
            state: 'cleanup',
          });
        } catch {
          return {
            warning:
              'The desktop could not save the remote cleanup record. Your account remains connected so you can retry sign out safely.',
          };
        }
      }
      await this.deleteCredentials();
      if (warning || !sessionRevoked || !managedKeyRevoked || !providerKeyCleared) {
        return {
          warning:
            `${warning ? `${warning} ` : ''}Signed out on this desktop. SayGM will retry remote or local cleanup when you next connect.`.trim(),
        };
      }
      return {};
    });
  }

  async clearLegacyApiKey(acpTargets: GmAcpTarget[]): Promise<{ removed: boolean }> {
    return this.exclusive(async () => {
      const pending = await this.readLegacyKeyCleanup();
      if (!pending) return { removed: true };
      const credentials = await this.readCredentials();
      if (
        credentials &&
        pending.sha256s.some((sha256) => activeModelKeyMatches(credentials, sha256))
      ) {
        throw new Error('Sign out of the matching SayGM account before removing its legacy key.');
      }
      if (acpTargets.length === 0 || !this.provider.clearLegacyApiKeyIfMatches) {
        throw new Error('Reconnect the local SayGM service before removing the legacy key.');
      }
      let removed = false;
      try {
        for (const sha256 of pending.sha256s) {
          for (const target of acpTargets) {
            removed = (await this.provider.clearLegacyApiKeyIfMatches(target, sha256)) || removed;
          }
        }
      } catch (cause) {
        throw new Error(
          'SayGM could not remove the legacy key from every local service. Retry this cleanup.',
          { cause }
        );
      }
      await this.deleteLegacyKeyCleanup();
      return { removed };
    });
  }

  private async configureSessionProvider(
    credentials: SessionCredentials,
    acpTargets: GmAcpTarget[],
    stillCurrent: () => boolean = () => true
  ): Promise<SessionCredentials> {
    if (acpTargets.length === 0)
      throw new Error('The SayGM local model service is not available yet.');
    if (!stillCurrent()) throw new Error('The SayGM connection was cancelled.');

    if (
      (!this.managedKeyBrokerEnabled && credentials.providerConfigured) ||
      (credentials.providerConfigured &&
        activeModelKeyMatches(
          { version: 1, ...credentials },
          credentials.managedProviderKeyHash ?? ''
        ))
    )
      return credentials;
    let oldCleanup = (await this.readPendingCleanups()).find(
      (cleanup) => cleanup.sessionId === credentials.sessionId
    );
    if (oldCleanup?.revokeSession) {
      throw new Error('This SayGM session is being signed out. Connect again before model setup.');
    }

    const storedKeyIsRetained =
      oldCleanup !== undefined &&
      credentials.managedProviderKeyId === oldCleanup.managedProviderKeyId &&
      credentials.managedProviderKeyHash === oldCleanup.managedProviderKeyHash &&
      typeof credentials.managedProviderKey === 'string' &&
      keyHash(credentials.managedProviderKey) === credentials.managedProviderKeyHash &&
      credentials.managedProviderKeyState !== 'disabled';
    if (oldCleanup && !storedKeyIsRetained) {
      if (
        oldCleanup.state !== 'cleanup' ||
        !oldCleanup.managedProviderKeyId ||
        !/^[a-f0-9]{64}$/.test(oldCleanup.managedProviderKeyHash ?? '')
      ) {
        throw new Error(
          'A previous SayGM model key still needs cleanup before setup can continue.'
        );
      }
      const cleanupKeyId = oldCleanup.managedProviderKeyId;
      const cleanupKeyHash = oldCleanup.managedProviderKeyHash!;
      if (!stillCurrent()) throw new Error('The SayGM connection was cancelled.');
      if (credentials.managedProviderKeyId === cleanupKeyId && !oldCleanup.managedKeyRevoked) {
        const existingStatus = await this.managedProviderKeyStatus(credentials, cleanupKeyId);
        credentials = { ...credentials, ...existingStatus.credentials };
        if (existingStatus.active) {
          throw missingManagedKeyRecoveryError();
        }
      }
      const cleaned = await this.cleanupManagedKey(
        credentials,
        cleanupKeyId,
        cleanupKeyHash,
        acpTargets,
        false
      );
      if (!stillCurrent()) throw new Error('The SayGM connection was cancelled.');
      const cleanupStillPending = (await this.readPendingCleanups()).some(
        (cleanup) => cleanup.sessionId === credentials.sessionId
      );
      if (cleanupStillPending) {
        throw new Error(
          'A previous SayGM model key still needs cleanup before setup can continue.'
        );
      }
      credentials = {
        ...credentials,
        accessToken: cleaned.accessToken,
        refreshToken: cleaned.refreshToken,
      };
      if (credentials.managedProviderKeyId === cleanupKeyId) {
        credentials = {
          ...credentials,
          managedProviderKeyId: undefined,
          managedProviderKeyHash: undefined,
          managedProviderKey: undefined,
          managedProviderKeyState: undefined,
        };
      }
      oldCleanup = undefined;
    }

    if (credentials.managedProviderKeyId || credentials.managedProviderKeyHash) {
      if (
        !credentials.managedProviderKeyId ||
        !/^[a-f0-9]{64}$/.test(credentials.managedProviderKeyHash ?? '')
      ) {
        throw new Error(
          'The saved SayGM model key ownership record is incomplete. Sign out and connect again.'
        );
      }
      const savedKeyId = credentials.managedProviderKeyId;
      if (credentials.managedProviderKeyState === 'disabled') {
        throw new Error(
          'This SayGM model key was disabled during sign out. Reconnect to set up a new key.'
        );
      }
      const savedKey = credentials.managedProviderKey;
      const savedKeyMatchesRecord =
        typeof savedKey === 'string' && keyHash(savedKey) === credentials.managedProviderKeyHash;
      const keyStatus = await this.managedProviderKeyStatus(credentials, savedKeyId);
      const active = keyStatus.active;
      credentials = { ...credentials, ...keyStatus.credentials };
      if (savedKeyMatchesRecord && active) {
        if (!stillCurrent()) throw new Error('The SayGM connection was cancelled.');
        await saveProviderKeyToTargets(this.provider, acpTargets, savedKey);
        if (!stillCurrent()) throw new Error('The SayGM connection was cancelled.');
        return {
          ...credentials,
          providerConfigured: true,
          managedProviderKeyState: 'active',
        };
      }
      if (!savedKeyMatchesRecord && active) {
        throw missingManagedKeyRecoveryError();
      }
      if (oldCleanup && oldCleanup.managedProviderKeyId === credentials.managedProviderKeyId) {
        await this.removePendingCleanup(credentials.sessionId);
        oldCleanup = undefined;
      }
      credentials = {
        ...credentials,
        providerConfigured: false,
        managedProviderKeyId: undefined,
        managedProviderKeyHash: undefined,
        managedProviderKey: undefined,
        managedProviderKeyState: undefined,
      };
    }
    if (!stillCurrent()) throw new Error('The SayGM connection was cancelled.');

    if (oldCleanup) {
      throw new Error('A previous SayGM model key still needs cleanup before setup can continue.');
    }

    let current = credentials;
    const created = await sessionRequest(
      current,
      'POST',
      '/keys',
      { name: API_KEY_NAME },
      (rotated) => this.persistRotatedTokens(rotated)
    );
    current = { ...current, ...created.credentials };
    if (created.status < 200 || created.status >= 300 || !isRecord(created.body)) {
      throw accountError(created, 'create a SayGM model key');
    }
    const keyId = typeof created.body.id === 'string' ? created.body.id : '';
    const key = typeof created.body.secret === 'string' ? created.body.secret : '';
    if (!keyId || !key) throw new Error('SayGM returned an unexpected model key response.');
    const digest = keyHash(key);
    const staged: SessionCredentials = {
      ...current,
      providerConfigured: false,
      managedProviderKeyId: keyId,
      managedProviderKeyHash: digest,
      managedProviderKey: key,
      managedProviderKeyState: 'pending',
    };
    const pendingCleanup: PendingCleanup = {
      sessionId: current.sessionId,
      accessToken: current.accessToken,
      refreshToken: current.refreshToken,
      revokeSession: false,
      sessionRevoked: false,
      managedKeyRevoked: false,
      providerKeyCleared: false,
      managedProviderKeyId: keyId,
      managedProviderKeyHash: digest,
      state: 'cleanup',
    };
    try {
      await this.writeCredentials({ version: 1, ...staged });
      await this.writePendingCleanup(pendingCleanup);
    } catch (error) {
      this.blockManagedModelKeyAuthority();
      let revokeConfirmed = false;
      try {
        const response = await sessionRequest(
          current,
          'DELETE',
          `/keys/${encodeURIComponent(keyId)}`,
          undefined,
          (rotated) => this.persistRotatedTokens(rotated)
        );
        revokeConfirmed = response.status < 400 || response.status === 404;
      } catch {
        // Keep a cleanup record if the compensating request cannot be confirmed.
      }
      if (!revokeConfirmed) await this.writePendingCleanup(pendingCleanup).catch(() => undefined);
      throw new Error(
        'SayGM created a model key but could not save its encrypted recovery record. The key was not configured; restart SayGM before retrying setup.',
        { cause: error }
      );
    }
    if (!stillCurrent()) throw new Error('The SayGM connection was cancelled.');
    await saveProviderKeyToTargets(this.provider, acpTargets, key);
    if (!stillCurrent()) throw new Error('The SayGM connection was cancelled.');
    return {
      ...staged,
      providerConfigured: true,
      managedProviderKeyState: 'active',
    };
  }

  private async managedProviderKeyStatus(
    credentials: SessionCredentials,
    keyId: string
  ): Promise<{ active: boolean; credentials: SessionCredentials }> {
    const response = await sessionRequest(credentials, 'GET', '/keys', undefined, (rotated) =>
      this.persistRotatedTokens(rotated)
    );
    if (response.status >= 400) throw accountError(response, 'check the saved SayGM model key');
    if (!isRecord(response.body) || !Array.isArray(response.body.keys)) {
      throw new Error(
        'SayGM returned an unexpected model key list. Your saved key was kept; retry setup.'
      );
    }
    const item = response.body.keys.find((entry) => isRecord(entry) && entry.id === keyId);
    if (item && (!isRecord(item) || !['active', 'revoked'].includes(String(item.status)))) {
      throw new Error(
        'SayGM returned an unknown model key status. Your saved key was kept; retry setup.'
      );
    }
    return {
      active: isRecord(item) && item.status === 'active',
      credentials: response.credentials,
    };
  }

  private async requireCredentials(): Promise<StoredCredentials> {
    const credentials = await this.readCredentials();
    if (!credentials) throw new Error('Connect your SayGM account first.');
    return credentials;
  }

  private async requireBackgroundCredentials(): Promise<StoredCredentials> {
    if (!(await this.backgroundSecureStorageReady())) {
      throw new Error(
        'System secure storage is unavailable. Restore access before refreshing balance.'
      );
    }
    const credentials = await this.readCredentials(true);
    if (!credentials) throw new Error('Connect your SayGM account first.');
    return credentials;
  }

  private async requireGuardrailsSession(): Promise<SessionCredentials> {
    const credentials = await this.requireCredentials();
    if (credentials.mode !== 'session') {
      throw new Error('Connect with SayGM browser sign-in to manage inference guardrails.');
    }
    if (
      !credentials.providerConfigured ||
      !credentials.managedProviderKeyId ||
      !credentials.managedProviderKeyHash ||
      (this.managedKeyBrokerEnabled &&
        (!credentials.managedProviderKey ||
          keyHash(credentials.managedProviderKey) !== credentials.managedProviderKeyHash ||
          credentials.managedProviderKeyState === 'disabled'))
    ) {
      throw new Error('Finish SayGM model setup before managing inference guardrails.');
    }
    return credentials;
  }

  private async fetchCapabilities(
    credentials: SessionCredentials
  ): Promise<{ capabilities: GmCapabilities; credentials: SessionCredentials }> {
    const response = await sessionRequest(
      credentials,
      'GET',
      '/capabilities',
      undefined,
      (rotated) => this.persistRotatedTokens(rotated)
    );
    if (response.status >= 400) throw capabilitiesError(response);
    return {
      capabilities: parseCapabilities(response.body),
      credentials: response.credentials,
    };
  }

  private async requireOperationCapabilities(
    credentials: SessionCredentials,
    operationId: string
  ): Promise<SessionCredentials> {
    let result: { capabilities: GmCapabilities; credentials: SessionCredentials };
    try {
      result = await this.fetchCapabilities(credentials);
    } catch (cause) {
      if (
        cause instanceof Error &&
        (cause.message.startsWith('SayGM returned an unexpected capability response.') ||
          cause.message === 'Your SayGM session expired. Sign in again.' ||
          cause.message === 'The SayGM connection was cancelled.')
      ) {
        throw cause;
      }
      return this.latestSessionCredentials(credentials);
    }
    assertOperationCapability(result.capabilities, operationId);
    return result.credentials;
  }

  private async readCredentials(storageAlreadyChecked = false): Promise<StoredCredentials | null> {
    const file = credentialsPath();
    let encrypted: string;
    try {
      encrypted = await fs.readFile(file, 'utf8');
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return null;
      throw error;
    }
    if (!storageAlreadyChecked && !this.checkSecureStorageForOperation()) {
      throw new Error('OS secure storage is unavailable.');
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(safeStorage.decryptString(Buffer.from(encrypted, 'base64')));
    } catch {
      this.latchBackgroundStorageFailure();
      throw new Error('Saved SayGM account data could not be unlocked.');
    }
    if (!isStoredCredentials(decoded)) throw new Error('Saved SayGM account data is invalid.');
    return decoded;
  }

  private async readLegacyKeyCleanup(
    storageAlreadyChecked = false
  ): Promise<LegacyKeyCleanup | null> {
    let encrypted: string;
    try {
      encrypted = await fs.readFile(legacyKeyCleanupPath(), 'utf8');
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return null;
      throw error;
    }
    if (!storageAlreadyChecked && !this.checkSecureStorageForOperation()) {
      throw new Error('OS secure storage is unavailable.');
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(safeStorage.decryptString(Buffer.from(encrypted, 'base64')));
    } catch {
      this.latchBackgroundStorageFailure();
      throw new Error('Saved legacy key cleanup data could not be unlocked.');
    }
    if (
      !isRecord(decoded) ||
      decoded.version !== 1 ||
      !Array.isArray(decoded.sha256s) ||
      decoded.sha256s.length > 64 ||
      decoded.sha256s.some((digest) => typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest))
    ) {
      throw new Error('Saved legacy key cleanup data is invalid.');
    }
    return { version: 1, sha256s: [...new Set(decoded.sha256s as string[])] };
  }

  private async writeLegacyKeyCleanup(sha256: string): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(sha256))
      throw new Error('The legacy key cleanup record is invalid.');
    if (!this.checkSecureStorageForOperation())
      throw new Error('OS secure storage is unavailable.');
    const existing = await this.readLegacyKeyCleanup(true);
    const sha256s = [...new Set([...(existing?.sha256s ?? []), sha256])];
    if (sha256s.length > 64) {
      throw new Error(
        'Remove saved legacy API-key cleanups before signing out another manually configured key.'
      );
    }
    const value: LegacyKeyCleanup = {
      version: 1,
      sha256s,
    };
    const encrypted = this.encryptSecureData(JSON.stringify(value));
    const file = legacyKeyCleanupPath();
    const temporary = `${file}.tmp`;
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.writeFile(temporary, encrypted, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temporary, file);
    this.statusRead = null;
  }

  private async deleteLegacyKeyCleanup(): Promise<void> {
    await fs.rm(legacyKeyCleanupPath(), { force: true });
    this.statusRead = null;
  }

  private async writeCredentials(
    credentials: StoredCredentials,
    storageAlreadyChecked = false
  ): Promise<void> {
    if (!storageAlreadyChecked && !this.checkSecureStorageForOperation()) {
      throw new Error('OS secure storage is unavailable.');
    }
    const file = credentialsPath();
    const temporary = `${file}.tmp`;
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const persisted = this.modelKeyAuthorityBlocked
      ? disableModelKeyAuthority(credentials)
      : credentials;
    const encrypted = this.encryptSecureData(JSON.stringify(persisted));
    await fs.writeFile(temporary, encrypted, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temporary, file);
    this.publishModelKeyAuthority(persisted);
    this.statusRead = null;
  }

  private encryptSecureData(plaintext: string): string {
    try {
      return safeStorage.encryptString(plaintext).toString('base64');
    } catch {
      this.latchBackgroundStorageFailure();
      throw new Error(
        'SayGM could not secure saved account data. Check system credential store access, then retry.'
      );
    }
  }

  private async deleteCredentials(): Promise<void> {
    await fs.rm(credentialsPath(), { force: true });
    this.modelKeyAuthorityGeneration += 1;
    this.modelKeyAuthority = null;
    this.modelKeyAuthorityReady = true;
    this.statusRead = null;
  }

  private async writePendingCleanup(cleanup: PendingCleanup): Promise<void> {
    const file = cleanupPath();
    const cleanups = await this.readPendingCleanups();
    const next = cleanups.filter((item) => item.sessionId !== cleanup.sessionId);
    next.push(cleanup);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const encrypted = this.encryptSecureData(JSON.stringify({ version: 1, cleanups: next }));
    const temporary = `${file}.tmp`;
    await fs.writeFile(temporary, encrypted, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temporary, file);
    this.statusRead = null;
  }

  private async markCleanupActive(sessionId: string): Promise<void> {
    const credentials = await this.readCredentials();
    const cleanups = await this.readPendingCleanups();
    const cleanup = cleanups.find((item) => item.sessionId === sessionId);
    if (!cleanup) return;
    if (
      credentials?.mode !== 'session' ||
      credentials.sessionId !== sessionId ||
      !activeModelKeyMatches(credentials, credentials.managedProviderKeyHash ?? '') ||
      credentials.managedProviderKeyId !== cleanup.managedProviderKeyId ||
      credentials.managedProviderKeyHash !== cleanup.managedProviderKeyHash
    ) {
      return;
    }
    cleanup.state = 'active';
    await this.replacePendingCleanups(cleanups);
  }

  private async removePendingCleanup(sessionId: string): Promise<void> {
    const cleanups = await this.readPendingCleanups();
    await this.replacePendingCleanups(cleanups.filter((item) => item.sessionId !== sessionId));
  }

  private async latestSessionCredentials(
    fallback: SessionCredentials
  ): Promise<SessionCredentials> {
    const stored = await this.readCredentials().catch(() => null);
    return stored?.mode === 'session' && stored.sessionId === fallback.sessionId
      ? stored
      : fallback;
  }

  private async cleanupManagedKey(
    fallback: SessionCredentials,
    keyId: string,
    digest: string,
    acpTargets: GmAcpTarget[],
    revokeSession: boolean
  ): Promise<SessionCredentials> {
    let current = await this.latestSessionCredentials(fallback);
    const pendingCleanups = await this.readPendingCleanups();
    let cleanup = pendingCleanups.find((item) => item.sessionId === current.sessionId) ?? {
      sessionId: current.sessionId,
      accessToken: current.accessToken,
      refreshToken: current.refreshToken,
      revokeSession,
      sessionRevoked: false,
      managedKeyRevoked: false,
      providerKeyCleared: false,
      managedProviderKeyId: keyId,
      managedProviderKeyHash: digest,
      state: 'cleanup' as const,
    };
    cleanup = {
      ...cleanup,
      revokeSession: cleanup.revokeSession || revokeSession,
      state: 'cleanup',
    };
    await this.writePendingCleanup(cleanup);

    if (
      cleanup.accessToken !== current.accessToken ||
      cleanup.refreshToken !== current.refreshToken
    ) {
      current = await this.reconcileCleanupSessionTokens(current, cleanup);
      cleanup = {
        ...cleanup,
        accessToken: current.accessToken,
        refreshToken: current.refreshToken,
      };
    }

    if (!cleanup.managedKeyRevoked) {
      try {
        const revoked = await sessionRequest(
          current,
          'DELETE',
          `/keys/${encodeURIComponent(keyId)}`,
          undefined,
          async (rotated) => {
            current = rotated;
            cleanup = {
              ...cleanup,
              accessToken: rotated.accessToken,
              refreshToken: rotated.refreshToken,
            };
            await this.persistRotatedTokens(rotated);
          }
        );
        current = revoked.credentials;
        cleanup = {
          ...cleanup,
          accessToken: current.accessToken,
          refreshToken: current.refreshToken,
          managedKeyRevoked: revoked.status < 400 || revoked.status === 404,
        };
        if (cleanup.managedKeyRevoked) await this.persistRotatedTokens(current);
      } catch {
        current = await this.latestSessionCredentials(current);
      }
    }
    if (!cleanup.providerKeyCleared && acpTargets.length > 0) {
      const cleared = await Promise.allSettled(
        acpTargets.map((target) => this.provider.clearApiKeyIfMatches(target, digest))
      );
      cleanup.providerKeyCleared = cleared.every((result) => result.status === 'fulfilled');
    }
    if (cleanup.revokeSession && cleanup.managedKeyRevoked && !cleanup.sessionRevoked) {
      try {
        await revokeRefreshToken(current.refreshToken);
        cleanup.sessionRevoked = true;
      } catch {
        cleanup.sessionRevoked = false;
      }
    }
    cleanup.state = 'cleanup';
    if (
      cleanup.managedKeyRevoked &&
      cleanup.providerKeyCleared &&
      (!cleanup.revokeSession || cleanup.sessionRevoked)
    ) {
      await this.removePendingCleanup(current.sessionId);
    } else {
      await this.writePendingCleanup({
        ...cleanup,
        accessToken: cleanup.accessToken,
        refreshToken: cleanup.refreshToken,
      });
    }
    return current;
  }

  private async reconcileCleanupSessionTokens(
    current: SessionCredentials,
    cleanup: PendingCleanup,
    persistLiveCredentials = true
  ): Promise<SessionCredentials> {
    const candidates = [current];
    if (cleanup.refreshToken !== current.refreshToken) {
      candidates.push({
        ...current,
        accessToken: cleanup.accessToken,
        refreshToken: cleanup.refreshToken,
      });
    }
    for (const [index, candidate] of candidates.entries()) {
      const response = await oauthPost('token', {
        grant_type: 'refresh_token',
        refresh_token: candidate.refreshToken,
        client_id: CLIENT_ID,
      });
      if (response.status !== 200) {
        if (index === 0 && candidates.length > 1 && isInvalidGrantResponse(response)) continue;
        throw accountError(response, 'refresh the SayGM session');
      }
      const tokens = parseTokens(response.body);
      if (tokens.session_id !== current.sessionId) {
        throw new Error('The SayGM session changed while cleaning up an earlier model key.');
      }
      const rotated: SessionCredentials = {
        ...candidate,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
      };
      if (persistLiveCredentials) {
        await this.persistRotatedTokens(rotated);
      } else {
        await this.writePendingCleanup({
          ...cleanup,
          accessToken: rotated.accessToken,
          refreshToken: rotated.refreshToken,
        });
      }
      return rotated;
    }
    throw new Error('The SayGM session could not be verified for model setup.');
  }

  private async revokeSessionForCleanup(
    fallback: SessionCredentials,
    acpTargets: GmAcpTarget[]
  ): Promise<void> {
    let current = await this.latestSessionCredentials(fallback);
    const existing = (await this.readPendingCleanups().catch(() => [])).find(
      (item) => item.sessionId === current.sessionId
    );
    let cleanup: PendingCleanup = existing ?? {
      sessionId: current.sessionId,
      accessToken: current.accessToken,
      refreshToken: current.refreshToken,
      revokeSession: true,
      sessionRevoked: false,
      managedKeyRevoked: !current.managedProviderKeyId,
      providerKeyCleared: !current.managedProviderKeyHash,
      ...(current.managedProviderKeyId
        ? { managedProviderKeyId: current.managedProviderKeyId }
        : {}),
      ...(current.managedProviderKeyHash
        ? { managedProviderKeyHash: current.managedProviderKeyHash }
        : {}),
      state: 'cleanup',
    };
    cleanup = { ...cleanup, revokeSession: true, state: 'cleanup' };
    await this.writePendingCleanup(cleanup);

    if (!cleanup.managedKeyRevoked && cleanup.managedProviderKeyId) {
      try {
        const result = await sessionRequest(
          current,
          'DELETE',
          `/keys/${encodeURIComponent(cleanup.managedProviderKeyId)}`,
          undefined,
          async (rotated) => {
            current = rotated;
            cleanup = {
              ...cleanup,
              accessToken: rotated.accessToken,
              refreshToken: rotated.refreshToken,
            };
            await this.writePendingCleanup(cleanup);
          }
        );
        current = result.credentials;
        cleanup = {
          ...cleanup,
          accessToken: current.accessToken,
          refreshToken: current.refreshToken,
          managedKeyRevoked: result.status < 400 || result.status === 404,
        };
      } catch {
        current = await this.latestSessionCredentials(current);
        cleanup = {
          ...cleanup,
          accessToken: current.accessToken,
          refreshToken: current.refreshToken,
        };
      }
    }
    if (!cleanup.providerKeyCleared && cleanup.managedProviderKeyHash && acpTargets.length > 0) {
      const results = await Promise.allSettled(
        acpTargets.map((target) =>
          this.provider.clearApiKeyIfMatches(target, cleanup.managedProviderKeyHash!)
        )
      );
      cleanup.providerKeyCleared = results.every((result) => result.status === 'fulfilled');
    }
    if (!cleanup.sessionRevoked && cleanup.managedKeyRevoked) {
      try {
        await revokeRefreshToken(current.refreshToken);
        cleanup.sessionRevoked = true;
      } catch {
        cleanup.sessionRevoked = false;
      }
    }
    if (cleanup.sessionRevoked && cleanup.managedKeyRevoked && cleanup.providerKeyCleared) {
      await this.removePendingCleanup(current.sessionId);
    } else {
      await this.writePendingCleanup({
        ...cleanup,
        accessToken: current.accessToken,
        refreshToken: current.refreshToken,
      });
    }
  }

  private readPendingCleanups(): Promise<PendingCleanup[]> {
    if (this.pendingCleanupRead) return this.pendingCleanupRead;
    const request = this.loadPendingCleanups();
    this.pendingCleanupRead = request;
    const clear = () => {
      if (this.pendingCleanupRead === request) this.pendingCleanupRead = null;
    };
    void request.then(clear, clear);
    return request;
  }

  private async loadPendingCleanups(): Promise<PendingCleanup[]> {
    let encrypted: string;
    try {
      encrypted = await fs.readFile(cleanupPath(), 'utf8');
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return [];
      throw error;
    }
    try {
      const decoded: unknown = JSON.parse(
        safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
      );
      if (!isRecord(decoded) || decoded.version !== 1 || !Array.isArray(decoded.cleanups)) {
        throw new Error('invalid cleanup state');
      }
      return decoded.cleanups.filter(isPendingCleanup);
    } catch {
      this.latchBackgroundStorageFailure();
      throw new Error('Saved SayGM cleanup data could not be unlocked.');
    }
  }

  private async replacePendingCleanups(cleanups: PendingCleanup[]): Promise<void> {
    if (cleanups.length === 0) {
      await fs.rm(cleanupPath(), { force: true });
      this.statusRead = null;
      return;
    }
    const file = cleanupPath();
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const encrypted = this.encryptSecureData(JSON.stringify({ version: 1, cleanups }));
    const temporary = `${file}.tmp`;
    await fs.writeFile(temporary, encrypted, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temporary, file);
    this.statusRead = null;
  }

  retryPendingCleanup(acpTargets: GmAcpTarget[]): Promise<boolean> {
    if (this.cleanupRetry) return this.cleanupRetry;
    if (this.cleanupRetryFailureLatched || Date.now() < this.cleanupRetryAfter) {
      return Promise.resolve(false);
    }
    this.cleanupRetryAfter = Date.now() + CLEANUP_RETRY_COOLDOWN_MS;
    const request = this.runPendingCleanup(acpTargets)
      .catch((error: unknown) => {
        this.cleanupRetryFailureLatched = true;
        this.latchBackgroundStorageFailure();
        throw error;
      })
      .finally(() => {
        if (this.cleanupRetry === request) this.cleanupRetry = null;
      });
    this.cleanupRetry = request;
    return request;
  }

  private async runPendingCleanup(acpTargets: GmAcpTarget[]): Promise<boolean> {
    return this.exclusive(async () => {
      if (!(await this.backgroundSecureStorageReady())) return false;
      const cleanups = await this.readPendingCleanups();
      if (cleanups.length === 0) return false;
      const stored = await this.readCredentials(true).catch(() => null);
      if (this.backgroundStorageUnavailable) return false;
      const remaining: PendingCleanup[] = [];
      for (const cleanup of cleanups) {
        let current: PendingCleanup = { ...cleanup };
        const retainedKey = cleanupRetainsStoredModelKey(stored, current);
        if (retainedKey) {
          remaining.push(current);
          continue;
        }
        current.state = 'cleanup';
        const liveSession =
          stored?.mode === 'session' && stored.sessionId === current.sessionId ? stored : null;
        if (
          liveSession &&
          (current.accessToken !== liveSession.accessToken ||
            current.refreshToken !== liveSession.refreshToken)
        ) {
          try {
            const reconciled = await this.reconcileCleanupSessionTokens(liveSession, current, true);
            current = {
              ...current,
              accessToken: reconciled.accessToken,
              refreshToken: reconciled.refreshToken,
            };
          } catch {
            if (this.backgroundStorageUnavailable) return false;
            remaining.push(current);
            continue;
          }
        }
        if (!current.managedKeyRevoked && current.managedProviderKeyId) {
          try {
            const response = await sessionRequest(
              {
                mode: 'session',
                sessionId: current.sessionId,
                email: '',
                accessToken: current.accessToken,
                refreshToken: current.refreshToken,
                providerConfigured: true,
              },
              'DELETE',
              `/keys/${encodeURIComponent(current.managedProviderKeyId)}`,
              undefined,
              async (rotated) => {
                current = {
                  ...current,
                  accessToken: rotated.accessToken,
                  refreshToken: rotated.refreshToken,
                };
                await this.writePendingCleanup(current);
                if (stored?.mode === 'session' && stored.sessionId === current.sessionId) {
                  await this.persistRotatedTokens(
                    {
                      ...stored,
                      accessToken: rotated.accessToken,
                      refreshToken: rotated.refreshToken,
                    },
                    true,
                    stored
                  );
                }
              }
            );
            current = {
              ...current,
              accessToken: response.credentials.accessToken,
              refreshToken: response.credentials.refreshToken,
              managedKeyRevoked: response.status < 400 || response.status === 404,
            };
          } catch {
            // Keep the encrypted cleanup record for another attempt.
          }
        }
        if (
          !current.providerKeyCleared &&
          current.managedProviderKeyHash &&
          acpTargets.length > 0
        ) {
          const results = await Promise.allSettled(
            acpTargets.map((target) =>
              this.provider.clearApiKeyIfMatches(target, current.managedProviderKeyHash!)
            )
          );
          current.providerKeyCleared = results.every((result) => result.status === 'fulfilled');
        }
        if (current.revokeSession && !current.sessionRevoked && current.managedKeyRevoked) {
          try {
            const response = await oauthPost('revoke', {
              token: current.refreshToken,
              token_type_hint: 'refresh_token',
              client_id: CLIENT_ID,
            });
            current.sessionRevoked =
              response.status === 200 || errorFields(response.body).code === 'invalid_token';
          } catch {
            // Keep the encrypted cleanup record for another attempt.
          }
        }
        if (
          !current.managedKeyRevoked ||
          !current.providerKeyCleared ||
          (current.revokeSession && !current.sessionRevoked)
        ) {
          remaining.push(current);
        }
      }
      await this.replacePendingCleanups(remaining);
      return JSON.stringify(cleanups) !== JSON.stringify(remaining);
    });
  }

  private async deleteCredentialsIfSessionMatches(sessionId: string): Promise<void> {
    const credentials = await this.readCredentials().catch(() => null);
    if (credentials?.mode === 'session' && credentials.sessionId === sessionId) {
      await this.deleteCredentials();
    }
  }

  private async deleteCredentialsIfApiKeyMatches(sha256: string): Promise<void> {
    const credentials = await this.readCredentials().catch(() => null);
    if (credentials?.mode === 'api_key' && keyHash(credentials.key) === sha256) {
      await this.deleteCredentials();
    }
  }

  private isCurrentDeviceLogin(windowId: number, pending: PendingDeviceAuthorization): boolean {
    return (
      this.pendingLogins.get(windowId) === pending &&
      this.deviceGenerations.get(windowId) === pending.generation &&
      this.operationGeneration === pending.operationGeneration
    );
  }

  private bumpDeviceGeneration(windowId: number): number {
    const next = (this.deviceGenerations.get(windowId) ?? 0) + 1;
    this.deviceGenerations.set(windowId, next);
    return next;
  }

  private invalidateDeviceLogins(): void {
    for (const windowId of this.deviceGenerations.keys()) this.bumpDeviceGeneration(windowId);
    this.pendingLogins.clear();
  }

  private invalidateOtherDeviceLogins(exceptWindowId: number): void {
    for (const windowId of this.deviceGenerations.keys()) {
      if (windowId !== exceptWindowId) this.bumpDeviceGeneration(windowId);
    }
    for (const windowId of this.pendingLogins.keys()) {
      if (windowId !== exceptWindowId) this.pendingLogins.delete(windowId);
    }
  }

  private async persistRotatedTokens(
    rotated: SessionCredentials,
    storageAlreadyChecked = false,
    knownCredentials?: StoredCredentials
  ): Promise<void> {
    const stored = knownCredentials ?? (await this.readCredentials(storageAlreadyChecked));
    if (stored?.mode !== 'session' || stored.sessionId !== rotated.sessionId) {
      throw new Error('The SayGM session changed while refreshing its credentials.');
    }
    const cleanups = await this.readPendingCleanups();
    const cleanup = cleanups.find((item) => item.sessionId === rotated.sessionId);
    if (
      cleanup &&
      (cleanup.accessToken !== rotated.accessToken || cleanup.refreshToken !== rotated.refreshToken)
    ) {
      await this.replacePendingCleanups(
        cleanups.map((item) =>
          item.sessionId === rotated.sessionId
            ? { ...item, accessToken: rotated.accessToken, refreshToken: rotated.refreshToken }
            : item
        )
      );
    }
    await this.writeCredentials({ ...stored, ...rotated }, storageAlreadyChecked);
  }

  private assertOperationCurrent(generation: number): void {
    if (this.operationGeneration !== generation) {
      throw new Error('The SayGM connection was cancelled.');
    }
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.lock;
    this.lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

export const TOPUP_URL = SAYGM_PRODUCT.creditsUrl;

async function oauthPost(pathname: string, values: Record<string, string>): Promise<JsonResponse> {
  return requestJson(`${ACCOUNT_API}/oauth/${pathname}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: new URLSearchParams(values).toString(),
  });
}

async function revokeRefreshToken(token: string): Promise<void> {
  const response = await oauthPost('revoke', {
    token,
    token_type_hint: 'refresh_token',
    client_id: CLIENT_ID,
  });
  if (response.status !== 200) throw accountError(response, 'revoke the SayGM session');
}

function isInvalidGrantResponse(response: JsonResponse): boolean {
  return errorFields(response.body).code === 'invalid_grant';
}

async function sessionRequest(
  credentials: SessionCredentials,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  pathname: string,
  body?: unknown,
  onTokenRotation?: (credentials: SessionCredentials) => Promise<void>,
  beforeRetry?: () => void,
  options: SessionRequestOptions = {}
): Promise<JsonResponse & { credentials: SessionCredentials }> {
  let current = credentials;
  let response = await sendSessionRequest(current, method, pathname, body, options);
  if (response.status === 401) {
    const rotated = await oauthPost('token', {
      grant_type: 'refresh_token',
      refresh_token: current.refreshToken,
      client_id: CLIENT_ID,
    });
    if (rotated.status !== 200) {
      const { code } = errorFields(rotated.body);
      if (code === 'invalid_grant') throw new Error('Your SayGM session expired. Sign in again.');
      throw accountError(rotated, 'refresh the SayGM session');
    }
    const tokens = parseTokens(rotated.body);
    current = {
      ...current,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
    };
    await onTokenRotation?.(current);
    beforeRetry?.();
    response = await sendSessionRequest(current, method, pathname, body, options);
  }
  if (response.status === 401) throw new Error('Your SayGM session expired. Sign in again.');
  if (response.status >= 400) return { ...response, credentials: current };
  return { ...response, credentials: current };
}

async function sendSessionRequest(
  credentials: SessionCredentials,
  method: string,
  pathname: string,
  body?: unknown,
  options: SessionRequestOptions = {}
): Promise<JsonResponse> {
  return requestJson(
    `${ACCOUNT_API}${pathname}`,
    {
      method,
      headers: {
        authorization: `Bearer ${credentials.accessToken}`,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(options.redirect === undefined ? {} : { redirect: options.redirect }),
      ...(options.cache === undefined ? {} : { cache: options.cache }),
    },
    options.timeoutMs
  );
}

async function keyBalance(key: string): Promise<{ usd: string }> {
  const response = await requestJson(`${GATEWAY_API}/credits`, {
    headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
  });
  if (response.status !== 200) {
    if (response.status === 401) throw new Error('SayGM rejected this API key.');
    throw gatewayError(response);
  }
  const balance =
    isRecord(response.body) && isRecord(response.body.balance) ? response.body.balance : null;
  if (!balance || typeof balance.usd !== 'string' || typeof balance.nano_usd !== 'number') {
    throw new Error('The SayGM gateway returned an unexpected balance.');
  }
  return { usd: balance.usd };
}

async function saveProviderKeyToTargets(
  provider: GmProviderBridge,
  targets: GmAcpTarget[],
  key: string
): Promise<void> {
  const results = await Promise.allSettled(
    targets.map((target) => provider.saveApiKey(target, key))
  );
  const failure = results.find((result) => result.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
}

async function requestJson(
  url: string,
  init: FetchInit = {},
  timeoutMs = REQUEST_TIMEOUT_MS
): Promise<JsonResponse> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new Error('Could not reach SayGM. Check your connection and try again.');
  }
  const raw = await response.text();
  let body: unknown = null;
  if (raw) {
    try {
      body = JSON.parse(raw) as unknown;
    } catch {
      body = null;
    }
  }
  return { status: response.status, body };
}

function parseDeviceAuthorization(body: unknown): DeviceAuthorization {
  if (!isRecord(body)) throw new Error('SayGM returned an unexpected device sign-in response.');
  const deviceCode = stringField(body, 'device_code');
  const userCode = stringField(body, 'user_code');
  const verificationUri = stringField(body, 'verification_uri');
  const expiresIn = body.expires_in;
  const interval = body.interval;
  if (
    !deviceCode ||
    !userCode ||
    !verificationUri ||
    typeof expiresIn !== 'number' ||
    expiresIn <= 0
  ) {
    throw new Error('SayGM returned an unexpected device sign-in response.');
  }
  const complete = stringField(body, 'verification_uri_complete');
  return {
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: trustedVerificationUri(verificationUri),
    ...(complete ? { verification_uri_complete: trustedVerificationUri(complete) } : {}),
    expires_in: Math.min(expiresIn, 1800),
    interval:
      typeof interval === 'number' && interval > 0
        ? Math.min(interval, 60)
        : DEFAULT_POLL_INTERVAL_SECONDS,
  };
}

function parseTokens(body: unknown): TokenResponse {
  if (
    isRecord(body) &&
    typeof body.access_token === 'string' &&
    typeof body.refresh_token === 'string' &&
    typeof body.session_id === 'string'
  ) {
    return {
      access_token: body.access_token,
      refresh_token: body.refresh_token,
      session_id: body.session_id,
    };
  }
  throw new Error('SayGM returned an unexpected session response.');
}

function parseCapabilities(value: unknown): GmCapabilities {
  if (!isRecord(value) || value.contract_version !== 1 || !Array.isArray(value.operations)) {
    throw new Error(
      'SayGM returned an unexpected capability response. Guardrail changes are unavailable.'
    );
  }
  const operations = value.operations.map((entry): GmOAuthCapability => {
    if (
      !isRecord(entry) ||
      typeof entry.operation_id !== 'string' ||
      typeof entry.method !== 'string' ||
      typeof entry.path !== 'string' ||
      (entry.adapter_support !== 'supported' && entry.adapter_support !== 'not_supported') ||
      entry.entitlement_state !== 'unknown' ||
      entry.dependency_state !== 'unknown' ||
      !(entry.available === null || typeof entry.available === 'boolean') ||
      !(entry.availability_reason === null || typeof entry.availability_reason === 'string')
    ) {
      throw new Error(
        'SayGM returned an unexpected capability response. Guardrail changes are unavailable.'
      );
    }
    return {
      operation_id: entry.operation_id,
      method: entry.method,
      path: entry.path,
      adapter_support: entry.adapter_support,
      entitlement_state: entry.entitlement_state,
      dependency_state: entry.dependency_state,
      available: entry.available,
      availability_reason: entry.availability_reason,
    };
  });
  return { contract_version: 1, operations };
}

function assertOperationCapability(capabilities: GmCapabilities, operationId: string): void {
  const capability = capabilities.operations.find((item) => item.operation_id === operationId);
  if (!capability) return;
  if (capability.adapter_support !== 'supported') {
    throw new Error(
      `SayGM does not report ${operationId} as deployed. Your account and key remain unchanged.`
    );
  }
  if (capability.available === false) {
    throw new Error(
      `SayGM reports ${operationId} as unavailable. Your account and key remain unchanged.`
    );
  }
}

function capabilitiesError(response: JsonResponse): Error {
  if (response.status === 404) {
    return new Error(
      'SayGM capability discovery is unavailable (account service HTTP 404). Guardrails remain unavailable; your account and managed key are unchanged.'
    );
  }
  return new Error(
    `Could not check SayGM account capabilities (account service HTTP ${response.status}). Your account and managed key are unchanged.`
  );
}

function trustedVerificationUri(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('SayGM returned an invalid sign-in link.');
  }
  if (
    url.protocol !== 'https:' ||
    !SAYGM_PRODUCT.trustedSignInHosts.some((host) => host === url.hostname) ||
    url.username ||
    url.password
  ) {
    throw new Error('SayGM returned an untrusted sign-in link.');
  }
  return url.toString();
}

function secureStorageReady(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false;
  try {
    return safeStorage.getSelectedStorageBackend() !== 'basic_text';
  } catch {
    return true;
  }
}

function credentialsPath(): string {
  return path.join(app.getPath('userData'), CREDENTIALS_FILE);
}

function cleanupPath(): string {
  return path.join(app.getPath('userData'), SAYGM_PRODUCT.cleanupCredentialsFile);
}

function legacyKeyCleanupPath(): string {
  return path.join(app.getPath('userData'), LEGACY_KEY_CLEANUP_FILE);
}

function statusFor(
  credentials: StoredCredentials | null,
  secureStorageAvailable: boolean,
  managedKeyBrokerEnabled: boolean
): GmAccountStatus {
  if (!credentials) {
    return {
      connected: false,
      mode: null,
      email: null,
      keyPrefix: null,
      providerConfigured: false,
      secureStorageAvailable,
      remoteCleanupPending: false,
      managedKeyAvailable: false,
      legacyKeyCleanupPending: false,
    };
  }
  if (credentials.mode === 'api_key') {
    const providerConfigured = !managedKeyBrokerEnabled
      ? credentials.providerConfigured
      : activeModelKeyMatches(credentials, keyHash(credentials.key));
    return {
      connected: true,
      mode: 'api_key',
      email: null,
      keyPrefix: credentials.keyPrefix,
      providerConfigured,
      secureStorageAvailable,
      remoteCleanupPending: false,
      managedKeyAvailable: false,
      legacyKeyCleanupPending: false,
    };
  }
  return {
    connected: true,
    mode: 'session',
    email: credentials.email || null,
    keyPrefix: null,
    providerConfigured: !managedKeyBrokerEnabled
      ? credentials.providerConfigured
      : activeModelKeyMatches(credentials, credentials.managedProviderKeyHash ?? ''),
    secureStorageAvailable,
    remoteCleanupPending: false,
    legacyKeyCleanupPending: false,
    managedKeyAvailable: !managedKeyBrokerEnabled
      ? credentials.providerConfigured &&
        typeof credentials.managedProviderKeyId === 'string' &&
        typeof credentials.managedProviderKeyHash === 'string'
      : activeModelKeyMatches(credentials, credentials.managedProviderKeyHash ?? '') &&
        typeof credentials.managedProviderKeyId === 'string' &&
        typeof credentials.managedProviderKeyHash === 'string' &&
        typeof credentials.managedProviderKey === 'string' &&
        keyHash(credentials.managedProviderKey) === credentials.managedProviderKeyHash,
  };
}

function cleanupRetainsStoredModelKey(
  credentials: StoredCredentials | null,
  cleanup: PendingCleanup
): boolean {
  const sameOwnedKey =
    credentials?.mode === 'session' &&
    credentials.sessionId === cleanup.sessionId &&
    credentials.managedProviderKeyId === cleanup.managedProviderKeyId &&
    credentials.managedProviderKeyHash === cleanup.managedProviderKeyHash;
  if (
    !sameOwnedKey ||
    cleanup.revokeSession ||
    cleanup.managedKeyRevoked ||
    credentials?.mode !== 'session' ||
    credentials.managedProviderKeyState === 'disabled'
  ) {
    return false;
  }
  return (
    credentials.providerConfigured ||
    credentials.managedProviderKeyState === 'pending' ||
    (typeof credentials.managedProviderKey === 'string' &&
      keyHash(credentials.managedProviderKey) === credentials.managedProviderKeyHash)
  );
}

function stagedModelKey(credentials: StoredCredentials): string | null {
  if (credentials.mode === 'api_key') {
    return credentials.keyAuthorityState === 'disabled' ? null : credentials.key;
  }
  if (
    credentials.managedProviderKeyState === 'disabled' ||
    !credentials.managedProviderKey ||
    !credentials.managedProviderKeyHash ||
    keyHash(credentials.managedProviderKey) !== credentials.managedProviderKeyHash
  ) {
    return null;
  }
  return credentials.managedProviderKey;
}

function activeModelKeyMatches(credentials: StoredCredentials, sha256: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(sha256) || !credentials.providerConfigured) return false;
  if (credentials.mode === 'api_key') {
    return (
      credentials.keyAuthorityState !== 'disabled' &&
      (credentials.keyAuthorityState === undefined || credentials.keyAuthorityState === 'active') &&
      keyHash(credentials.key) === sha256
    );
  }
  return (
    credentials.managedProviderKeyState !== 'disabled' &&
    (credentials.managedProviderKeyState === undefined ||
      credentials.managedProviderKeyState === 'active') &&
    typeof credentials.managedProviderKey === 'string' &&
    typeof credentials.managedProviderKeyHash === 'string' &&
    credentials.managedProviderKeyHash === sha256 &&
    keyHash(credentials.managedProviderKey) === sha256
  );
}

function disableModelKeyAuthority(credentials: StoredCredentials): StoredCredentials {
  return credentials.mode === 'api_key'
    ? { ...credentials, providerConfigured: false, keyAuthorityState: 'disabled' }
    : { ...credentials, providerConfigured: false, managedProviderKeyState: 'disabled' };
}

function accountError(response: JsonResponse, action: string): Error {
  const { code } = errorFields(response.body);
  if (code === 'invalid_client') {
    return new Error('Desktop sign-in is not enabled yet. Use an API key or try again later.');
  }
  if (code === 'access_denied') return new Error('Sign-in was denied in the browser.');
  if (code === 'expired_token')
    return new Error('The sign-in code expired. Start again for a new code.');
  return new Error(`Could not ${action} (SayGM account service HTTP ${response.status}).`);
}

function guardrailsError(response: JsonResponse, action: string): Error {
  const { code } = errorFields(response.body);
  if (response.status === 403 && code === 'insufficient_scope') {
    return new Error(
      'This SayGM account is not allowed to manage these guardrails. Your current account and managed key remain connected.'
    );
  }
  return accountError(response, action);
}

function validatePreviewRequest(
  scannerId: GmGuardrailsPreviewScannerId,
  scanners: GmGuardrailsPolicyBody,
  text: string,
  expectedContext: string
): void {
  const supportedModes: Record<GmGuardrailsPreviewScannerId, readonly string[]> = {
    'native:pii': ['redact', 'redact-restore', 'block'],
    'native:secrets': ['redact', 'redact-restore', 'block'],
    'native:regex': ['redact', 'redact-restore', 'block'],
    'native:ban-substrings': ['redact', 'block'],
  };
  if (
    !Object.prototype.hasOwnProperty.call(supportedModes, scannerId) ||
    !isRecord(scanners) ||
    Object.keys(scanners).length !== 1
  ) {
    throw new Error('Choose one configured text scanner to preview.');
  }
  const configValue = scanners[scannerId];
  const config = isRecord(configValue) ? configValue : null;
  if (!config || !supportedModes[scannerId].includes(String(config.mode))) {
    throw new Error('This scanner is not configured for a preview.');
  }
  if (typeof text !== 'string' || text.length === 0) {
    throw new Error('Enter sample text before running a preview.');
  }
  if (Buffer.byteLength(text, 'utf8') > GUARDRAIL_PREVIEW_MAX_TEXT_BYTES) {
    throw new Error('Sample text must be 128 KiB or smaller.');
  }
  let configJson: string;
  let requestJson: string;
  try {
    configJson = JSON.stringify(config);
    requestJson = JSON.stringify({ scanners, text });
  } catch {
    throw new Error('This preview request contains an unsupported value.');
  }
  if (Buffer.byteLength(configJson, 'utf8') > GUARDRAIL_PREVIEW_MAX_CONFIG_BYTES) {
    throw new Error('This scanner configuration is too large to preview. Save is still available.');
  }
  if (Buffer.byteLength(requestJson, 'utf8') > GUARDRAIL_PREVIEW_MAX_BODY_BYTES) {
    throw new Error(
      'This preview request is too large. Shorten the sample or reduce the configuration.'
    );
  }
  if (!/^[a-f0-9]{64}$/.test(expectedContext)) {
    throw new Error('Reload the saved guardrails before running a preview.');
  }
}

function guardrailsPreviewError(response: JsonResponse): Error {
  const { code } = errorFields(response.body);
  if (response.status === 403 && code === 'insufficient_scope') {
    return new Error(
      'This SayGM account is not allowed to preview these guardrails. Your current account and managed key remain connected.'
    );
  }
  if (response.status === 429 || code === 'preview_busy') {
    return new Error('The preview service is busy. Wait a moment and try again.');
  }
  if (response.status === 408 || code === 'preview_read_timeout') {
    return new Error('The preview request took too long. Try a shorter sample.');
  }
  if (response.status === 413 || code === 'request_too_large') {
    return new Error(
      'This preview request is too large. Shorten the sample or reduce the configuration.'
    );
  }
  if (response.status === 503 || code === 'ums_unavailable' || code === 'upstream_unavailable') {
    return new Error(
      'SayGM could not validate this preview right now. Your current account and managed key remain connected.'
    );
  }
  if (response.status === 404) {
    return new Error(
      'SayGM could not confirm the scanner preview route (account service HTTP 404). Your current account and managed key remain connected.'
    );
  }
  if (code === 'preview_policy_unavailable') {
    return new Error(
      'SayGM could not build this scanner from the current draft. Check the rules and mode.'
    );
  }
  if (code === 'preview_echo_too_large') {
    return new Error(
      'This sample produced too many replacements to display. Shorten it or reduce matches.'
    );
  }
  return new Error(
    `Could not run the SayGM scanner preview (account service HTTP ${response.status}).`
  );
}

function parseGuardrailsPreviewResponse(value: unknown): GmGuardrailsPreviewResponse {
  if (
    !isRecord(value) ||
    typeof value.blocked !== 'boolean' ||
    !(value.blocked_by === null || typeof value.blocked_by === 'string') ||
    !(value.forwarded_text === null || typeof value.forwarded_text === 'string') ||
    !(value.returned_text === null || typeof value.returned_text === 'string') ||
    !isCountMap(value.by_entity_type) ||
    !Array.isArray(value.not_run) ||
    !value.not_run.every((item) => typeof item === 'string') ||
    !isRecord(value.per_scanner)
  ) {
    throw new Error('The SayGM account service returned an unexpected scanner preview.');
  }
  const perScanner = Object.create(null) as GmGuardrailsPreviewResponse['per_scanner'];
  for (const [scannerId, item] of Object.entries(value.per_scanner)) {
    if (
      !isRecord(item) ||
      !isCount(item.detections) ||
      !isCount(item.redacted) ||
      !isCount(item.restored) ||
      !isCount(item.blocked) ||
      !isCountMap(item.by_entity_type)
    ) {
      throw new Error('The SayGM account service returned an unexpected scanner preview.');
    }
    perScanner[scannerId] = {
      detections: item.detections,
      redacted: item.redacted,
      restored: item.restored,
      blocked: item.blocked,
      by_entity_type: item.by_entity_type,
    };
  }
  return {
    blocked: value.blocked,
    blocked_by: value.blocked_by,
    forwarded_text: value.forwarded_text,
    returned_text: value.returned_text,
    per_scanner: perScanner,
    by_entity_type: value.by_entity_type,
    not_run: value.not_run as string[],
  };
}

function isCountMap(value: unknown): value is Record<string, number> {
  return isRecord(value) && Object.values(value).every(isCount);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function deviceGrantError(response: JsonResponse): Error {
  const { code } = errorFields(response.body);
  if (code === 'access_denied') return new Error('Sign-in was denied in the browser.');
  if (code === 'expired_token')
    return new Error('The sign-in code expired. Start again for a new code.');
  return accountError(response, 'complete sign-in');
}

function gatewayError(response: JsonResponse): Error {
  return new Error(`Could not read SayGM credits (gateway HTTP ${response.status}).`);
}

function errorFields(body: unknown): { code: string | undefined } {
  if (!isRecord(body)) return { code: undefined };
  const nestedError = isRecord(body.error) ? body.error : null;
  const code =
    typeof body.error === 'string'
      ? body.error
      : typeof nestedError?.code === 'string'
        ? nestedError.code
        : body.code;
  return { code: typeof code === 'string' ? code : undefined };
}

function parseGuardrailsResponse(value: unknown, allowNull = true): GmGuardrailsPolicyBody | null {
  if (!isRecord(value) || !Object.prototype.hasOwnProperty.call(value, 'body')) {
    throw new Error('The SayGM account service returned an unexpected guardrail policy.');
  }
  const body = value.body;
  if (body === null ? !allowNull : !isRecord(body)) {
    throw new Error('The SayGM account service returned an unexpected guardrail policy.');
  }
  return body as GmGuardrailsPolicyBody | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStoredCredentials(value: unknown): value is StoredCredentials {
  if (!isRecord(value) || value.version !== 1) return false;
  if (value.mode === 'session') {
    return (
      typeof value.sessionId === 'string' &&
      typeof value.email === 'string' &&
      typeof value.accessToken === 'string' &&
      typeof value.refreshToken === 'string' &&
      typeof value.providerConfigured === 'boolean' &&
      (value.managedProviderKey === undefined || typeof value.managedProviderKey === 'string') &&
      (value.managedProviderKeyState === undefined ||
        ['pending', 'active', 'disabled'].includes(value.managedProviderKeyState as string))
    );
  }
  return (
    value.mode === 'api_key' &&
    typeof value.key === 'string' &&
    typeof value.keyPrefix === 'string' &&
    typeof value.providerConfigured === 'boolean' &&
    (value.keyAuthorityState === undefined ||
      ['pending', 'active', 'disabled'].includes(value.keyAuthorityState as string))
  );
}

function isPendingCleanup(value: unknown): value is PendingCleanup {
  return (
    isRecord(value) &&
    typeof value.sessionId === 'string' &&
    typeof value.accessToken === 'string' &&
    typeof value.refreshToken === 'string' &&
    typeof value.revokeSession === 'boolean' &&
    typeof value.sessionRevoked === 'boolean' &&
    typeof value.managedKeyRevoked === 'boolean' &&
    typeof value.providerKeyCleared === 'boolean' &&
    (value.state === 'cleanup' || value.state === 'active') &&
    (value.managedProviderKeyId === undefined || typeof value.managedProviderKeyId === 'string') &&
    (value.managedProviderKeyHash === undefined || typeof value.managedProviderKeyHash === 'string')
  );
}

function stringField(body: Record<string, unknown>, key: string): string | undefined {
  return typeof body[key] === 'string' ? (body[key] as string) : undefined;
}

function keyHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function guardrailsContext(
  credentials: SessionCredentials,
  body: GmGuardrailsPolicyBody | null
): string {
  return createHash('sha256')
    .update(credentials.sessionId, 'utf8')
    .update('\0', 'utf8')
    .update(credentials.managedProviderKeyId ?? '', 'utf8')
    .update('\0', 'utf8')
    .update(stableJson(body), 'utf8')
    .digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function safeReason(error: unknown): string {
  return error instanceof Error ? error.message : 'Try again.';
}

function missingManagedKeyRecoveryError(): Error {
  return new Error(
    'SayGM found an active model key, but its encrypted secret is missing or does not match. Sign out, then reconnect to replace it safely.'
  );
}

function isNodeError(error: unknown): error is Error & { code: string } {
  return error instanceof Error && 'code' in error && typeof error.code === 'string';
}
