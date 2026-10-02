import { useCallback, useEffect, useRef, useState } from 'react';
import { KeyRound, LogOut } from 'lucide-react';
import type {
  GmAccountBalance,
  GmAccountComponentProps,
  GmAccountStatus,
  GmDeviceLoginInstructions,
} from '../../types/gmAccount';
import { cn } from '../../utils';
import { getLocalDeviceName } from '../../utils/localDeviceName';

type Action = 'idle' | 'starting' | 'waiting' | 'key' | 'setup' | 'balance' | 'logout';
type BalanceRequest = {
  context: string;
  generation: number;
  promise: Promise<GmAccountBalance | null>;
};
type StatusRequest = {
  accountChangeGeneration: number;
  promise: Promise<GmAccountStatus>;
};
type QueuedStatusRefresh = {
  lifecycleGeneration: number;
  promise: Promise<GmAccountStatus>;
};

const BALANCE_REFRESH_INTERVAL_MS = 60_000;
const BALANCE_RETRY_MAX_MS = 5 * 60_000;

const NOTE_CLASS =
  'rounded-[10px] border border-border-primary bg-surface-chip px-3.5 py-2.5 text-[13px] text-text-primary';
const ALERT_CLASS =
  'rounded-[10px] border border-[rgba(255,80,63,0.32)] bg-[rgba(255,80,63,0.08)] px-3.5 py-2.5 text-[13px] text-text-danger';

export default function GMAccount({ mode = 'full', onConnected }: GmAccountComponentProps) {
  const localDeviceName = getLocalDeviceName(window.electron.platform);
  const [status, setStatus] = useState<GmAccountStatus | null>(null);
  const [balance, setBalance] = useState<GmAccountBalance | null>(null);
  const [balanceError, setBalanceError] = useState<string | null>(null);
  const [deviceFlow, setDeviceFlow] = useState<GmDeviceLoginInstructions | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [showApiKeyFallback, setShowApiKeyFallback] = useState(false);
  const [action, setAction] = useState<Action>('idle');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const statusRef = useRef<GmAccountStatus | null>(null);
  const statusContext = useRef<string | null>(null);
  const statusRequest = useRef<StatusRequest | null>(null);
  const queuedStatusRequest = useRef<QueuedStatusRefresh | null>(null);
  const statusReadGeneration = useRef(0);
  const accountChangeGeneration = useRef(0);
  const statusLifecycleGeneration = useRef(0);
  const accountChangePending = useRef(false);
  const balanceGeneration = useRef(0);
  const balanceRequest = useRef<BalanceRequest | null>(null);
  const queuedBalanceGeneration = useRef<number | null>(null);
  const balanceRetryCount = useRef(0);
  const balanceRefreshAfter = useRef(0);
  const balanceValue = useRef<GmAccountBalance | null>(null);
  const topupReturnContext = useRef<string | null>(null);
  const refreshBalanceRef = useRef<(force?: boolean) => Promise<GmAccountBalance | null>>(
    async () => null
  );
  const pollController = useRef<AbortController | null>(null);
  const pendingFlow = useRef(false);
  const flowGeneration = useRef(0);
  const mounted = useRef(false);
  const didNotify = useRef(false);
  const connectedCallback = useRef(onConnected);
  connectedCallback.current = onConnected;
  const apiKeyToggleRef = useRef<HTMLButtonElement>(null);
  const restoreApiKeyToggleFocus = useRef(false);

  const startStatusRead = useCallback((): StatusRequest => {
    const request: StatusRequest = {
      accountChangeGeneration: accountChangeGeneration.current,
      promise: window.electron.gmAccount.getStatus(),
    };
    statusRequest.current = request;
    const clear = () => {
      if (statusRequest.current === request) statusRequest.current = null;
    };
    void request.promise.then(clear, clear);
    return request;
  }, []);

  const readStatusAfterChange = useCallback(
    (lifecycleGeneration: number) => {
      if (queuedStatusRequest.current?.lifecycleGeneration === lifecycleGeneration) {
        return queuedStatusRequest.current.promise;
      }

      const isCurrent = () =>
        mounted.current && statusLifecycleGeneration.current === lifecycleGeneration;
      const queued = {} as QueuedStatusRefresh;
      queued.lifecycleGeneration = lifecycleGeneration;
      queued.promise = (async () => {
        while (isCurrent()) {
          const inFlight = statusRequest.current;
          const request = inFlight ?? startStatusRead();
          const result = await request.promise;
          if (!isCurrent()) throw new Error('Account status refresh was cancelled.');
          if (request.accountChangeGeneration === accountChangeGeneration.current) return result;
        }
        throw new Error('Account status refresh was cancelled.');
      })();
      queuedStatusRequest.current = queued;
      const clear = () => {
        if (queuedStatusRequest.current === queued) queuedStatusRequest.current = null;
      };
      void queued.promise.then(clear, clear);
      return queued.promise;
    },
    [startStatusRead]
  );

  const readStatus = useCallback(
    (fresh = false, lifecycleGeneration = statusLifecycleGeneration.current) => {
      const queued = queuedStatusRequest.current;
      if (queued?.lifecycleGeneration === lifecycleGeneration) return queued.promise;

      const inFlight = statusRequest.current;
      if (
        fresh ||
        (inFlight && inFlight.accountChangeGeneration !== accountChangeGeneration.current)
      ) {
        return readStatusAfterChange(lifecycleGeneration);
      }
      return inFlight?.promise ?? startStatusRead().promise;
    },
    [readStatusAfterChange, startStatusRead]
  );

  const invalidateBalance = useCallback(() => {
    accountChangePending.current = true;
    topupReturnContext.current = null;
    balanceGeneration.current += 1;
    queuedBalanceGeneration.current = null;
    balanceRetryCount.current = 0;
    balanceRefreshAfter.current = 0;
    balanceValue.current = null;
    setAction((current) => (current === 'balance' ? 'idle' : current));
    setBalance(null);
    setBalanceError(null);
  }, []);

  const updateStatus = useCallback((next: GmAccountStatus) => {
    const nextContext = next.connected
      ? JSON.stringify([
          next.mode,
          next.email,
          next.keyPrefix,
          next.providerConfigured,
          next.secureStorageAvailable,
          next.remoteCleanupPending,
        ])
      : null;
    const contextChanged = statusContext.current !== nextContext;
    statusRef.current = next;
    statusContext.current = nextContext;
    accountChangePending.current = false;
    if (contextChanged) {
      topupReturnContext.current = null;
      balanceGeneration.current += 1;
      queuedBalanceGeneration.current = null;
      balanceRetryCount.current = 0;
      balanceRefreshAfter.current = 0;
      balanceValue.current = null;
      setAction((current) => (current === 'balance' ? 'idle' : current));
      setBalance(null);
      setBalanceError(null);
    }
    setStatus(next);
    return contextChanged;
  }, []);

  const notifyConnected = useCallback(
    (next: GmAccountStatus) => {
      if (
        mode === 'onboarding' &&
        next.connected &&
        next.providerConfigured &&
        !didNotify.current
      ) {
        didNotify.current = true;
        connectedCallback.current?.();
      }
    },
    [mode]
  );

  const refreshBalance = useCallback((force = false): Promise<GmAccountBalance | null> => {
    const currentStatus = statusRef.current;
    const context = statusContext.current;
    if (
      accountChangePending.current ||
      !currentStatus?.connected ||
      !context ||
      !currentStatus.secureStorageAvailable
    ) {
      return Promise.resolve(null);
    }

    const generation = balanceGeneration.current;
    const inFlight = balanceRequest.current;
    if (inFlight) {
      if (inFlight.generation === generation) {
        if (force) queuedBalanceGeneration.current = generation;
        return inFlight.promise;
      }
      queuedBalanceGeneration.current = generation;
      return inFlight.promise.then(() => null);
    }

    if (Date.now() < balanceRefreshAfter.current && (!force || balanceRetryCount.current > 0)) {
      return Promise.resolve(balanceValue.current);
    }

    if (mounted.current) {
      setBalanceError(null);
      setAction((current) => (current === 'idle' ? 'balance' : current));
    }

    const request: BalanceRequest = {
      context,
      generation,
      promise: Promise.resolve(null),
    };
    const isCurrent = () =>
      mounted.current &&
      request.generation === balanceGeneration.current &&
      request.context === statusContext.current &&
      statusRef.current?.connected === true;
    request.promise = (async () => {
      try {
        const nextBalance = await window.electron.gmAccount.getBalance();
        if (isCurrent()) {
          balanceValue.current = nextBalance;
          setBalance(nextBalance);
          setBalanceError(null);
          balanceRetryCount.current = 0;
          balanceRefreshAfter.current = Date.now() + BALANCE_REFRESH_INTERVAL_MS;
        }
        return nextBalance;
      } catch (cause) {
        if (isCurrent()) {
          balanceValue.current = null;
          setBalance(null);
          setBalanceError(errorText(cause));
          const delay = Math.min(
            BALANCE_REFRESH_INTERVAL_MS * 2 ** balanceRetryCount.current,
            BALANCE_RETRY_MAX_MS
          );
          balanceRetryCount.current += 1;
          balanceRefreshAfter.current = Date.now() + delay;
        }
        return null;
      } finally {
        if (isCurrent()) {
          setAction((current) => (current === 'balance' ? 'idle' : current));
        }
        if (balanceRequest.current === request) {
          balanceRequest.current = null;
          const queued = queuedBalanceGeneration.current;
          queuedBalanceGeneration.current = null;
          if (queued === balanceGeneration.current && mounted.current) {
            void refreshBalanceRef.current(true);
          }
        }
      }
    })();
    balanceRequest.current = request;
    return request.promise;
  }, []);
  refreshBalanceRef.current = refreshBalance;

  useEffect(() => {
    let active = true;
    const lifecycleGeneration = ++statusLifecycleGeneration.current;
    mounted.current = true;
    const load = async () => {
      const requestGeneration = ++statusReadGeneration.current;
      try {
        const initial = await readStatus(false, lifecycleGeneration);
        if (!active || requestGeneration !== statusReadGeneration.current) return;
        const contextChanged = updateStatus(initial);
        if (initial.connected) {
          notifyConnected(initial);
          void refreshBalance(contextChanged);
        }
      } catch (cause) {
        if (active && requestGeneration === statusReadGeneration.current) {
          setError(errorText(cause));
        }
      }
    };
    const unsubscribe = window.electron.gmAccount.onChanged(() => {
      accountChangeGeneration.current += 1;
      invalidateBalance();
      const requestGeneration = ++statusReadGeneration.current;
      void readStatus(true, lifecycleGeneration)
        .then((next) => {
          if (!active || requestGeneration !== statusReadGeneration.current) return;
          const contextChanged = updateStatus(next);
          if (next.connected) {
            notifyConnected(next);
            void refreshBalance(contextChanged);
          } else {
            didNotify.current = false;
          }
        })
        .catch((cause) => {
          if (active && requestGeneration === statusReadGeneration.current) {
            setError(errorText(cause));
          }
        });
    });
    const onFocus = () => {
      const topupContext = topupReturnContext.current;
      topupReturnContext.current = null;
      if (statusRef.current?.connected) {
        void refreshBalance(topupContext !== null && topupContext === statusContext.current);
      }
    };
    window.addEventListener('focus', onFocus);
    void load();
    return () => {
      active = false;
      mounted.current = false;
      statusLifecycleGeneration.current += 1;
      statusReadGeneration.current += 1;
      balanceGeneration.current += 1;
      queuedBalanceGeneration.current = null;
      flowGeneration.current += 1;
      unsubscribe();
      window.removeEventListener('focus', onFocus);
      pollController.current?.abort();
      if (pendingFlow.current) {
        pendingFlow.current = false;
        void window.electron.gmAccount.cancelDeviceLogin();
      }
    };
  }, [invalidateBalance, notifyConnected, readStatus, refreshBalance, updateStatus]);

  const pollUntilApproved = async (
    flow: GmDeviceLoginInstructions,
    controller: AbortController,
    generation: number
  ) => {
    const isCurrent = () => mounted.current && flowGeneration.current === generation;
    let retryAfterSeconds = flow.intervalSeconds;
    try {
      while (Date.now() < flow.expiresAt) {
        if (!(await waitFor(retryAfterSeconds * 1000, controller.signal))) return;
        if (!isCurrent()) return;
        const result = await window.electron.gmAccount.pollDeviceLogin();
        if (controller.signal.aborted || !isCurrent()) return;
        if (result.status === 'pending') {
          retryAfterSeconds = result.retryAfterSeconds;
          continue;
        }
        pendingFlow.current = false;
        setDeviceFlow(null);
        const contextChanged = updateStatus(result.account);
        setAction('idle');
        notifyConnected(result.account);
        await refreshBalance(contextChanged);
        if (!result.account.providerConfigured) {
          setNotice(
            'Your SayGM account is connected. Finish secure model setup before choosing a model.'
          );
        }
        return;
      }
      if (controller.signal.aborted || !isCurrent()) return;
      await window.electron.gmAccount.cancelDeviceLogin();
      pendingFlow.current = false;
      setDeviceFlow(null);
      setError('The sign-in code expired. Start again to get a new code.');
    } catch (cause) {
      if (controller.signal.aborted || !isCurrent()) return;
      setError(errorText(cause));
      setDeviceFlow(null);
      pendingFlow.current = false;
      try {
        const current = await readStatus();
        const contextChanged = updateStatus(current);
        if (current.connected) await refreshBalance(contextChanged);
        notifyConnected(current);
      } catch {
        // Keep the original sign-in error visible.
      }
    } finally {
      if (pollController.current === controller) pollController.current = null;
      if (!controller.signal.aborted) setAction('idle');
    }
  };

  const beginDeviceLogin = async () => {
    const generation = ++flowGeneration.current;
    pendingFlow.current = true;
    setError(null);
    setNotice(null);
    setAction('starting');
    try {
      const flow = await window.electron.gmAccount.beginDeviceLogin();
      if (!mounted.current || flowGeneration.current !== generation) {
        await window.electron.gmAccount.cancelDeviceLogin();
        return;
      }
      setDeviceFlow(flow);
      const controller = new AbortController();
      pollController.current = controller;
      setAction('waiting');
      try {
        if (!mounted.current || flowGeneration.current !== generation) {
          controller.abort();
          await window.electron.gmAccount.cancelDeviceLogin();
          return;
        }
        await window.electron.gmAccount.openDeviceVerification();
      } catch (cause) {
        if (mounted.current && flowGeneration.current === generation) {
          setNotice(`Open SayGM to approve this sign-in. ${errorText(cause)}`);
        }
      }
      if (mounted.current && flowGeneration.current === generation) {
        void pollUntilApproved(flow, controller, generation);
      }
    } catch (cause) {
      if (!mounted.current || flowGeneration.current !== generation) return;
      pendingFlow.current = false;
      setAction('idle');
      setError(errorText(cause));
    }
  };

  const cancelDeviceLogin = async () => {
    flowGeneration.current += 1;
    pollController.current?.abort();
    pollController.current = null;
    pendingFlow.current = false;
    setDeviceFlow(null);
    setAction('idle');
    try {
      await window.electron.gmAccount.cancelDeviceLogin();
    } catch (cause) {
      setError(errorText(cause));
    }
  };

  const connectWithApiKey = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setNotice(null);
    setAction('key');
    try {
      const next = await window.electron.gmAccount.connectApiKey(apiKey);
      setApiKey('');
      const contextChanged = updateStatus(next);
      notifyConnected(next);
      await refreshBalance(contextChanged);
      if (next.providerConfigured) {
        setNotice('SayGM is connected and the key is stored in your system credential store.');
      }
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setApiKey('');
      setAction('idle');
    }
  };

  const finishProviderSetup = async () => {
    setError(null);
    setNotice(null);
    setAction('setup');
    try {
      const next = await window.electron.gmAccount.finishProviderSetup();
      const contextChanged = updateStatus(next);
      notifyConnected(next);
      if (next.connected && contextChanged) void refreshBalance(true);
      if (next.providerConfigured) {
        setNotice('SayGM is ready. Choose a model to continue.');
      }
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setAction('idle');
    }
  };

  const disconnect = async () => {
    setError(null);
    setNotice(null);
    setAction('logout');
    try {
      await window.electron.gmAccount.logout();
      const current = statusRef.current;
      if (current) {
        updateStatus({
          ...current,
          connected: false,
          mode: null,
          email: null,
          keyPrefix: null,
          providerConfigured: false,
        });
      }
      didNotify.current = false;
    } catch (cause) {
      setError(errorText(cause));
      try {
        updateStatus(await readStatus());
      } catch {
        // Preserve the sign-out error if status refresh is also unavailable.
      }
    } finally {
      setAction('idle');
    }
  };

  const openTopup = async () => {
    setError(null);
    const context = statusRef.current?.connected ? statusContext.current : null;
    topupReturnContext.current = context;
    try {
      await window.electron.gmAccount.openTopup();
    } catch (cause) {
      if (topupReturnContext.current === context) topupReturnContext.current = null;
      setError(errorText(cause));
    }
  };

  const openApiKeyFallback = () => {
    setShowApiKeyFallback(true);
    setError(null);
  };

  const closeApiKeyFallback = () => {
    restoreApiKeyToggleFocus.current = true;
    setShowApiKeyFallback(false);
    setError(null);
  };

  useEffect(() => {
    if (!showApiKeyFallback && restoreApiKeyToggleFocus.current) {
      restoreApiKeyToggleFocus.current = false;
      apiKeyToggleRef.current?.focus();
    }
  }, [showApiKeyFallback]);

  const busy = action !== 'idle';
  const secureStorageAvailable = status?.secureStorageAvailable ?? true;
  const showHeader = mode === 'onboarding' || !status?.connected;

  return (
    <section className="flex w-full flex-col gap-6 text-text-primary">
      {showHeader && (
        <div className="flex flex-col gap-2.5">
          <p className="gm-mono-label">SayGM account</p>
          <h2 className="text-[32px] font-semibold leading-[1.15] tracking-[-0.02em]">
            {status?.connected ? 'Your account' : 'Connect SayGM'}
          </h2>
          <p className="text-[15px] text-text-secondary">
            {status?.connected
              ? 'Check your credits and manage the SayGM connection for this desktop.'
              : `Approve sign-in in your browser. Your session is kept in this ${localDeviceName}’s secure storage.`}
          </p>
        </div>
      )}

      {error && (
        <div role="alert" className={ALERT_CLASS}>
          {error}
        </div>
      )}
      {notice && (
        <div role="status" className={NOTE_CLASS}>
          {notice}
        </div>
      )}

      {!secureStorageAvailable && (
        <div role="alert" className={ALERT_CLASS}>
          SayGM could not access secure storage. Sign-in and key setup are paused. Restart SayGM to
          check secure storage again.
        </div>
      )}

      {status?.connected ? (
        <div className="flex flex-col gap-4">
          <div className={cn('grid gap-4', mode === 'full' && 'md:grid-cols-2')}>
            <div className="gm-card flex flex-col gap-4 p-5">
              <div className="flex items-center justify-between gap-2">
                <p className="gm-mono-label">
                  {status.mode === 'session' ? 'Signed in' : 'Connected'}
                </p>
                <span className="gm-badge gm-badge--outline gm-badge--mono">
                  {status.providerConfigured ? 'Model key stored' : 'Setup needed'}
                </span>
              </div>
              <div className="flex min-w-0 items-center gap-3">
                <span
                  aria-hidden="true"
                  className="grid size-10 flex-shrink-0 place-items-center rounded-full bg-gm-yellow font-semibold text-gm-black"
                >
                  {status.mode === 'session' && status.email ? (
                    status.email.charAt(0).toUpperCase()
                  ) : (
                    <KeyRound className="size-4" />
                  )}
                </span>
                <div className="flex min-w-0 flex-col">
                  <span className="truncate text-[15px] font-semibold">
                    {status.mode === 'session'
                      ? status.email || 'Signed in to SayGM'
                      : `API key ${status.keyPrefix ?? ''}…`}
                  </span>
                  <span className="text-[13px] text-text-secondary">
                    {status.mode === 'session' ? 'Signed in with browser' : 'Key-only connection'}
                  </span>
                </div>
              </div>
              <p className="text-[13px] text-text-secondary">
                {status.mode === 'session'
                  ? `Your session is kept in this ${localDeviceName}’s secure storage.`
                  : `Your key is kept in this ${localDeviceName}’s secure storage.`}
              </p>
              <div className="mt-auto">
                <button
                  type="button"
                  onClick={() => void disconnect()}
                  disabled={busy}
                  className="gm-btn gm-btn--secondary gm-btn--sm"
                >
                  <LogOut className="size-4" aria-hidden="true" />
                  {action === 'logout' ? 'Signing out…' : 'Sign out'}
                </button>
              </div>
            </div>

            <div className="gm-card flex flex-col gap-3 p-5">
              <div className="flex items-center justify-between gap-2">
                <p className="gm-mono-label">Balance</p>
                {balance && (
                  <span className="gm-badge gm-badge--outline gm-badge--mono">
                    {balance.kind === 'key_spendable' ? 'This key' : 'Account'}
                  </span>
                )}
              </div>
              {balance ? (
                <p className="text-[44px] font-semibold leading-none tracking-[-0.03em]">
                  {formatUsd(balance.usd)}
                </p>
              ) : balanceError ? (
                <p className="text-[44px] font-semibold leading-none tracking-[-0.03em] text-text-tertiary">
                  Unavailable
                </p>
              ) : (
                <p className="text-[13px] text-text-secondary">
                  {action === 'balance' ? 'Loading balance…' : 'Balance not loaded.'}
                </p>
              )}
              {balanceError && (
                <p role="alert" className="text-[13px] text-text-danger">
                  {balanceError}
                </p>
              )}
              {balance?.kind === 'account' && (
                <p className="text-[13px] text-text-secondary">
                  {balance.sharedBalance === undefined
                    ? 'Current balance from your SayGM account.'
                    : balance.sharedBalance
                      ? 'Shared across your SayGM API keys.'
                      : 'Balance is split across your API keys by weight.'}
                </p>
              )}
              {balance?.kind === 'key_spendable' && (
                <p className="text-[13px] text-text-secondary">
                  Key-only mode shows this key’s spendable credits, not your full account balance.
                </p>
              )}
              <p className="mt-auto text-[12px] text-text-tertiary">
                Updates when this page opens and when you return to SayGM.
              </p>
            </div>
          </div>

          {!status.providerConfigured && (
            <div className="gm-card flex flex-col gap-3 p-5">
              <p className="gm-mono-label">Model setup</p>
              <p className="text-sm text-text-secondary">
                Your account is connected. Store a SayGM model key in your system credential store
                to continue to model selection.
              </p>
              <div>
                <button
                  type="button"
                  onClick={() => void finishProviderSetup()}
                  disabled={busy || !secureStorageAvailable}
                  className="gm-btn gm-btn--sm"
                >
                  {action === 'setup' ? 'Setting up…' : 'Finish model setup'}
                </button>
              </div>
            </div>
          )}

          <div className="gm-card flex flex-col gap-4 p-5">
            <div className="flex flex-col gap-1">
              <p className="gm-mono-label">Add credit</p>
              <p className="text-sm text-text-secondary">
                Checkout opens on saygm.com in your browser.
              </p>
            </div>
            <div>
              <button type="button" onClick={() => void openTopup()} className="gm-btn">
                Add credit on saygm.com
                <span aria-hidden="true" className="gm-btn__arrow">
                  ↗
                </span>
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {deviceFlow ? (
            <div aria-live="polite" className="gm-card gm-fade-up flex flex-col gap-4 p-5">
              <p className="flex items-center gap-3 text-[15px] font-semibold">
                <span className="gm-spinner" aria-hidden="true" />
                Waiting for your browser…
              </p>
              <p className="text-sm text-text-secondary">
                Approve this sign-in on SayGM in your browser, then come back here.
              </p>
              <div className="flex flex-col gap-1">
                <p className="text-[13px] text-text-secondary">Enter this code on SayGM:</p>
                <p className="select-all font-mono text-3xl font-semibold tracking-[0.16em]">
                  {deviceFlow.userCode}
                </p>
                <p className="text-xs text-text-tertiary">
                  Code expires at {new Date(deviceFlow.expiresAt).toLocaleTimeString()}.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void window.electron.gmAccount.openDeviceVerification()}
                  disabled={busy && action !== 'waiting'}
                  className="gm-btn gm-btn--secondary gm-btn--sm"
                >
                  Open browser again
                </button>
                <button
                  type="button"
                  onClick={() => void cancelDeviceLogin()}
                  className="gm-btn gm-btn--ghost gm-btn--sm"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : showApiKeyFallback ? (
            <form
              onSubmit={(event) => void connectWithApiKey(event)}
              className="gm-fade-up flex flex-col gap-3"
            >
              <label htmlFor="saygm-api-key" className="text-[13px] font-semibold">
                SayGM API key
              </label>
              <input
                id="saygm-api-key"
                type="password"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                disabled={busy}
                autoFocus
                className="gm-input"
                placeholder="Paste your SayGM API key"
              />
              <p className="text-[13px] text-text-secondary">
                We verify the key, store it in your system credential store, and show only its
                spendable credits.
              </p>
              <div className="flex flex-wrap gap-2">
                <button type="submit" disabled={busy || !apiKey.trim()} className="gm-btn">
                  {action === 'key' ? 'Checking key…' : 'Continue'}
                </button>
                <button
                  type="button"
                  onClick={closeApiKeyFallback}
                  disabled={busy}
                  className="gm-btn gm-btn--ghost"
                >
                  Back
                </button>
              </div>
            </form>
          ) : (
            <>
              <button
                type="button"
                onClick={() => void beginDeviceLogin()}
                disabled={busy || !secureStorageAvailable}
                className="gm-btn gm-btn--lg gm-btn--block"
              >
                {action === 'starting' ? 'Starting secure sign-in…' : 'Continue in browser'}
                {action !== 'starting' && (
                  <span aria-hidden="true" className="gm-btn__arrow">
                    ↗
                  </span>
                )}
              </button>

              <div
                className="flex items-center gap-3 text-xs text-text-tertiary"
                aria-hidden="true"
              >
                <span className="h-px flex-1 bg-border-primary" />
                <span>or</span>
                <span className="h-px flex-1 bg-border-primary" />
              </div>

              <button
                ref={apiKeyToggleRef}
                type="button"
                onClick={openApiKeyFallback}
                disabled={busy || !secureStorageAvailable}
                className="gm-btn gm-btn--secondary gm-btn--lg gm-btn--block"
              >
                <KeyRound className="size-4" aria-hidden="true" />
                Use an API key instead
              </button>
            </>
          )}
        </div>
      )}
    </section>
  );
}

function formatUsd(value: string): string {
  const amount = Number(value);
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number.isFinite(amount) ? amount : 0);
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'SayGM account action failed. Try again.';
}

function waitFor(milliseconds: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', handleAbort);
      resolve(true);
    }, milliseconds);
    const handleAbort = () => {
      clearTimeout(timeout);
      resolve(false);
    };
    signal.addEventListener('abort', handleAbort, { once: true });
  });
}
