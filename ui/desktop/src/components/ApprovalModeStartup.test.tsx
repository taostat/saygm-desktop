import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../i18n/test-utils';
import { ConfigProvider } from './ConfigContext';
import { LocalToolApprovalsCard } from './LocalToolApprovalsCard';
import OnboardingGuard from './onboarding/OnboardingGuard';

const configApi = vi.hoisted(() => ({
  acpReadAllConfig: vi.fn(),
  acpReadConfig: vi.fn(),
  acpUpsertConfig: vi.fn(),
  acpRemoveConfig: vi.fn(),
}));
vi.mock('../acp/config', () => configApi);
vi.mock('../acp/providers', () => ({
  acpReadDefaults: vi.fn().mockResolvedValue({ providerId: 'saygm', modelId: 'fixture-model' }),
  acpListProviderDetails: vi.fn().mockResolvedValue([]),
}));
vi.mock('../acp/extensions', () => ({
  getConfiguredExtensions: vi.fn().mockResolvedValue({ extensions: [], warnings: [] }),
  addConfigExtension: vi.fn(),
  removeConfigExtension: vi.fn(),
  setConfigExtensionEnabled: vi.fn(),
}));
vi.mock('./settings/extensions', () => ({
  pruneDeprecatedBundledExtensions: vi.fn().mockImplementation(async (entries) => entries),
  syncBundledExtensions: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./settings/permission/PermissionRulesModal', () => ({ default: () => null }));
vi.mock('./onboarding/WelcomeSetup', () => ({ default: () => <div>Setup fixture</div> }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let stored: Record<string, unknown>;

function renderRealContext() {
  return render(
    <ConfigProvider>
      <OnboardingGuard>
        <LocalToolApprovalsCard />
      </OnboardingGuard>
    </ConfigProvider>,
    { wrapper: IntlTestWrapper }
  );
}

describe('independent approval-mode startup integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stored = {};
    configApi.acpReadAllConfig.mockReset().mockImplementation(async () => ({ ...stored }));
    configApi.acpReadConfig
      .mockReset()
      .mockImplementation(async (key: string) => stored[key] ?? null);
    configApi.acpUpsertConfig
      .mockReset()
      .mockImplementation(async (key: string, value: unknown) => {
        stored[key] = value;
      });
    Object.assign(window.electron, {
      platform: 'linux',
      gmAccount: {
        getStatus: vi.fn().mockResolvedValue({
          connected: true,
          providerConfigured: true,
          secureStorageAvailable: true,
        }),
        onChanged: vi.fn().mockReturnValue(() => undefined),
      },
    });
  });

  it.each(['before default write', 'after default write'] as const)(
    'shows persisted Manual when the initial empty config resolves %s',
    async (ordering) => {
      const initial = deferred<Record<string, unknown>>();
      const write = deferred<void>();
      configApi.acpReadAllConfig.mockImplementationOnce(() => initial.promise);
      configApi.acpUpsertConfig.mockImplementationOnce(async (key: string, value: unknown) => {
        await write.promise;
        stored[key] = value;
      });
      renderRealContext();
      await waitFor(() => expect(configApi.acpReadAllConfig).toHaveBeenCalled());
      await waitFor(() =>
        expect(configApi.acpUpsertConfig).toHaveBeenCalledWith('GOOSE_MODE', 'approve', false)
      );
      if (ordering === 'before default write') await act(async () => initial.resolve({}));
      await act(async () => write.resolve());
      await screen.findByRole('radio', { name: /Manual/ });
      if (ordering === 'after default write') await act(async () => initial.resolve({}));
      expect(stored.GOOSE_MODE).toBe('approve');
      await waitFor(() => expect(screen.getByRole('radio', { name: /Manual/ })).toBeChecked());
      expect(configApi.acpUpsertConfig).toHaveBeenCalledTimes(1);
    }
  );

  it.each([
    ['approve', /Manual/],
    ['smart_approve', /Smart/],
    ['auto', /Autonomous/],
    ['chat', /Chat only/],
  ] as const)('preserves and displays existing %s without a write', async (mode, label) => {
    stored.GOOSE_MODE = mode;
    renderRealContext();
    expect(await screen.findByRole('radio', { name: label })).toBeChecked();
    expect(configApi.acpUpsertConfig).not.toHaveBeenCalled();
  });

  it('does not replace an unrecognized stored mode with a default', async () => {
    stored.GOOSE_MODE = 'future-mode';
    renderRealContext();
    await screen.findByRole('radio', { name: /Manual/ });
    expect(stored.GOOSE_MODE).toBe('future-mode');
    expect(configApi.acpUpsertConfig).not.toHaveBeenCalled();
    for (const radio of screen.getAllByRole('radio')) expect(radio).not.toBeChecked();
  });

  it('does not seed a mode when reading the existing mode fails', async () => {
    configApi.acpReadConfig.mockRejectedValueOnce(new Error('agent not ready'));
    renderRealContext();

    expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(configApi.acpUpsertConfig).not.toHaveBeenCalled();
  });

  it('keeps a valid initial snapshot when a mode write fails during startup', async () => {
    stored.GOOSE_MODE = 'approve';
    const initial = deferred<Record<string, unknown>>();
    configApi.acpReadAllConfig.mockImplementationOnce(() => initial.promise);
    configApi.acpUpsertConfig.mockRejectedValueOnce(new Error('config is read-only'));
    renderRealContext();

    await screen.findByRole('radio', { name: /Manual/ });
    fireEvent.click(screen.getByRole('radio', { name: /Smart/ }));
    await screen.findByRole('alert');
    await act(async () => initial.resolve({ GOOSE_MODE: 'approve' }));

    await waitFor(() => expect(screen.getByRole('radio', { name: /Manual/ })).toBeChecked());
    expect(screen.getByRole('radio', { name: /Smart/ })).not.toBeChecked();
  });

  it('keeps the persisted mode selected when a requested change fails', async () => {
    stored.GOOSE_MODE = 'approve';
    configApi.acpUpsertConfig.mockRejectedValueOnce(new Error('QA write rejected'));
    renderRealContext();
    expect(await screen.findByRole('radio', { name: /Manual/ })).toBeChecked();
    fireEvent.click(screen.getByRole('radio', { name: /Smart/ }));
    await screen.findByRole('alert');
    expect(stored.GOOSE_MODE).toBe('approve');
    expect(screen.getByRole('radio', { name: /Manual/ })).toBeChecked();
    expect(screen.getByRole('radio', { name: /Smart/ })).not.toBeChecked();
    expect(configApi.acpUpsertConfig).toHaveBeenCalledWith('GOOSE_MODE', 'smart_approve', false);
  });
});
