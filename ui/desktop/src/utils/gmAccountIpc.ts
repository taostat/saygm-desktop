import { app, BrowserWindow, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { methods, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import { createWebSocketStream } from '@agentclientprotocol/sdk/experimental/ws-client';
import type { RefreshProviderInventoryResponse_unstable } from '@aaif/goose-acp-client';
import { connectGooseAcpClient, type GooseAcpCallbacks } from '../acp/gooseAcpClient';
import { createPinnedLocalWebSocketConstructor } from '../acp/pinnedLocalWebSocket';
import { isLoopbackAcpWebSocketUrl } from '../acp/url';
import type { GmAcpTarget, GmProviderBridge } from '../services/gmAccountService';
import { GmAccountService, TOPUP_URL } from '../services/gmAccountService';
import type { GmGuardrailsPolicyBody, GmGuardrailsPreviewScannerId } from '../types/gmAccount';
import { SAYGM_PRODUCT } from '../product/saygmProduct';

type GmAccountIpcDependencies = {
  requireRegularRendererWindow: (event: IpcMainInvokeEvent) => BrowserWindow;
  getRegularWindows: () => BrowserWindow[];
  getAcpTargetForWindow: (windowId: number) => GmAcpTarget | null;
  getActiveAcpTargets: () => GmAcpTarget[];
};

const callbacks: GooseAcpCallbacks = {
  requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
  sessionUpdate: async () => undefined,
  createElicitation: async () => ({ action: 'cancel' }),
  unstable_sessionRecipeRequestParams: async () => ({ action: 'cancel' }),
  unstable_sessionUpdate: async () => undefined,
  unstable_providerDeviceCode: async () => undefined,
};

const provider: GmProviderBridge = {
  saveApiKey: async (target, key) =>
    withAcpClient(target, async ({ goose }) => {
      const { refresh } = await goose.providersConfigSave_unstable({
        providerId: SAYGM_PRODUCT.providerId,
        fields: [{ key: SAYGM_PRODUCT.providerApiKeyField, value: key }],
      });
      await waitForSaygmInventory(goose, refresh);
    }),
  clearApiKeyIfMatches: async (target, sha256) =>
    withAcpClient(target, async ({ connection, goose }) => {
      const response: unknown = await connection.agent.request(
        '_goose/unstable/providers/secrets/delete-if-sha256-matches',
        {
          providerId: SAYGM_PRODUCT.providerId,
          key: SAYGM_PRODUCT.providerApiKeyField,
          expectedSha256: sha256,
        }
      );
      if (isRecord(response) && response.deleted === true) {
        await goose.providersInventoryRefresh_unstable({
          providerIds: [SAYGM_PRODUCT.providerId],
        });
      }
    }),
  clearLegacyApiKeyIfMatches: async (target, sha256) =>
    withAcpClient(target, async ({ connection }) => {
      const response: unknown = await connection.agent.request(
        '_goose/unstable/providers/secrets/delete-legacy-if-sha256-matches',
        {
          providerId: SAYGM_PRODUCT.providerId,
          key: SAYGM_PRODUCT.providerApiKeyField,
          expectedSha256: sha256,
        }
      );
      if (!isRecord(response) || typeof response.deleted !== 'boolean') {
        throw new Error('The local SayGM service returned an invalid legacy-key cleanup response.');
      }
      return response.deleted;
    }),
};

const account = new GmAccountService(provider, process.platform === 'darwin');
const lifecycleWindows = new Set<number>();

export async function initializeGmAccountModelKeyAuthority(): Promise<void> {
  await account.initializeManagedModelKeyAuthority();
}

export const gmAccountModelKeyBroker = {
  readManagedModelKeyForBackend: () => account.readManagedModelKeyForBackend(),
  managedModelKeyMatchesForBackend: (sha256: string) =>
    account.managedModelKeyMatchesForBackend(sha256),
};

export function registerGmAccountIpcHandlers(dependencies: GmAccountIpcDependencies): void {
  ipcMain.handle('gm-account:get-status', (event) => {
    const windowId = requireWindowId(event, dependencies);
    bindWindowLifecycle(windowId);
    void account
      .retryPendingCleanup(localAcpTargets(dependencies.getActiveAcpTargets()))
      .then((changed) => {
        if (changed) broadcastAccountChanged(dependencies);
      })
      .catch(() => undefined);
    return account.getStatus();
  });
  ipcMain.handle('gm-account:get-balance', (event) => {
    bindWindowLifecycle(requireWindowId(event, dependencies));
    return account.getBalance();
  });
  ipcMain.handle('gm-account:get-capabilities', (event) => {
    bindWindowLifecycle(requireWindowId(event, dependencies));
    return account.getCapabilities();
  });
  ipcMain.handle('gm-account:get-guardrails', (event) => {
    bindWindowLifecycle(requireWindowId(event, dependencies));
    return account.getGuardrails();
  });
  ipcMain.handle('gm-account:preview-guardrails', (event, payload: unknown) => {
    bindWindowLifecycle(requireWindowId(event, dependencies));
    if (
      !isRecord(payload) ||
      !isRecord(payload.scanners) ||
      typeof payload.text !== 'string' ||
      typeof payload.context !== 'string' ||
      typeof payload.scannerId !== 'string' ||
      !['native:pii', 'native:secrets', 'native:regex', 'native:ban-substrings'].includes(
        payload.scannerId
      )
    ) {
      throw new Error('The scanner preview request is invalid.');
    }
    if (!/^[a-f0-9]{64}$/.test(payload.context)) {
      throw new Error('Reload the saved guardrails before running a preview.');
    }
    return account.previewGuardrails(
      payload.scannerId as GmGuardrailsPreviewScannerId,
      payload.scanners as GmGuardrailsPolicyBody,
      payload.text,
      payload.context
    );
  });
  ipcMain.handle('gm-account:save-guardrails', async (event, payload: unknown) => {
    const windowId = requireWindowId(event, dependencies);
    bindWindowLifecycle(windowId);
    if (!isRecord(payload) || !isRecord(payload.body) || typeof payload.context !== 'string') {
      throw new Error('The guardrail policy is invalid. Reload guardrails and try again.');
    }
    if (!/^[a-f0-9]{64}$/.test(payload.context)) {
      throw new Error('The guardrail policy session is invalid. Reload guardrails and try again.');
    }
    let serialized: string;
    try {
      serialized = JSON.stringify(payload.body);
    } catch {
      throw new Error('The guardrail policy is invalid.');
    }
    if (serialized.length > 65_536) throw new Error('The guardrail policy is too large.');
    const result = await account.saveGuardrails(
      payload.body as GmGuardrailsPolicyBody,
      payload.context as string
    );
    broadcastGuardrailsChanged(dependencies, windowId);
    return result;
  });
  ipcMain.handle('gm-account:begin-device-login', async (event) => {
    const windowId = requireWindowId(event, dependencies);
    bindWindowLifecycle(windowId);
    accountAcpTargets(dependencies, windowId);
    return account.beginDeviceLogin(windowId);
  });
  ipcMain.handle('gm-account:poll-device-login', async (event) => {
    const windowId = requireWindowId(event, dependencies);
    bindWindowLifecycle(windowId);
    return runAndNotify(
      () => account.pollDeviceLogin(windowId, accountAcpTargets(dependencies, windowId)),
      dependencies,
      (result) => result.status === 'connected'
    );
  });
  ipcMain.handle('gm-account:cancel-device-login', (event) => {
    const windowId = requireWindowId(event, dependencies);
    bindWindowLifecycle(windowId);
    account.cancelDeviceLogin(windowId);
  });
  ipcMain.handle('gm-account:open-device-verification', async (event) => {
    const windowId = requireWindowId(event, dependencies);
    bindWindowLifecycle(windowId);
    const url = account.deviceVerificationUri(windowId);
    await shell.openExternal(url);
  });
  ipcMain.handle('gm-account:connect-api-key', async (event, key: unknown) => {
    if (typeof key !== 'string') throw new Error('Enter a valid SayGM API key.');
    const windowId = requireWindowId(event, dependencies);
    bindWindowLifecycle(windowId);
    return runAndNotify(
      () => account.connectApiKey(key, accountAcpTargets(dependencies, windowId)),
      dependencies
    );
  });
  ipcMain.handle('gm-account:finish-provider-setup', async (event) => {
    const windowId = requireWindowId(event, dependencies);
    bindWindowLifecycle(windowId);
    return runAndNotify(
      () => account.finishProviderSetup(accountAcpTargets(dependencies, windowId)),
      dependencies
    );
  });
  ipcMain.handle('gm-account:logout', async (event) => {
    const windowId = requireWindowId(event, dependencies);
    bindWindowLifecycle(windowId);
    const targets = localAcpTargets(dependencies.getActiveAcpTargets());
    const result = await runAndNotify(() => account.logout(targets), dependencies);
    if (result.warning) throw new Error(result.warning);
  });
  ipcMain.handle('gm-account:clear-legacy-api-key', async (event) => {
    const windowId = requireWindowId(event, dependencies);
    bindWindowLifecycle(windowId);
    const targets = localAcpTargets(dependencies.getActiveAcpTargets());
    return runAndNotify(() => account.clearLegacyApiKey(targets), dependencies);
  });
  ipcMain.handle('gm-account:open-topup', async (event) => {
    bindWindowLifecycle(requireWindowId(event, dependencies));
    await shell.openExternal(TOPUP_URL);
  });
}

function accountAcpTargets(
  dependencies: GmAccountIpcDependencies,
  windowId: number
): GmAcpTarget[] {
  const current = dependencies.getAcpTargetForWindow(windowId);
  if (!current || !isLocalAcp(current.url)) {
    throw new Error('Connect SayGM from a local Goose backend to store its model key securely.');
  }
  const targets = localAcpTargets(dependencies.getActiveAcpTargets());
  if (!targets.some((target) => target.url === current.url)) targets.unshift(current);
  return targets;
}

function localAcpTargets(targets: GmAcpTarget[]): GmAcpTarget[] {
  return [
    ...new Map(
      targets.filter((target) => isLocalAcp(target.url)).map((target) => [target.url, target])
    ).values(),
  ];
}

function isLocalAcp(url: string): boolean {
  try {
    return isLoopbackAcpWebSocketUrl(url);
  } catch {
    return false;
  }
}

function requireWindowId(
  event: IpcMainInvokeEvent,
  dependencies: GmAccountIpcDependencies
): number {
  const window = dependencies.requireRegularRendererWindow(event);
  if (window.isDestroyed()) throw new Error('The Goose window is unavailable.');
  return window.id;
}

function bindWindowLifecycle(windowId: number): void {
  if (lifecycleWindows.has(windowId)) return;
  const window = BrowserWindow.fromId(windowId);
  if (!window || window.isDestroyed()) throw new Error('The Goose window is unavailable.');
  lifecycleWindows.add(windowId);
  window.once('closed', () => {
    lifecycleWindows.delete(windowId);
    account.cancelDeviceLogin(windowId);
  });
}

async function runAndNotify<T>(
  operation: () => Promise<T>,
  dependencies: GmAccountIpcDependencies,
  notifyOnSuccess: (result: T) => boolean = () => true
): Promise<T> {
  try {
    const result = await operation();
    if (notifyOnSuccess(result)) broadcastAccountChanged(dependencies);
    return result;
  } catch (error) {
    broadcastAccountChanged(dependencies);
    throw error;
  }
}

function broadcastAccountChanged(dependencies: GmAccountIpcDependencies): void {
  for (const window of dependencies.getRegularWindows()) {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send('gm-account:changed');
    }
  }
}

function broadcastGuardrailsChanged(
  dependencies: GmAccountIpcDependencies,
  originWindowId: number
): void {
  for (const window of dependencies.getRegularWindows()) {
    if (
      window.id !== originWindowId &&
      !window.isDestroyed() &&
      !window.webContents.isDestroyed()
    ) {
      window.webContents.send('gm-account:guardrails-changed');
    }
  }
}

async function withAcpClient<T>(
  target: GmAcpTarget,
  operation: (client: ReturnType<typeof connectGooseAcpClient>) => Promise<T>
): Promise<T> {
  if (!isLocalAcp(target.url)) {
    throw new Error('SayGM account keys can only be stored in a local Goose backend.');
  }
  if (!target.certificateFingerprint) {
    throw new Error('The local Goose backend does not have a trusted TLS certificate pin.');
  }
  const stream = createWebSocketStream(target.url, {
    protocols: [],
    WebSocket: createPinnedLocalWebSocketConstructor(target.certificateFingerprint),
  });
  const client = connectGooseAcpClient(stream, callbacks);
  try {
    await client.connection.agent.request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { elicitation: { form: {} } },
      clientInfo: { name: SAYGM_PRODUCT.providerKeyName, version: app.getVersion() },
    });
    return await operation(client);
  } finally {
    client.connection.close();
  }
}

async function waitForSaygmInventory(
  goose: ReturnType<typeof connectGooseAcpClient>['goose'],
  refresh: RefreshProviderInventoryResponse_unstable
): Promise<void> {
  const deadline = Date.now() + 30_000;
  const shouldWait =
    refresh.started.includes(SAYGM_PRODUCT.providerId) ||
    refresh.skipped?.some(
      (skip) => skip.providerId === SAYGM_PRODUCT.providerId && skip.reason === 'already_refreshing'
    );

  while (true) {
    const { entries } = await goose.providersList_unstable({
      providerIds: [SAYGM_PRODUCT.providerId],
    });
    const entry = entries.find((candidate) => candidate.providerId === SAYGM_PRODUCT.providerId);
    if (!entry) throw new Error('SayGM models are not available in this Goose build.');
    if (!entry.refreshing) {
      if (!entry.configured || !entry.available || entry.models.length === 0) {
        throw new Error(entry.lastRefreshError || 'SayGM models are not ready yet.');
      }
      return;
    }
    if (!shouldWait || Date.now() >= deadline) {
      throw new Error('Timed out while loading SayGM models.');
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
