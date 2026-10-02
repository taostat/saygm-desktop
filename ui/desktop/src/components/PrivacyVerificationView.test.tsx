import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../i18n/test-utils';
import type { GmAccountStatus } from '../types/gmAccount';
import PrivacyVerificationView from './PrivacyVerificationView';

const config = vi.hoisted(() => ({
  value: {} as Record<string, unknown>,
  upsert: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./ConfigContext', () => ({
  useConfig: () => ({ config: config.value, upsert: config.upsert }),
}));

vi.mock('./settings/permission/PermissionRulesModal', () => ({
  default: () => null,
}));

const connectedSession: GmAccountStatus = {
  connected: true,
  mode: 'session',
  email: 'person@example.com',
  keyPrefix: null,
  providerConfigured: true,
  secureStorageAvailable: true,
  remoteCleanupPending: false,
};

const accountApi = {
  getStatus: vi.fn(),
  onChanged: vi.fn(() => () => undefined),
  onGuardrailsChanged: vi.fn(() => () => undefined),
  getGuardrails: vi.fn(),
  previewGuardrails: vi.fn(),
  saveGuardrails: vi.fn(),
};

function renderPrivacyView() {
  return render(
    <IntlTestWrapper>
      <PrivacyVerificationView />
    </IntlTestWrapper>
  );
}

describe('PrivacyVerificationView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    config.value = {};
    accountApi.getStatus.mockResolvedValue(connectedSession);
    accountApi.getGuardrails.mockResolvedValue({ body: null, context: 'a'.repeat(64) });
    window.electron.gmAccount = accountApi as unknown as typeof window.electron.gmAccount;
  });

  it('gives guardrails the primary workspace and keeps privacy and local approvals secondary', async () => {
    renderPrivacyView();

    expect(screen.getByRole('heading', { name: 'Guardrails' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Guardrails' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    await waitFor(() => expect(accountApi.getGuardrails).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('navigation', { name: 'Guardrail scanners' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Privacy & local approvals' }));
    expect(screen.getByRole('heading', { name: 'Where your work goes.' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Local tool approvals' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Privacy & local approvals' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    expect(screen.queryByRole('link', { name: /Manage key guardrails/ })).not.toBeInTheDocument();
    expect(
      screen.queryByText(/What this app does not verify|Privacy & Verification page/)
    ).not.toBeInTheDocument();
  });

  it('switches the primary and secondary tabs with arrow keys', async () => {
    renderPrivacyView();
    const guardrailsTab = screen.getByRole('tab', { name: 'Guardrails' });
    fireEvent.keyDown(guardrailsTab, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'Privacy & local approvals' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    expect(screen.getByRole('tab', { name: 'Privacy & local approvals' })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Privacy & local approvals' }), {
      key: 'ArrowLeft',
    });
    expect(screen.getByRole('tab', { name: 'Guardrails' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
  });
});
