import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelInfo, ProviderDetails } from '../../types/providers';
import type { GmAccountStatus } from '../../types/gmAccount';
import OnboardingGuard from './OnboardingGuard';

const providers = vi.hoisted(() => ({
  acpReadDefaults: vi.fn(),
  acpRefreshProviderDetails: vi.fn(),
  acpSaveDefaults: vi.fn(),
}));

const config = vi.hoisted(() => ({
  acpReadConfig: vi.fn(),
  acpUpsertConfig: vi.fn(),
}));

const gmAccount = vi.hoisted(() => ({
  getStatus: vi.fn(),
  onChanged: vi.fn(),
  accountStatus: {
    connected: false,
    mode: null as 'session' | 'api_key' | null,
    email: null as string | null,
    keyPrefix: null as string | null,
    providerConfigured: false,
    secureStorageAvailable: true,
    remoteCleanupPending: false,
  },
  listeners: [] as Array<() => void>,
}));

vi.mock('../../acp/providers', () => providers);
vi.mock('../../acp/config', () => config);

vi.mock('./GMAccount', () => ({
  default: ({ onConnected }: { onConnected?: () => void }) => (
    <button
      type="button"
      onClick={() => {
        gmAccount.accountStatus.connected = true;
        gmAccount.accountStatus.providerConfigured = true;
        onConnected?.();
      }}
    >
      Stub connect
    </button>
  ),
}));

vi.mock('../ModelAndProviderContext', () => ({
  useModelAndProvider: () => ({
    refreshCurrentModelAndProvider: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('framer-motion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('framer-motion')>()),
  useReducedMotion: () => true,
}));

function saygmProvider(models: ModelInfo[], defaultModel: string): { provider: ProviderDetails } {
  return {
    provider: {
      is_configured: true,
      is_available: true,
      visible_in_setup: true,
      deprecated: false,
      name: 'saygm',
      provider_type: 'Preferred',
      uses_acp: false,
      metadata: {
        config_keys: [],
        default_model: defaultModel,
        description: '',
        display_name: 'SayGM',
        known_models: models,
        model_doc_link: '',
        name: 'saygm',
      },
    },
  };
}

function renderGuard() {
  return render(
    <MemoryRouter>
      <OnboardingGuard>
        <p>workspace ready</p>
      </OnboardingGuard>
    </MemoryRouter>
  );
}

function setAccountStatus(connected: boolean, providerConfigured = connected) {
  gmAccount.accountStatus.connected = connected;
  gmAccount.accountStatus.providerConfigured = providerConfigured;
}

function makeAccountStatus(connected: boolean, providerConfigured = connected): GmAccountStatus {
  return {
    connected,
    mode: connected ? 'session' : null,
    email: connected ? 'person@example.com' : null,
    keyPrefix: null,
    providerConfigured,
    secureStorageAvailable: true,
    remoteCleanupPending: false,
  };
}

function emitAccountChange() {
  for (const listener of [...gmAccount.listeners]) listener();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('OnboardingGuard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gmAccount.listeners = [];
    setAccountStatus(false, false);
    gmAccount.getStatus.mockImplementation(() =>
      Promise.resolve(
        makeAccountStatus(
          gmAccount.accountStatus.connected,
          gmAccount.accountStatus.providerConfigured
        )
      )
    );
    gmAccount.onChanged.mockImplementation((listener: () => void) => {
      gmAccount.listeners.push(listener);
      return () => {
        gmAccount.listeners = gmAccount.listeners.filter((current) => current !== listener);
      };
    });
    Object.assign(window.electron, {
      gmAccount: {
        getStatus: gmAccount.getStatus,
        onChanged: gmAccount.onChanged,
      },
    });
    config.acpReadConfig.mockResolvedValue('approve');
    config.acpUpsertConfig.mockResolvedValue(undefined);
    providers.acpSaveDefaults.mockResolvedValue(undefined);
  });

  it('shows the workspace only when account, provider key, and SayGM defaults are ready', async () => {
    setAccountStatus(true, true);
    providers.acpReadDefaults.mockResolvedValue({ providerId: 'saygm', modelId: 'model-beta' });

    renderGuard();

    expect(await screen.findByText('workspace ready')).toBeInTheDocument();
  });

  it('does not treat saved SayGM defaults as ready without a connected account', async () => {
    providers.acpReadDefaults.mockResolvedValue({ providerId: 'saygm', modelId: 'model-beta' });

    renderGuard();

    expect(
      await screen.findByRole('heading', { level: 1, name: /say gm to the agent/i })
    ).toBeInTheDocument();
    expect(screen.queryByText('workspace ready')).not.toBeInTheDocument();
  });

  it('does not treat a connected account as ready until its provider key is configured', async () => {
    setAccountStatus(true, false);
    providers.acpReadDefaults.mockResolvedValue({ providerId: 'saygm', modelId: 'model-beta' });

    renderGuard();

    expect(
      await screen.findByRole('heading', { level: 1, name: /say gm to the agent/i })
    ).toBeInTheDocument();
    expect(screen.queryByText('workspace ready')).not.toBeInTheDocument();
  });

  it('does not report a connection-loss warning for a fresh disconnected account event', async () => {
    providers.acpReadDefaults.mockResolvedValue({ providerId: null, modelId: null });

    renderGuard();
    await screen.findByRole('button', { name: 'Stub connect' });
    await act(async () => emitAccountChange());

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('seeds approval mode on a fresh install before onboarding', async () => {
    config.acpReadConfig.mockResolvedValue(null);
    providers.acpReadDefaults.mockResolvedValue({ providerId: null, modelId: null });

    renderGuard();

    expect(
      await screen.findByRole('heading', { level: 1, name: /say gm to the agent/i })
    ).toBeInTheDocument();
    expect(config.acpUpsertConfig).toHaveBeenCalledWith('GOOSE_MODE', 'approve', false);
  });

  it('hands off to the workspace once a model choice is saved', async () => {
    const user = userEvent.setup();
    providers.acpReadDefaults
      .mockResolvedValueOnce({ providerId: null, modelId: null })
      .mockResolvedValueOnce({ providerId: null, modelId: null })
      .mockResolvedValue({ providerId: 'saygm', modelId: 'model-beta' });
    providers.acpRefreshProviderDetails.mockResolvedValue(
      saygmProvider(
        [{ name: 'model-alpha' }, { name: 'model-beta', context_limit: 200_000, reasoning: true }],
        'model-alpha'
      )
    );

    renderGuard();
    await user.click(await screen.findByRole('button', { name: 'Stub connect' }));

    const alpha = await screen.findByRole('radio', { name: /model-alpha/ });
    expect(alpha).toBeChecked();
    expect(screen.getByText('200K context')).toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: /model-beta/ }));
    await user.click(screen.getByRole('button', { name: /start chatting/i }));

    expect(await screen.findByText('workspace ready')).toBeInTheDocument();
    expect(providers.acpSaveDefaults).toHaveBeenCalledWith('saygm', 'model-beta');
    expect(gmAccount.getStatus).toHaveBeenCalled();
  });

  it('contains long model catalogs within the responsive picker layout', async () => {
    const user = userEvent.setup();
    const models = Array.from({ length: 40 }, (_, index) => ({
      name: `catalog-model-${String(index + 1).padStart(2, '0')}`,
      context_limit: 128_000,
      reasoning: index % 2 === 0,
    }));
    providers.acpReadDefaults.mockResolvedValue({ providerId: null, modelId: null });
    providers.acpRefreshProviderDetails.mockResolvedValue(saygmProvider(models, models[0].name));

    renderGuard();
    await user.click(await screen.findByRole('button', { name: 'Stub connect' }));

    const lastModel = await screen.findByRole('radio', { name: /catalog-model-40/ });
    expect(screen.getAllByRole('radio')).toHaveLength(40);
    expect(lastModel.closest('label')).toHaveClass('relative');
    expect(lastModel.closest('fieldset')).toHaveClass('min-w-0');
  });

  it('keeps the user on the model step when saving fails', async () => {
    const user = userEvent.setup();
    providers.acpReadDefaults.mockResolvedValue({ providerId: null, modelId: null });
    providers.acpRefreshProviderDetails.mockResolvedValue(
      saygmProvider([{ name: 'model-alpha' }], 'model-alpha')
    );
    providers.acpSaveDefaults.mockRejectedValue(new Error('Defaults are read-only right now.'));

    renderGuard();
    await user.click(await screen.findByRole('button', { name: 'Stub connect' }));
    await user.click(await screen.findByRole('button', { name: /start chatting/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Defaults are read-only right now.');
    expect(screen.queryByText('workspace ready')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /start chatting/i })).toBeEnabled();
  });

  it('explains a missing model catalog instead of advancing', async () => {
    const user = userEvent.setup();
    providers.acpReadDefaults.mockResolvedValue({ providerId: null, modelId: null });
    providers.acpRefreshProviderDetails.mockResolvedValue(saygmProvider([], ''));

    renderGuard();
    await user.click(await screen.findByRole('button', { name: 'Stub connect' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'No compatible SayGM models are available right now.'
    );
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
  });

  it('offers a retry when startup checks fail', async () => {
    const user = userEvent.setup();
    config.acpReadConfig.mockRejectedValueOnce(new Error('agent not ready'));
    setAccountStatus(true, true);
    providers.acpReadDefaults.mockResolvedValue({ providerId: 'saygm', modelId: 'model-alpha' });

    renderGuard();
    await user.click(await screen.findByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(screen.getByText('workspace ready')).toBeInTheDocument());
  });

  it('rechecks readiness after an account change and returns to onboarding after logout', async () => {
    setAccountStatus(true, true);
    providers.acpReadDefaults.mockResolvedValue({ providerId: 'saygm', modelId: 'model-beta' });

    renderGuard();
    expect(await screen.findByText('workspace ready')).toBeInTheDocument();

    setAccountStatus(false, false);
    await act(async () => emitAccountChange());

    expect(
      await screen.findByRole('heading', { level: 1, name: /say gm to the agent/i })
    ).toBeInTheDocument();
    expect(screen.queryByText('workspace ready')).not.toBeInTheDocument();
  });

  it('rechecks readiness when the app window regains focus', async () => {
    setAccountStatus(true, true);
    providers.acpReadDefaults.mockResolvedValue({ providerId: 'saygm', modelId: 'model-beta' });

    renderGuard();
    expect(await screen.findByText('workspace ready')).toBeInTheDocument();

    setAccountStatus(false, false);
    await act(async () => fireEvent.focus(window));

    expect(
      await screen.findByRole('heading', { level: 1, name: /say gm to the agent/i })
    ).toBeInTheDocument();
    expect(gmAccount.getStatus).toHaveBeenCalledTimes(2);
  });

  it('does not restore ready from a stale readiness result after a logout change', async () => {
    const pendingInitialStatus = deferred<GmAccountStatus>();
    gmAccount.getStatus
      .mockReset()
      .mockReturnValueOnce(pendingInitialStatus.promise)
      .mockResolvedValue(makeAccountStatus(false, false));
    providers.acpReadDefaults.mockResolvedValue({ providerId: 'saygm', modelId: 'model-beta' });

    renderGuard();

    await act(async () => emitAccountChange());
    expect(
      await screen.findByRole('heading', { level: 1, name: /say gm to the agent/i })
    ).toBeInTheDocument();

    pendingInitialStatus.resolve(makeAccountStatus(true, true));
    await act(async () => pendingInitialStatus.promise);

    expect(screen.queryByText('workspace ready')).not.toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 1, name: /say gm to the agent/i })
    ).toBeInTheDocument();
  });

  it('discards the model step when logout arrives while setup is open', async () => {
    const user = userEvent.setup();
    providers.acpReadDefaults.mockResolvedValue({ providerId: null, modelId: null });
    providers.acpRefreshProviderDetails.mockResolvedValue(
      saygmProvider([{ name: 'model-alpha' }], 'model-alpha')
    );

    renderGuard();
    await user.click(await screen.findByRole('button', { name: 'Stub connect' }));
    expect(await screen.findByRole('radio', { name: /model-alpha/ })).toBeInTheDocument();

    setAccountStatus(false, false);
    await act(async () => emitAccountChange());

    expect(await screen.findByRole('button', { name: 'Stub connect' })).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: /model-alpha/ })).not.toBeInTheDocument();
  });

  it('discards an in-flight model catalog response after logout', async () => {
    const user = userEvent.setup();
    const pendingCatalog = deferred<{ provider: ProviderDetails }>();
    providers.acpReadDefaults.mockResolvedValue({ providerId: null, modelId: null });
    providers.acpRefreshProviderDetails.mockReturnValue(pendingCatalog.promise);

    renderGuard();
    await user.click(await screen.findByRole('button', { name: 'Stub connect' }));
    await waitFor(() => expect(providers.acpRefreshProviderDetails).toHaveBeenCalledWith('saygm'));

    setAccountStatus(false, false);
    await act(async () => emitAccountChange());
    expect(await screen.findByRole('button', { name: 'Stub connect' })).toBeInTheDocument();

    await act(async () => {
      pendingCatalog.resolve(saygmProvider([{ name: 'model-alpha' }], 'model-alpha'));
      await pendingCatalog.promise;
    });

    expect(screen.queryByRole('radio', { name: /model-alpha/ })).not.toBeInTheDocument();
  });
});
