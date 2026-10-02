import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../i18n/test-utils';
import { LocalToolApprovalsCard } from './LocalToolApprovalsCard';

const configState = vi.hoisted(() => ({
  config: {} as Record<string, unknown>,
  upsert: vi.fn(),
}));

vi.mock('./ConfigContext', () => ({
  useConfig: () => ({ config: configState.config, upsert: configState.upsert }),
}));

vi.mock('./settings/permission/PermissionRulesModal', () => ({
  default: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? <div role="dialog" aria-label="Permission rules" /> : null,
}));

function renderCard() {
  return render(<LocalToolApprovalsCard />, { wrapper: IntlTestWrapper });
}

describe('LocalToolApprovalsCard', () => {
  beforeEach(() => {
    configState.config = {};
    configState.upsert.mockReset();
    configState.upsert.mockResolvedValue(undefined);
    Object.assign(window.electron, { platform: 'darwin' });
  });

  it.each([
    ['darwin', 'This Mac', 'Decide when tools on this Mac can act. Set here, stored here.'],
    [
      'linux',
      'This computer',
      'Decide when tools on this computer can act. Set here, stored here.',
    ],
    [
      'win32',
      'This computer',
      'Decide when tools on this computer can act. Set here, stored here.',
    ],
  ])('uses accurate local-device wording on %s', (platform, scope, description) => {
    Object.assign(window.electron, { platform });
    renderCard();

    expect(screen.getByText(scope)).toBeInTheDocument();
    expect(screen.getByText(description)).toBeInTheDocument();
  });

  it('marks the stored approval mode as selected', () => {
    configState.config = { GOOSE_MODE: 'approve' };
    renderCard();

    expect(screen.getByRole('radio', { name: /Manual/ })).toBeChecked();
    expect(screen.getByRole('radio', { name: /Autonomous/ })).not.toBeChecked();
  });

  it('selects nothing when no mode has been stored', () => {
    renderCard();

    for (const radio of screen.getAllByRole('radio')) {
      expect(radio).not.toBeChecked();
    }
  });

  it('stores the chosen mode as GOOSE_MODE', async () => {
    configState.config = { GOOSE_MODE: 'approve' };
    renderCard();

    await userEvent.click(screen.getByRole('radio', { name: /Smart/ }));

    expect(configState.upsert).toHaveBeenCalledWith('GOOSE_MODE', 'smart_approve', false);
  });

  it('reports a mode that could not be stored', async () => {
    configState.upsert.mockRejectedValue(new Error('config is read-only'));
    renderCard();

    await userEvent.click(screen.getByRole('radio', { name: /Chat only/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not change the approval mode. Try again.'
    );
  });

  it('opens the per-tool permission rules', async () => {
    renderCard();

    await userEvent.click(screen.getByRole('button', { name: 'Review rules' }));

    expect(screen.getByRole('dialog', { name: 'Permission rules' })).toBeInTheDocument();
  });
});
