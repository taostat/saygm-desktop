import { DEFAULT_GOOSE_MCP_HOST_CAPABILITIES } from '@aaif/goose-acp-client';
import { methods, PROTOCOL_VERSION, type InitializeResponse } from '@agentclientprotocol/sdk';
import {
  createWebSocketStream,
  type WebSocketConstructor,
  type WebSocketLike,
} from '@agentclientprotocol/sdk/experimental/ws-client';
import packageJson from '../../package.json';
import { GOOSE_SERVE_EXITED_USER_MESSAGE } from '../gooseServeLeaseRegistry';
import {
  handleAcpGooseSessionNotification,
  handleAcpProviderDeviceCodeNotification,
  handleAcpSessionNotification,
} from './chatNotifications';
import { requestAcpElicitation } from './elicitationRequests';
import {
  connectGooseAcpClient,
  type GooseAcpCallbacks,
  type GooseAcpClient,
} from './gooseAcpClient';
import { requestAcpPermission } from './permissionRequests';
import { requestAcpRecipeParams } from './recipeParamRequests';

type AcpConnection = {
  client: GooseAcpClient;
  initializeResponse: InitializeResponse;
};

type AcpRecoveryListener = (recovering: boolean) => void;

const ACP_INITIALIZE_TIMEOUT_MS = 10_000;
const ACP_WEBSOCKET_OPEN_TIMEOUT_MS = 30_000;
const ACP_RECONNECT_BASE_DELAY_MS = 500;
const ACP_RECONNECT_MAX_DELAY_MS = 30_000;
const ACP_V1_PROTOCOL_VERSION: 1 = PROTOCOL_VERSION;

let currentConnection: AcpConnection | null = null;
let pendingConnection: Promise<AcpConnection> | null = null;
let connectionGeneration = 0;
let recovering = false;
const recoveryListeners = new Set<AcpRecoveryListener>();
const pendingConnectionAttempts = new Set<AbortController>();

export async function getAcpClient(): Promise<GooseAcpClient> {
  return (await getConnection()).client;
}

export async function getAcpInitializeResponse(): Promise<InitializeResponse> {
  return (await getConnection()).initializeResponse;
}

export function reconnectAcpAfterSystemResume(): void {
  recoverConnection(true);
}

export function isAcpRecovering(): boolean {
  return recovering;
}

export function subscribeToAcpRecovery(listener: AcpRecoveryListener): () => void {
  recoveryListeners.add(listener);
  return () => {
    recoveryListeners.delete(listener);
  };
}

function setRecovering(nextRecovering: boolean): void {
  if (recovering === nextRecovering) {
    return;
  }

  recovering = nextRecovering;
  for (const listener of recoveryListeners) {
    listener(recovering);
  }
}

function recoverConnection(immediate: boolean): void {
  if (!currentConnection && !pendingConnection) {
    return;
  }

  setRecovering(true);
  const previousConnection = currentConnection;
  connectionGeneration += 1;
  for (const attempt of pendingConnectionAttempts) {
    attempt.abort();
  }
  pendingConnectionAttempts.clear();
  currentConnection = null;
  pendingConnection = null;
  previousConnection?.client.connection.close();

  const generation = connectionGeneration;
  const recoveryAttempt = immediate
    ? openConnection(generation).catch((error) => {
        if (generation !== connectionGeneration || isGooseServeExitedError(error)) {
          throw error;
        }
        return retryWithBackoff(generation);
      })
    : retryWithBackoff(generation);
  pendingConnection = recoveryAttempt;
  void recoveryAttempt.then(
    () => {
      if (generation === connectionGeneration) {
        setRecovering(false);
      }
    },
    () => {
      if (pendingConnection === recoveryAttempt) {
        pendingConnection = null;
      }
      if (generation === connectionGeneration) {
        setRecovering(false);
      }
    }
  );
}

async function getConnection(): Promise<AcpConnection> {
  if (currentConnection) {
    return currentConnection;
  }

  if (!pendingConnection) {
    const generation = connectionGeneration;
    let connectionAttempt: Promise<AcpConnection>;
    connectionAttempt = openConnection(generation).catch((error) => {
      if (pendingConnection === connectionAttempt) {
        pendingConnection = null;
      }
      throw error;
    });
    pendingConnection = connectionAttempt;
  }

  return pendingConnection;
}

async function openConnection(generation: number): Promise<AcpConnection> {
  const wsUrl = await window.electron.getAcpUrl();
  if (!wsUrl) {
    throw new Error('ACP URL is not available');
  }
  if (generation !== connectionGeneration) {
    throw new Error('ACP connection attempt is no longer current');
  }

  let socket: WebSocketLike | null = null;
  const ObservedWebSocket = function ObservedWebSocket(
    url: string,
    protocols?: string | string[],
    _options?: { headers?: Record<string, string> }
  ) {
    const createdSocket = new globalThis.WebSocket(url, protocols);
    socket = createdSocket as unknown as WebSocketLike;
    return createdSocket as unknown as WebSocketLike;
  } as unknown as WebSocketConstructor;

  const attempt = new AbortController();
  pendingConnectionAttempts.add(attempt);
  let client: GooseAcpClient | null = null;
  let transportClosed = false;
  const closeTransport = (reason?: unknown) => {
    if (transportClosed) {
      return;
    }
    transportClosed = true;
    client?.connection.close(reason);
    if (socket) {
      closeWebSocket(socket);
    }
  };
  const closeOnAbort = () =>
    closeTransport(new Error('ACP connection attempt is no longer current'));
  attempt.signal.addEventListener('abort', closeOnAbort, { once: true });

  try {
    // Electron treats an explicitly passed undefined protocol as a subprotocol.
    const stream = createWebSocketStream(wsUrl, { protocols: [], WebSocket: ObservedWebSocket });
    if (!socket) {
      throw new Error('ACP WebSocket transport did not create a socket');
    }
    client = connectGooseAcpClient(stream, createClientCallbacks());

    await waitForWebSocketOpen(socket, ACP_WEBSOCKET_OPEN_TIMEOUT_MS, attempt.signal);
    if (generation !== connectionGeneration) {
      throw new Error('ACP connection attempt is no longer current');
    }

    const initializeResponse = await withTimeout(
      client.connection.agent.request(methods.agent.initialize, {
        protocolVersion: ACP_V1_PROTOCOL_VERSION,
        _meta: {
          'goose/useLoginShellPath': true,
        },
        clientCapabilities: {
          elicitation: { form: {} },
          _meta: {
            goose: {
              mcpHostCapabilities: DEFAULT_GOOSE_MCP_HOST_CAPABILITIES,
              customNotifications: true,
              recipeParameterRequests: true,
            },
          },
        },
        clientInfo: {
          name: packageJson.name,
          version: packageJson.version,
        },
      }),
      ACP_INITIALIZE_TIMEOUT_MS,
      `Local agent connected, but ACP initialization did not finish within ${ACP_INITIALIZE_TIMEOUT_MS / 1000} seconds. Check the local agent startup logs, then retry.`,
      attempt.signal
    );

    if (generation !== connectionGeneration) {
      throw new Error('ACP connection attempt is no longer current');
    }

    const connection = { client, initializeResponse };
    currentConnection = connection;
    const handleClose = () => {
      if (currentConnection === connection) {
        recoverConnection(false);
      }
    };
    connection.client.connection.closed.then(handleClose, handleClose);
    return connection;
  } catch (error) {
    closeTransport(error);
    throw error;
  } finally {
    attempt.signal.removeEventListener('abort', closeOnAbort);
    pendingConnectionAttempts.delete(attempt);
  }
}

async function retryWithBackoff(generation: number): Promise<AcpConnection> {
  for (let attempt = 0; generation === connectionGeneration; attempt += 1) {
    const maximumDelay = Math.min(
      ACP_RECONNECT_MAX_DELAY_MS,
      ACP_RECONNECT_BASE_DELAY_MS * 2 ** attempt
    );
    await delay(Math.floor(Math.random() * maximumDelay));

    if (generation !== connectionGeneration) {
      break;
    }

    try {
      return await openConnection(generation);
    } catch (error) {
      if (generation !== connectionGeneration || isGooseServeExitedError(error)) {
        throw error;
      }
    }
  }

  throw new Error('ACP connection attempt is no longer current');
}

function isGooseServeExitedError(error: unknown): boolean {
  return error instanceof Error && error.message.includes(GOOSE_SERVE_EXITED_USER_MESSAGE);
}

function waitForWebSocketOpen(
  socket: WebSocketLike,
  timeoutMs: number,
  signal: AbortSignal
): Promise<void> {
  if (socket.readyState === 1) {
    return Promise.resolve();
  }
  if (socket.readyState === 2 || socket.readyState === 3) {
    return Promise.reject(createWebSocketClosedBeforeOpenError());
  }

  return new Promise((resolve, reject) => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let settled = false;
    const listeners: Array<() => void> = [];
    const cleanup = () => {
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }
      signal.removeEventListener('abort', onAbort);
      for (const removeListener of listeners) {
        removeListener();
      }
    };
    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    const onAbort = () => finish(new Error('ACP connection attempt is no longer current'));
    const onOpen = () => finish();
    const onError = () =>
      finish(
        new Error(
          'The local agent WebSocket failed before it opened. Check local agent startup logs, then retry.'
        )
      );
    const onClose = () =>
      finish(
        signal.aborted
          ? new Error('ACP connection attempt is no longer current')
          : createWebSocketClosedBeforeOpenError()
      );

    if (signal.aborted) {
      onAbort();
      return;
    }

    listeners.push(addWebSocketListener(socket, 'open', onOpen));
    listeners.push(addWebSocketListener(socket, 'error', onError));
    listeners.push(addWebSocketListener(socket, 'close', onClose));
    signal.addEventListener('abort', onAbort, { once: true });
    timeoutId = setTimeout(() => {
      finish(
        new Error(
          `The local agent WebSocket did not open within ${timeoutMs / 1000} seconds. Check local agent startup logs, then retry.`
        )
      );
    }, timeoutMs);
  });
}

function addWebSocketListener(
  socket: WebSocketLike,
  eventName: string,
  listener: (event?: unknown) => void
): () => void {
  if (socket.addEventListener) {
    socket.addEventListener(eventName, listener);
    return () => socket.removeEventListener?.(eventName, listener);
  }
  if (socket.on) {
    const handler = (...args: unknown[]) => listener(args[0]);
    socket.on(eventName, handler);
    return () => {
      if (socket.off) {
        socket.off(eventName, handler);
      } else {
        socket.removeListener?.(eventName, handler);
      }
    };
  }
  throw new Error('ACP WebSocket transport cannot report connection state');
}

function closeWebSocket(socket: WebSocketLike): void {
  if (socket.readyState !== 2 && socket.readyState !== 3) {
    socket.close();
  }
}

function createWebSocketClosedBeforeOpenError(): Error {
  return new Error(
    'The local agent WebSocket closed before it opened. Check local agent startup logs, then retry.'
  );
}

function delay(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function createClientCallbacks(): GooseAcpCallbacks {
  return {
    requestPermission: requestAcpPermission,
    createElicitation: requestAcpElicitation,
    unstable_sessionRecipeRequestParams: requestAcpRecipeParams,
    sessionUpdate: handleAcpSessionNotification,
    unstable_sessionUpdate: handleAcpGooseSessionNotification,
    unstable_providerDeviceCode: handleAcpProviderDeviceCodeNotification,
  };
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
  signal: AbortSignal
): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeoutId = setTimeout(() => finish(false, new Error(message)), timeoutMs);
    const onAbort = () => finish(false, new Error('ACP connection attempt is no longer current'));
    const cleanup = () => {
      clearTimeout(timeoutId);
      signal.removeEventListener('abort', onAbort);
    };
    const finish = (succeeded: boolean, result: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (succeeded) {
        resolve(result as T);
      } else {
        reject(result);
      }
    };

    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => finish(true, value),
      (error) => finish(false, error)
    );
  });
}
