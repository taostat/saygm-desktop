import { StrictMode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import GuardrailsPanel from './GuardrailsPanel';
import type { GmAccountStatus, GmCapabilities } from '../types/gmAccount';

const connectedSession: GmAccountStatus = {
  connected: true,
  mode: 'session',
  email: 'customer@saygm.com',
  keyPrefix: null,
  providerConfigured: true,
  secureStorageAvailable: true,
  remoteCleanupPending: false,
  managedKeyAvailable: true,
};

const apiKeyStatus: GmAccountStatus = {
  ...connectedSession,
  mode: 'api_key',
  email: null,
  keyPrefix: 'gm_test_',
};

const signedOutStatus: GmAccountStatus = {
  connected: false,
  mode: null,
  email: null,
  keyPrefix: null,
  providerConfigured: false,
  secureStorageAvailable: true,
  remoteCleanupPending: false,
};

let accountListeners: Array<() => void>;
let guardrailListeners: Array<() => void>;
let accountApi: {
  getStatus: ReturnType<typeof vi.fn>;
  getCapabilities: ReturnType<typeof vi.fn>;
  onChanged: ReturnType<typeof vi.fn>;
  onGuardrailsChanged: ReturnType<typeof vi.fn>;
  getGuardrails: ReturnType<typeof vi.fn>;
  previewGuardrails: ReturnType<typeof vi.fn>;
  saveGuardrails: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  accountListeners = [];
  guardrailListeners = [];
  accountApi = {
    getStatus: vi.fn().mockResolvedValue(connectedSession),
    getCapabilities: vi.fn().mockResolvedValue(guardrailCapabilities()),
    onChanged: vi.fn((listener: () => void) => {
      accountListeners.push(listener);
      return () => {
        accountListeners = accountListeners.filter((item) => item !== listener);
      };
    }),
    onGuardrailsChanged: vi.fn((listener: () => void) => {
      guardrailListeners.push(listener);
      return () => {
        guardrailListeners = guardrailListeners.filter((item) => item !== listener);
      };
    }),
    getGuardrails: vi.fn().mockResolvedValue({ body: null, context: 'a'.repeat(64) }),
    previewGuardrails: vi.fn().mockResolvedValue({
      blocked: false,
      blocked_by: null,
      forwarded_text: 'Contact [EMAIL].',
      returned_text: 'Contact [EMAIL].',
      per_scanner: {
        'native:pii': { detections: 1, redacted: 1, restored: 0, blocked: 0, by_entity_type: {} },
      },
      by_entity_type: {},
      not_run: [],
    }),
    saveGuardrails: vi.fn().mockResolvedValue({
      body: { 'native:ban-substrings': { mode: 'block', substrings: ['blocked'] } },
      context: 'b'.repeat(64),
    }),
  };
  window.electron.gmAccount = accountApi as unknown as typeof window.electron.gmAccount;
});

describe('GuardrailsPanel', () => {
  it('finishes the initial policy load under React StrictMode effect replay', async () => {
    render(
      <StrictMode>
        <GuardrailsPanel />
      </StrictMode>
    );

    expect(await screen.findByRole('checkbox', { name: 'Enable scanner' })).toBeInTheDocument();
    await waitFor(() => expect(accountApi.getGuardrails).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('Loading saved guardrails…')).not.toBeInTheDocument();
  });

  it('tries the customer route when capability discovery is unavailable', async () => {
    accountApi.getCapabilities.mockRejectedValue(new Error('capability discovery unavailable'));
    render(<GuardrailsPanel />);

    expect(await screen.findByRole('checkbox', { name: 'Enable scanner' })).toBeInTheDocument();
    expect(accountApi.getGuardrails).toHaveBeenCalledTimes(1);
  });

  it('does not call a guardrail route when the adapter explicitly reports it unsupported', async () => {
    const capabilities = guardrailCapabilities();
    capabilities.operations[0].adapter_support = 'not_supported';
    capabilities.operations[0].available = false;
    accountApi.getCapabilities.mockResolvedValue(capabilities);
    render(<GuardrailsPanel />);

    expect(
      await screen.findByText(/does not report guardrail policy reads as deployed/)
    ).toBeInTheDocument();
    expect(accountApi.getGuardrails).not.toHaveBeenCalled();
  });

  it('does not call account guardrail routes for an API-key-only connection', async () => {
    accountApi.getStatus.mockResolvedValue(apiKeyStatus);
    render(<GuardrailsPanel />);

    expect(
      await screen.findByText(/Key-only mode does not include account access/)
    ).toBeInTheDocument();
    expect(accountApi.getGuardrails).not.toHaveBeenCalled();
  });

  it('starts from the actual empty policy and saves the chosen mode and list', async () => {
    render(<GuardrailsPanel />);

    await screen.findByRole('heading', { name: 'Personal information' });
    fireEvent.click(screen.getByRole('button', { name: /Blocked words/ }));
    const mode = await screen.findByRole('combobox', { name: 'When a substring matches' });
    expect(mode).toHaveValue('redact');
    fireEvent.click(screen.getByRole('button', { name: 'Add substring' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Substring 1' }), {
      target: { value: 'blocked' },
    });
    fireEvent.change(mode, { target: { value: 'block' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save guardrails' }));

    await waitFor(() =>
      expect(accountApi.saveGuardrails).toHaveBeenCalledWith(
        { 'native:ban-substrings': { mode: 'block', substrings: ['blocked'] } },
        'a'.repeat(64)
      )
    );
    const savedStatus = await screen.findByRole('status');
    expect(savedStatus).toHaveTextContent('Settings saved');
    expect(savedStatus).toHaveTextContent('Changes may take a moment to apply.');
    expect(savedStatus.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(savedStatus).toHaveClass('gm-guardrails-panel__saved');
  });

  it('saves supported scanner modes and preserves hidden topic policy', async () => {
    const topics = {
      mode: 'block',
      topics: [{ name: 'sensitive', keywords: ['term'] }],
      future: 'keep',
    };
    accountApi.getGuardrails.mockResolvedValue({
      body: { 'native:ban-topics': topics },
      context: 'a'.repeat(64),
    });
    render(<GuardrailsPanel />);

    await screen.findByRole('checkbox', { name: 'Enable scanner' });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Enable scanner' }));
    fireEvent.change(
      screen.getByRole('combobox', { name: 'When personal information is detected' }),
      {
        target: { value: 'block' },
      }
    );
    fireEvent.click(screen.getByRole('button', { name: /Secrets/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Enable scanner' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'When a secret is detected' }), {
      target: { value: 'redact-restore' },
    });
    expect(
      screen.getByText(
        'Redact is the default for secrets. Restoring them lets a manipulated model put the real key in a link or tool call.'
      )
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Custom patterns/ }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Regex pattern 1' }), {
      target: { value: '(?i)ORD-\\d+' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Replacement label 1' }), {
      target: { value: 'ORDER_ID' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'When a pattern matches' }), {
      target: { value: 'redact' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Tool result compression/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Enable compression' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save guardrails' }));

    await waitFor(() =>
      expect(accountApi.saveGuardrails).toHaveBeenCalledWith(
        {
          'native:pii': { mode: 'block' },
          'native:secrets': { mode: 'redact-restore' },
          'native:compress-tool-results': {},
          'native:regex': {
            mode: 'redact',
            patterns: [{ pattern: '(?i)ORD-\\d+', label: 'ORDER_ID' }],
          },
          'native:ban-topics': topics,
        },
        'a'.repeat(64)
      )
    );
  });

  it('keeps an enabled regex scanner on while its rule is corrected', async () => {
    const body = {
      'native:regex': { mode: 'redact', patterns: [{ pattern: 'ORDER-\\d+', label: 'ORDER' }] },
    };
    accountApi.getGuardrails.mockResolvedValue({ body, context: 'a'.repeat(64) });
    accountApi.saveGuardrails.mockResolvedValue({ body, context: 'b'.repeat(64) });
    render(<GuardrailsPanel />);

    await screen.findByRole('heading', { name: 'Personal information' });
    fireEvent.click(screen.getByRole('button', { name: /Custom patterns/ }));
    const regexToggle = screen.getByRole('checkbox', { name: 'Enable scanner' });
    expect(regexToggle).toBeChecked();

    const pattern = screen.getByRole('textbox', { name: 'Regex pattern 1' });
    fireEvent.change(pattern, { target: { value: '' } });
    fireEvent.change(pattern, { target: { value: 'ORDER-[0-9]+' } });

    expect(regexToggle).toBeChecked();
    expect(screen.getByRole('button', { name: 'Save guardrails' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Save guardrails' }));

    await waitFor(() =>
      expect(accountApi.saveGuardrails).toHaveBeenCalledWith(
        {
          'native:regex': {
            mode: 'redact',
            patterns: [{ pattern: 'ORDER-[0-9]+', label: 'ORDER' }],
          },
        },
        'a'.repeat(64)
      )
    );
  });

  it('blocks saving an enabled regex scanner when an additional row is partial', async () => {
    const body = {
      'native:regex': { mode: 'redact', patterns: [{ pattern: 'ORDER-\\d+', label: 'ORDER' }] },
    };
    accountApi.getGuardrails.mockResolvedValue({ body, context: 'a'.repeat(64) });
    render(<GuardrailsPanel />);

    await screen.findByRole('heading', { name: 'Personal information' });
    fireEvent.click(screen.getByRole('button', { name: /Custom patterns/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Add regex rule' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Regex pattern 2' }), {
      target: { value: 'ORDER-[0-9]+' },
    });
    expect(screen.getByRole('button', { name: 'Save guardrails' })).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox', { name: 'Replacement label 2' }), {
      target: { value: 'ORDER_ID' },
    });
    expect(screen.getByRole('button', { name: 'Save guardrails' })).toBeEnabled();
  });

  it('allows an unrelated toggle while preserving an inactive legacy word policy', async () => {
    const body = {
      'native:ban-substrings': {
        mode: 'log-only',
        substrings: ['legacy phrase'],
        custom: 'retain',
      },
    };
    accountApi.getGuardrails.mockResolvedValue({ body, context: 'a'.repeat(64) });
    accountApi.saveGuardrails.mockResolvedValue({
      body: { ...body, 'native:pii': { mode: 'redact' } },
      context: 'b'.repeat(64),
    });
    render(<GuardrailsPanel />);

    await screen.findByRole('heading', { name: 'Personal information' });
    fireEvent.click(screen.getByRole('button', { name: /Blocked words/ }));
    await screen.findByText(/saved mode “log-only” is not supported/i);
    fireEvent.click(screen.getByRole('button', { name: /Personal information/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Enable scanner' }));
    expect(screen.getByRole('button', { name: 'Save guardrails' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Save guardrails' }));

    await waitFor(() =>
      expect(accountApi.saveGuardrails).toHaveBeenCalledWith(
        {
          ...body,
          'native:pii': { mode: 'redact-restore' },
        },
        'a'.repeat(64)
      )
    );
  });

  it('keeps an unsaved draft visible when the account API rejects a save', async () => {
    accountApi.saveGuardrails.mockRejectedValue(new Error('SayGM policy service unavailable'));
    render(<GuardrailsPanel />);

    await screen.findByRole('heading', { name: 'Personal information' });
    fireEvent.click(screen.getByRole('button', { name: /Blocked words/ }));
    const mode = await screen.findByRole('combobox', { name: 'When a substring matches' });
    fireEvent.click(screen.getByRole('button', { name: 'Add substring' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Substring 1' }), {
      target: { value: 'draft phrase' },
    });
    fireEvent.change(mode, { target: { value: 'redact' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save guardrails' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('SayGM policy service unavailable');
    expect(screen.getByRole('textbox', { name: 'Substring 1' })).toHaveValue('draft phrase');
    expect(screen.queryByText('Settings saved')).not.toBeInTheDocument();
  });

  it('keeps the current word draft on focus while showing its configured default action', async () => {
    render(<GuardrailsPanel />);
    await screen.findByRole('heading', { name: 'Personal information' });
    fireEvent.click(screen.getByRole('button', { name: /Blocked words/ }));
    await screen.findByRole('combobox', { name: 'When a substring matches' });
    fireEvent.click(screen.getByRole('button', { name: 'Add substring' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Substring 1' }), {
      target: { value: 'incomplete phrase' },
    });

    act(() => window.dispatchEvent(new Event('focus')));

    expect(screen.getByRole('textbox', { name: 'Substring 1' })).toHaveValue('incomplete phrase');
    expect(accountApi.getGuardrails).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Discard changes' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Save guardrails' })).toBeEnabled();
  });

  it('reloads saved policy on focus without exposing a normal Refresh action', async () => {
    render(<GuardrailsPanel />);
    await screen.findByRole('heading', { name: 'Personal information' });
    await waitFor(() => expect(accountApi.getGuardrails).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('button', { name: 'Refresh' })).not.toBeInTheDocument();

    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(accountApi.getGuardrails).toHaveBeenCalledTimes(2));
  });

  it('coalesces repeated focus events while the initial status load is pending', async () => {
    let resolveStatus!: (status: GmAccountStatus) => void;
    accountApi.getStatus.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveStatus = resolve;
      })
    );
    render(<GuardrailsPanel />);
    await waitFor(() => expect(accountApi.getStatus).toHaveBeenCalledTimes(1));

    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('focus'));
      resolveStatus(connectedSession);
    });

    await waitFor(() => expect(accountApi.getGuardrails).toHaveBeenCalledTimes(1));
    expect(accountApi.getStatus).toHaveBeenCalledTimes(1);
  });

  it('rechecks once after an account event supersedes an in-flight status read', async () => {
    let resolveStatus!: (status: GmAccountStatus) => void;
    accountApi.getStatus
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveStatus = resolve;
        })
      )
      .mockResolvedValue(signedOutStatus);
    render(<GuardrailsPanel />);
    await waitFor(() => expect(accountApi.getStatus).toHaveBeenCalledTimes(1));

    await act(async () => {
      accountListeners.forEach((listener) => listener());
      resolveStatus(connectedSession);
    });

    expect(
      await screen.findByText('Connect your SayGM account to load managed-key guardrails.')
    ).toBeInTheDocument();
    expect(accountApi.getStatus).toHaveBeenCalledTimes(2);
    expect(accountApi.getGuardrails).not.toHaveBeenCalled();
  });

  it('shows a status-load failure instead of labeling it signed out', async () => {
    accountApi.getStatus.mockRejectedValue(new Error('OS secure storage is unavailable'));
    render(<GuardrailsPanel />);

    expect(await screen.findByRole('alert')).toHaveTextContent('OS secure storage is unavailable');
    expect(
      screen.queryByText('Connect your SayGM account to load managed-key guardrails.')
    ).not.toBeInTheDocument();
  });

  it('previews only the selected scanner draft and clears results when the sample changes', async () => {
    render(<GuardrailsPanel />);
    await screen.findByRole('heading', { name: 'Personal information' });
    expect(
      screen.getByRole('combobox', { name: 'When personal information is detected' })
    ).toHaveValue('redact-restore');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Enable scanner' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Sample text' }), {
      target: { value: 'my email is alex@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Test draft' }));

    await waitFor(() =>
      expect(accountApi.previewGuardrails).toHaveBeenCalledWith(
        'native:pii',
        { 'native:pii': { mode: 'redact-restore' } },
        'my email is alex@example.com',
        'a'.repeat(64)
      )
    );
    expect(await screen.findByText('Scanner preview complete')).toBeInTheDocument();
    expect(screen.getByText('What the model would see')).toBeInTheDocument();

    fireEvent.change(screen.getByRole('textbox', { name: 'Sample text' }), {
      target: { value: 'changed sample' },
    });
    expect(screen.queryByText('Scanner preview complete')).not.toBeInTheDocument();
  });

  it('previews a disabled scanner without changing its saved enable state', async () => {
    render(<GuardrailsPanel />);
    await screen.findByRole('heading', { name: 'Personal information' });

    const enabled = screen.getByRole('checkbox', { name: 'Enable scanner' });
    expect(enabled).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Save guardrails' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Test draft' }));

    await waitFor(() =>
      expect(accountApi.previewGuardrails).toHaveBeenCalledWith(
        'native:pii',
        { 'native:pii': { mode: 'redact-restore' } },
        'Contact Alex at alex@example.com or 415-555-0132.',
        'a'.repeat(64)
      )
    );
    expect(enabled).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Save guardrails' })).toBeDisabled();
  });

  it('requires supported, complete word settings before previewing', async () => {
    accountApi.getGuardrails.mockResolvedValue({
      body: { 'native:ban-substrings': { mode: 'log-only', substrings: ['blocked'] } },
      context: 'a'.repeat(64),
    });
    render(<GuardrailsPanel />);
    await screen.findByRole('heading', { name: 'Personal information' });
    fireEvent.click(screen.getByRole('button', { name: /Blocked words/ }));

    expect(await screen.findByText(/saved mode “log-only” is not supported/i)).toBeInTheDocument();
    expect(screen.getByText('Complete this scanner’s settings to preview it.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Test draft' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save guardrails' })).toBeDisabled();
    expect(accountApi.previewGuardrails).not.toHaveBeenCalled();
  });

  it('does not preview a word scanner without a matching substring', async () => {
    accountApi.getGuardrails.mockResolvedValue({
      body: { 'native:ban-substrings': { mode: 'redact', substrings: [] } },
      context: 'a'.repeat(64),
    });
    render(<GuardrailsPanel />);
    await screen.findByRole('heading', { name: 'Personal information' });
    fireEvent.click(screen.getByRole('button', { name: /Blocked words/ }));

    expect(screen.getByText('Complete this scanner’s settings to preview it.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Test draft' })).toBeDisabled();
    expect(accountApi.previewGuardrails).not.toHaveBeenCalled();
  });

  it('does not treat not-run preview output as a successful test', async () => {
    accountApi.previewGuardrails.mockResolvedValue({
      blocked: false,
      blocked_by: null,
      forwarded_text: null,
      returned_text: null,
      per_scanner: {},
      by_entity_type: {},
      not_run: ['native:pii'],
    });
    render(<GuardrailsPanel />);
    await screen.findByRole('heading', { name: 'Personal information' });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Enable scanner' }));
    fireEvent.click(screen.getByRole('button', { name: 'Test draft' }));

    expect(await screen.findByText(/did not run in this preview/)).toBeInTheDocument();
    expect(screen.queryByText('Scanner preview complete')).not.toBeInTheDocument();
  });

  it('can preview one scanner while an unrelated scanner draft is incomplete', async () => {
    render(<GuardrailsPanel />);
    await screen.findByRole('heading', { name: 'Personal information' });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Enable scanner' }));
    fireEvent.click(screen.getByRole('button', { name: /Custom patterns/ }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Regex pattern 1' }), {
      target: { value: 'ORDER-[0-9]+' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Replacement label 1' }), {
      target: { value: 'ORDER' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'When a pattern matches' }), {
      target: { value: 'redact' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add regex rule' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Regex pattern 2' }), {
      target: { value: 'INVOICE-[0-9]+' },
    });
    expect(screen.getByRole('button', { name: 'Save guardrails' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: /Personal information/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Test draft' }));

    await waitFor(() =>
      expect(accountApi.previewGuardrails).toHaveBeenCalledWith(
        'native:pii',
        { 'native:pii': { mode: 'redact-restore' } },
        expect.any(String),
        'a'.repeat(64)
      )
    );
  });

  it('discards a preview response and clears its sample after an account change', async () => {
    let resolvePreview!: (value: {
      blocked: boolean;
      blocked_by: string | null;
      forwarded_text: string | null;
      returned_text: string | null;
      per_scanner: Record<string, never>;
      by_entity_type: Record<string, never>;
      not_run: string[];
    }) => void;
    accountApi.previewGuardrails.mockReturnValue(
      new Promise((resolve) => {
        resolvePreview = resolve;
      })
    );
    render(<GuardrailsPanel />);
    await screen.findByRole('heading', { name: 'Personal information' });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Enable scanner' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Sample text' }), {
      target: { value: 'account A sample' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Test draft' }));
    await waitFor(() => expect(accountApi.previewGuardrails).toHaveBeenCalledTimes(1));

    accountApi.getStatus.mockResolvedValue(signedOutStatus);
    await act(async () => {
      accountListeners.forEach((listener) => listener());
    });
    expect(
      await screen.findByText('Connect your SayGM account to load managed-key guardrails.')
    ).toBeInTheDocument();
    await act(async () => {
      resolvePreview({
        blocked: false,
        blocked_by: null,
        forwarded_text: 'stale result',
        returned_text: 'stale result',
        per_scanner: {},
        by_entity_type: {},
        not_run: [],
      });
    });

    expect(screen.queryByText('stale result')).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue('account A sample')).not.toBeInTheDocument();
  });

  it('does not offer text previews for compression', async () => {
    render(<GuardrailsPanel />);
    await screen.findByRole('heading', { name: 'Personal information' });
    fireEvent.click(screen.getByRole('button', { name: /Tool result compression/ }));

    expect(screen.getByText(/does not scan free text/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Test draft' })).not.toBeInTheDocument();
    expect(accountApi.previewGuardrails).not.toHaveBeenCalled();
  });

  it('does not restore a stale policy response after a cross-window logout', async () => {
    let resolvePolicy!: (value: { body: Record<string, unknown>; context: string }) => void;
    accountApi.getStatus.mockResolvedValueOnce(connectedSession).mockResolvedValue(signedOutStatus);
    accountApi.getGuardrails.mockReturnValueOnce(
      new Promise((resolve) => {
        resolvePolicy = resolve;
      })
    );
    render(<GuardrailsPanel />);
    await waitFor(() => expect(accountApi.getGuardrails).toHaveBeenCalledTimes(1));

    await act(async () => {
      accountListeners.forEach((listener) => listener());
      resolvePolicy({
        body: { 'native:ban-substrings': { mode: 'block', substrings: ['stale phrase'] } },
        context: 'c'.repeat(64),
      });
    });

    await waitFor(() =>
      expect(
        screen.getByText('Connect your SayGM account to load managed-key guardrails.')
      ).toBeInTheDocument()
    );
    expect(screen.queryByDisplayValue('stale phrase')).not.toBeInTheDocument();
    expect(accountApi.saveGuardrails).not.toHaveBeenCalled();
  });

  it('prevents saving a draft changed in another window until it is reloaded', async () => {
    render(<GuardrailsPanel />);
    await screen.findByRole('heading', { name: 'Personal information' });
    fireEvent.click(screen.getByRole('button', { name: /Blocked words/ }));
    const mode = await screen.findByRole('combobox', { name: 'When a substring matches' });
    fireEvent.click(screen.getByRole('button', { name: 'Add substring' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Substring 1' }), {
      target: { value: 'my draft' },
    });
    fireEvent.change(mode, { target: { value: 'block' } });

    act(() => guardrailListeners.forEach((listener) => listener()));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Guardrails changed in another window'
    );
    expect(screen.getByRole('button', { name: 'Save guardrails' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'Substring 1' })).toHaveValue('my draft');
  });
});

function guardrailCapabilities(): GmCapabilities {
  const operations = [
    ['guardrails.key.read', 'GET', '/v1/keys/{id}/guardrails'],
    ['guardrails.key.write', 'PUT', '/v1/keys/{id}/guardrails'],
    ['guardrails.draft_preview', 'POST', '/v1/keys/{id}/guardrails/preview'],
  ] as const;
  return {
    contract_version: 1,
    operations: operations.map(([operationId, method, path]) => ({
      operation_id: operationId,
      method,
      path,
      adapter_support: 'supported',
      entitlement_state: 'unknown',
      dependency_state: 'unknown',
      available: null,
      availability_reason: 'Dependency health is unknown.',
    })),
  };
}
