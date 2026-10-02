import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../../i18n/test-utils';
import type { GmAccountStatus } from '../../types/gmAccount';
import { Navigation } from './NavigationPanel';

vi.mock('./NavigationContext', () => ({
  useNavigationContext: () => ({ isNavExpanded: true }),
}));

vi.mock('../ConfigContext', () => ({
  useConfig: () => ({ extensionsList: [] }),
}));

vi.mock('../../hooks/useNavigationSessions', () => ({
  useNavigationSessions: () => ({
    recentSessions: [],
    recentSessionsByProject: [],
    isLoadingSessions: false,
    activeSessionId: null,
    fetchSessions: vi.fn(),
    handleNavClick: vi.fn(),
    handleSessionClick: vi.fn(),
  }),
}));

const account = vi.hoisted(() => ({
  getStatus: vi.fn(),
  getBalance: vi.fn(),
  onChanged: vi.fn(() => () => undefined),
}));

function accountStatus(connected: boolean): GmAccountStatus {
  return {
    connected,
    mode: connected ? 'session' : null,
    email: connected ? 'person@example.com' : null,
    keyPrefix: null,
    providerConfigured: connected,
    secureStorageAvailable: true,
    remoteCleanupPending: false,
  };
}

function renderNavigation() {
  return render(
    <MemoryRouter>
      <IntlTestWrapper>
        <Navigation activeLiveVoiceSessionId={null} />
      </IntlTestWrapper>
    </MemoryRouter>
  );
}

describe('Navigation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(window.electron, { gmAccount: account });
  });

  it('shows the account balance beside Account', async () => {
    account.getStatus.mockResolvedValue(accountStatus(true));
    account.getBalance.mockResolvedValue({ kind: 'account', usd: '24.8' });
    renderNavigation();

    expect(await screen.findByRole('button', { name: /Account\s*\$24\.80/ })).toBeInTheDocument();
  });

  it('shows a dash, never a zero, when the balance cannot be read', async () => {
    account.getStatus.mockResolvedValue(accountStatus(true));
    account.getBalance.mockRejectedValue(new Error('customer API unavailable'));
    renderNavigation();

    expect(
      await screen.findByRole('button', { name: /Account.*Balance unavailable/ })
    ).toHaveTextContent('—');
    expect(screen.queryByText(/\$0/)).not.toBeInTheDocument();
  });

  it('shows no balance when no account is connected', async () => {
    account.getStatus.mockResolvedValue(accountStatus(false));
    renderNavigation();

    await waitFor(() => expect(account.getStatus).toHaveBeenCalled());
    expect(account.getBalance).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Account' })).toBeInTheDocument();
  });

  it('labels New chat with the configured shortcut', async () => {
    account.getStatus.mockResolvedValue(accountStatus(false));
    renderNavigation();

    expect(await screen.findByText('⌘T')).toBeInTheDocument();
  });

  it('exposes the Privacy & guardrails page in the navigation', async () => {
    account.getStatus.mockResolvedValue(accountStatus(false));
    renderNavigation();

    expect(await screen.findByRole('button', { name: 'Privacy & guardrails' })).toBeInTheDocument();
  });
});
