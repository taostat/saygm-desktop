import { StrictMode } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GmAccountBalance, GmAccountStatus } from '../../types/gmAccount';
import GMAccount from './GMAccount';

const disconnected: GmAccountStatus = {
  connected: false,
  mode: null,
  email: null,
  keyPrefix: null,
  providerConfigured: false,
  secureStorageAvailable: true,
  remoteCleanupPending: false,
};

const connected: GmAccountStatus = {
  ...disconnected,
  connected: true,
  mode: 'session',
  email: 'person@example.com',
  providerConfigured: true,
};

const balance: GmAccountBalance = { kind: 'account', usd: '12.3456' };

const account = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    getStatus: vi.fn(),
    getBalance: vi.fn(),
    openTopup: vi.fn(),
    onChanged: vi.fn((listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }),
    emitChanged: () => listeners.forEach((listener) => listener()),
    resetListeners: () => listeners.clear(),
    cancelDeviceLogin: vi.fn(),
  };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('GMAccount', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    account.resetListeners();
    account.getStatus.mockResolvedValue(disconnected);
    account.getBalance.mockResolvedValue(balance);
    account.openTopup.mockResolvedValue(undefined);
    account.cancelDeviceLogin.mockResolvedValue(undefined);
    Object.assign(window.electron, { gmAccount: account });
  });

  it('moves focus into the API key field and back to the option that opened it', async () => {
    render(<GMAccount mode="onboarding" />);
    const option = await screen.findByRole('button', { name: 'Use an API key instead' });
    await waitFor(() => expect(option).toBeEnabled());

    await userEvent.click(option);
    expect(screen.getByLabelText('SayGM API key')).toHaveFocus();
    expect(screen.queryByRole('button', { name: /Continue in browser/ })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('button', { name: 'Use an API key instead' })).toHaveFocus();
    expect(screen.getByRole('button', { name: /Continue in browser/ })).toBeInTheDocument();
  });

  it('loads the balance automatically on entry and has no manual refresh action', async () => {
    account.getStatus.mockResolvedValue(connected);
    render(<GMAccount />);

    expect(await screen.findByText('$12.35')).toBeInTheDocument();
    expect(account.getBalance).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Refresh' })).not.toBeInTheDocument();
    expect(screen.getByText(/Updates when this page opens/)).toBeInTheDocument();
  });

  it('rounds displayed balances to two USD decimals and keeps zero explicit', async () => {
    account.getStatus.mockResolvedValue(connected);
    account.getBalance.mockResolvedValueOnce({ ...balance, usd: '2.904496414' });
    const { rerender } = render(<GMAccount />);
    expect(await screen.findByText('$2.90')).toBeInTheDocument();

    account.getBalance.mockResolvedValueOnce({ ...balance, usd: '0' });
    rerender(<GMAccount key="zero-balance" />);
    expect(await screen.findByText('$0.00')).toBeInTheDocument();
  });

  it('coalesces focus events and rate-limits balance reads after success', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const firstBalance = deferred<GmAccountBalance>();
    account.getStatus.mockResolvedValue(connected);
    account.getBalance.mockReturnValueOnce(firstBalance.promise).mockResolvedValue(balance);

    render(<GMAccount />);
    await waitFor(() => expect(account.getBalance).toHaveBeenCalledTimes(1));

    act(() => {
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('focus'));
    });
    expect(account.getBalance).toHaveBeenCalledTimes(1);

    await act(async () => {
      firstBalance.resolve(balance);
      await firstBalance.promise;
    });
    act(() => window.dispatchEvent(new Event('focus')));
    expect(account.getBalance).toHaveBeenCalledTimes(1);

    now.mockReturnValue(61_001);
    act(() => window.dispatchEvent(new Event('focus')));
    await waitFor(() => expect(account.getBalance).toHaveBeenCalledTimes(2));
    now.mockRestore();
  });

  it('refreshes once on return from Add credit even during the balance cooldown', async () => {
    account.getStatus.mockResolvedValue(connected);
    render(<GMAccount />);
    expect(await screen.findByText('$12.35')).toBeInTheDocument();
    expect(account.getBalance).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole('button', { name: 'Add credit on saygm.com' }));
    expect(account.openTopup).toHaveBeenCalledOnce();

    act(() => window.dispatchEvent(new Event('focus')));
    await waitFor(() => expect(account.getBalance).toHaveBeenCalledTimes(2));
    act(() => window.dispatchEvent(new Event('focus')));
    expect(account.getBalance).toHaveBeenCalledTimes(2);
  });

  it('queues one post-topup read when an older balance request is still pending', async () => {
    const oldBalance = deferred<GmAccountBalance>();
    account.getStatus.mockResolvedValue(connected);
    account.getBalance.mockReturnValueOnce(oldBalance.promise).mockResolvedValue(balance);
    render(<GMAccount />);
    await waitFor(() => expect(account.getBalance).toHaveBeenCalledTimes(1));

    await userEvent.click(screen.getByRole('button', { name: 'Add credit on saygm.com' }));
    act(() => window.dispatchEvent(new Event('focus')));
    expect(account.getBalance).toHaveBeenCalledTimes(1);

    await act(async () => {
      oldBalance.resolve(balance);
      await oldBalance.promise;
    });
    await waitFor(() => expect(account.getBalance).toHaveBeenCalledTimes(2));
  });

  it('does not let a top-up return bypass balance failure backoff', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    account.getStatus.mockResolvedValue(connected);
    account.getBalance
      .mockRejectedValueOnce(new Error('temporary balance error'))
      .mockResolvedValue(balance);
    render(<GMAccount />);
    expect(await screen.findByText('Unavailable')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Add credit on saygm.com' }));
    act(() => window.dispatchEvent(new Event('focus')));
    expect(account.getBalance).toHaveBeenCalledTimes(1);

    now.mockReturnValue(60_999);
    act(() => window.dispatchEvent(new Event('focus')));
    expect(account.getBalance).toHaveBeenCalledTimes(1);
    now.mockReturnValue(61_000);
    act(() => window.dispatchEvent(new Event('focus')));
    await waitFor(() => expect(account.getBalance).toHaveBeenCalledTimes(2));
    now.mockRestore();
  });

  it('backs off after a balance failure instead of retrying on every focus', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    account.getStatus.mockResolvedValue(connected);
    account.getBalance.mockRejectedValue(new Error('credential store unavailable'));

    render(<GMAccount />);
    expect(await screen.findByText('Unavailable')).toBeInTheDocument();
    expect(account.getBalance).toHaveBeenCalledTimes(1);

    act(() => {
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('focus'));
    });
    expect(account.getBalance).toHaveBeenCalledTimes(1);

    now.mockReturnValue(60_999);
    act(() => window.dispatchEvent(new Event('focus')));
    expect(account.getBalance).toHaveBeenCalledTimes(1);

    now.mockReturnValue(61_000);
    act(() => window.dispatchEvent(new Event('focus')));
    await waitFor(() => expect(account.getBalance).toHaveBeenCalledTimes(2));
    now.mockRestore();
  });

  it('ignores a balance result from the previous account after logout', async () => {
    const pendingBalance = deferred<GmAccountBalance>();
    account.getStatus.mockResolvedValueOnce(connected).mockResolvedValue(disconnected);
    account.getBalance.mockReturnValue(pendingBalance.promise);

    render(<GMAccount />);
    await waitFor(() => expect(account.getBalance).toHaveBeenCalledTimes(1));
    act(() => account.emitChanged());
    expect(await screen.findByRole('heading', { name: 'Connect SayGM' })).toBeInTheDocument();

    await act(async () => {
      pendingBalance.resolve(balance);
      await pendingBalance.promise;
    });
    expect(screen.queryByText('$12.35')).not.toBeInTheDocument();
    expect(account.getBalance).toHaveBeenCalledTimes(1);
  });

  it('drains account changes that arrive during the initial and queued status reads', async () => {
    const initialStatus = deferred<GmAccountStatus>();
    const secondStatus = deferred<GmAccountStatus>();
    const accountA = { ...connected, email: 'a@example.com' };
    const accountB = { ...connected, email: 'b@example.com' };
    const accountC = { ...connected, email: 'c@example.com' };
    account.getStatus
      .mockReturnValueOnce(initialStatus.promise)
      .mockReturnValueOnce(secondStatus.promise)
      .mockResolvedValue(accountC);

    render(<GMAccount />);
    act(() => account.emitChanged());

    await act(async () => {
      initialStatus.resolve(accountA);
      await initialStatus.promise;
    });
    await waitFor(() => expect(account.getStatus).toHaveBeenCalledTimes(2));
    act(() => account.emitChanged());

    await act(async () => {
      secondStatus.resolve(accountB);
      await secondStatus.promise;
    });
    expect(await screen.findByText('c@example.com')).toBeInTheDocument();
    expect(screen.queryByText('b@example.com')).not.toBeInTheDocument();
    expect(account.getStatus).toHaveBeenCalledTimes(3);
  });

  it('does not start a queued status read after unmount', async () => {
    const initialStatus = deferred<GmAccountStatus>();
    account.getStatus.mockReturnValue(initialStatus.promise);

    const { unmount } = render(<GMAccount />);
    act(() => account.emitChanged());
    unmount();

    await act(async () => {
      initialStatus.resolve(disconnected);
      await initialStatus.promise;
    });
    expect(account.getStatus).toHaveBeenCalledTimes(1);
  });

  it('shares the initial status and balance loads under StrictMode', async () => {
    account.getStatus.mockResolvedValue(connected);
    render(
      <StrictMode>
        <GMAccount />
      </StrictMode>
    );

    expect(await screen.findByText('$12.35')).toBeInTheDocument();
    expect(account.getStatus).toHaveBeenCalledTimes(1);
    expect(account.getBalance).toHaveBeenCalledTimes(1);
  });
});
