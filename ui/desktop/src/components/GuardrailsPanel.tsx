import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  GmAccountStatus,
  GmCapabilities,
  GmGuardrailsMode,
  GmGuardrailsPreviewResponse,
  GmGuardrailsPreviewScannerId,
  GmGuardrailsPolicySnapshot,
} from '../types/gmAccount';
import {
  applyGuardrailsDraft,
  emptyGuardrailsDraft,
  hasIncompleteRegexRules,
  hasValidRegexRules,
  hasValidWords,
  readGuardrailsPolicy,
  sameDraft,
  type GuardrailsDraft,
  type ScannerChange,
  type ScannerChanges,
} from '../services/guardrailsPolicy';

const REGEX_SCANNER_ID = 'native:regex';
const TOPICS_SCANNER_ID = 'native:ban-topics';
const PII_SCANNER_ID = 'native:pii';
const SECRETS_SCANNER_ID = 'native:secrets';

type ScannerId = 'pii' | 'secrets' | 'regex' | 'words' | 'compress';
type CapabilityIssue = 'unsupported' | 'unavailable';

const SCANNERS: Array<{ id: ScannerId; title: string; description: string }> = [
  { id: 'pii', title: 'Personal information', description: 'Detect and transform personal data.' },
  { id: 'secrets', title: 'Secrets', description: 'Detect credentials and secret values.' },
  { id: 'regex', title: 'Custom patterns', description: 'Apply your own regular expressions.' },
  { id: 'words', title: 'Blocked words', description: 'Redact matches or block the request.' },
  { id: 'compress', title: 'Tool result compression', description: 'Reduce large tool responses.' },
];

const PREVIEW_SCANNER: Partial<Record<ScannerId, GmGuardrailsPreviewScannerId>> = {
  pii: 'native:pii',
  secrets: 'native:secrets',
  regex: 'native:regex',
  words: 'native:ban-substrings',
};

const PREVIEW_SAMPLE: Record<Exclude<ScannerId, 'compress'>, string> = {
  pii: 'Contact Alex at alex@example.com or 415-555-0132.',
  secrets: 'Use the AWS example credential AKIAIOSFODNN7EXAMPLE in this request.',
  regex: 'ORD-12345',
  words: '',
};

export default function GuardrailsPanel() {
  const [account, setAccount] = useState<GmAccountStatus | null>(null);
  const [capabilities, setCapabilities] = useState<GmCapabilities | null>(null);
  const [capabilityBlock, setCapabilityBlock] = useState<CapabilityIssue | null>(null);
  const [snapshot, setSnapshot] = useState<GmGuardrailsPolicySnapshot | null>(null);
  const [draft, setDraft] = useState<GuardrailsDraft>(emptyGuardrailsDraft);
  const [changes, setChanges] = useState<ScannerChanges>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [selectedScanner, setSelectedScanner] = useState<ScannerId>('pii');
  const [previewText, setPreviewText] = useState(PREVIEW_SAMPLE.pii);
  const [previewResult, setPreviewResult] = useState<GmGuardrailsPreviewResponse | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const previewGeneration = useRef(0);
  const generation = useRef(0);
  const mounted = useRef(false);
  const loadingRef = useRef(false);
  const activeRefreshGeneration = useRef<number | null>(null);
  const refreshQueued = useRef(false);
  const savingRef = useRef(false);
  const queuedRefresh = useRef(false);
  const queuedNotice = useRef(false);

  const editedBody = useMemo(() => {
    try {
      return snapshot ? applyGuardrailsDraft(snapshot.body, draft, changes) : null;
    } catch {
      return null;
    }
  }, [changes, draft, snapshot]);
  const hasLocalChanges = Object.values(changes).some(Boolean);
  const isDraftDirty =
    !!snapshot && (hasLocalChanges || !sameDraft(draft, readGuardrailsPolicy(snapshot.body)));
  const isPolicyDirty =
    !!snapshot &&
    !!editedBody &&
    JSON.stringify(editedBody) !== JSON.stringify(snapshot.body ?? {});
  const hasWords = draft.substrings.some((item) => item.trim().length > 0);
  const invalidWords =
    !!changes.words && hasWords && !hasValidWords(draft.wordMode, draft.substrings);
  const invalidRegex =
    !!changes.regex &&
    draft.regexEnabled &&
    (!hasValidRegexRules(draft.patterns) || hasIncompleteRegexRules(draft.patterns));
  const previewIssue = capabilities
    ? capabilityIssue(capabilities, 'guardrails.draft_preview')
    : null;
  const writeIssue = capabilities ? capabilityIssue(capabilities, 'guardrails.key.write') : null;
  const previewAvailable = !!account?.managedKeyAvailable && !previewIssue;

  const refresh = useCallback(async () => {
    if (loadingRef.current) return;
    const requestGeneration = ++generation.current;
    loadingRef.current = true;
    activeRefreshGeneration.current = requestGeneration;
    previewGeneration.current += 1;
    setPreviewResult(null);
    setPreviewError(null);
    setPreviewing(false);
    setLoading(true);
    setError(null);
    setCapabilities(null);
    setCapabilityBlock(null);
    setSaved(false);
    setConflict(false);
    try {
      const status = await window.electron.gmAccount.getStatus();
      if (!mounted.current || generation.current !== requestGeneration) return;
      setAccount(status);
      if (!status.connected || status.mode !== 'session' || !status.providerConfigured) {
        setSnapshot(null);
        setDraft(emptyGuardrailsDraft());
        setChanges({});
        return;
      }

      let discovered: GmCapabilities | null = null;
      try {
        discovered = await window.electron.gmAccount.getCapabilities();
      } catch {
        // The route request below is the source of truth if capability discovery is unavailable.
      }
      if (!mounted.current || generation.current !== requestGeneration) return;
      setCapabilities(discovered);
      const readIssue = discovered ? capabilityIssue(discovered, 'guardrails.key.read') : null;
      if (readIssue) {
        setCapabilityBlock(readIssue);
        setSnapshot(null);
        setDraft(emptyGuardrailsDraft());
        setChanges({});
        return;
      }

      const policy = await window.electron.gmAccount.getGuardrails();
      if (!mounted.current || generation.current !== requestGeneration) return;
      setSnapshot(policy);
      setDraft(readGuardrailsPolicy(policy.body));
      setChanges({});
    } catch (cause) {
      if (!mounted.current || generation.current !== requestGeneration) return;
      setSnapshot(null);
      setError(errorText(cause));
    } finally {
      if (activeRefreshGeneration.current === requestGeneration) {
        activeRefreshGeneration.current = null;
        loadingRef.current = false;
        if (refreshQueued.current && mounted.current) {
          refreshQueued.current = false;
          void refresh();
        } else if (mounted.current && generation.current === requestGeneration) {
          setLoading(false);
        }
      }
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const unsubscribe = window.electron.gmAccount.onChanged(() => {
      invalidatePreview();
      setPreviewText('');
      if (savingRef.current) {
        generation.current += 1;
        queuedRefresh.current = true;
        return;
      }
      const discardedDraft = isDirtyRef.current;
      generation.current += 1;
      setSnapshot(null);
      setDraft(emptyGuardrailsDraft());
      setChanges({});
      setConflict(false);
      setNotice(
        discardedDraft
          ? 'Your SayGM account changed. Unsaved guardrail edits were discarded.'
          : null
      );
      if (loadingRef.current) refreshQueued.current = true;
      else void refresh();
    });
    const unsubscribeGuardrails = window.electron.gmAccount.onGuardrailsChanged(() => {
      invalidatePreview();
      if (savingRef.current) {
        generation.current += 1;
        queuedRefresh.current = true;
        queuedNotice.current = true;
        return;
      }
      if (isDirtyRef.current) {
        setConflict(true);
        setError(
          'Guardrails changed in another window. Reload the saved settings before saving this draft.'
        );
        return;
      }
      generation.current += 1;
      setSnapshot(null);
      setNotice('Guardrails changed in another window. Showing the latest saved settings.');
      if (loadingRef.current) refreshQueued.current = true;
      else void refresh();
    });
    const onFocus = () => {
      if (!isDirtyRef.current && !savingRef.current && !loadingRef.current) void refresh();
    };
    window.addEventListener('focus', onFocus);
    return () => {
      mounted.current = false;
      generation.current += 1;
      previewGeneration.current += 1;
      refreshQueued.current = false;
      if (activeRefreshGeneration.current !== null) {
        activeRefreshGeneration.current = null;
        loadingRef.current = false;
      }
      unsubscribe();
      unsubscribeGuardrails();
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh]);

  const isDirtyRef = useRef(false);
  isDirtyRef.current = isDraftDirty;

  const save = async () => {
    if (
      !snapshot ||
      !editedBody ||
      !isPolicyDirty ||
      writeIssue ||
      invalidWords ||
      invalidRegex ||
      savingRef.current
    )
      return;
    const requestGeneration = generation.current;
    invalidatePreview();
    savingRef.current = true;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const result = await window.electron.gmAccount.saveGuardrails(editedBody, snapshot.context);
      if (!mounted.current || generation.current !== requestGeneration || queuedRefresh.current)
        return;
      setSnapshot(result);
      setDraft(readGuardrailsPolicy(result.body));
      setChanges({});
      setSaved(true);
    } catch (cause) {
      if (mounted.current && generation.current === requestGeneration) setError(errorText(cause));
    } finally {
      savingRef.current = false;
      if (mounted.current) setSaving(false);
      if (queuedRefresh.current && mounted.current) {
        queuedRefresh.current = false;
        if (queuedNotice.current) {
          queuedNotice.current = false;
          setNotice('Guardrails changed in another window. Showing the latest saved settings.');
        }
        void refresh();
      }
    }
  };

  const editDraft = (
    scanner: ScannerChange,
    update: (current: GuardrailsDraft) => GuardrailsDraft
  ) => {
    invalidatePreview();
    setDraft(update);
    setChanges((current) => ({ ...current, [scanner]: true }));
    setSaved(false);
    setNotice(null);
    setError(null);
  };

  const invalidatePreview = () => {
    previewGeneration.current += 1;
    setPreviewResult(null);
    setPreviewError(null);
    setPreviewing(false);
  };

  const selectScanner = (scanner: ScannerId) => {
    invalidatePreview();
    setSelectedScanner(scanner);
    if (scanner === 'compress') {
      setPreviewText('');
    } else if (scanner === 'words') {
      const example = draft.substrings.find((value) => value.trim().length > 0);
      setPreviewText(example ? 'This sample contains ' + example + '.' : '');
    } else {
      setPreviewText(PREVIEW_SAMPLE[scanner]);
    }
  };

  const loadPreviewExample = () => {
    invalidatePreview();
    if (selectedScanner === 'compress') return;
    if (selectedScanner === 'words') {
      const example = draft.substrings.find((value) => value.trim().length > 0);
      setPreviewText(example ? 'This sample contains ' + example + '.' : '');
      return;
    }
    setPreviewText(PREVIEW_SAMPLE[selectedScanner]);
  };

  const getPreviewConfig = (): Record<string, unknown> | null => {
    const scannerId = PREVIEW_SCANNER[selectedScanner];
    if (!scannerId || !snapshot) return null;
    let previewDraft = draft;
    if (selectedScanner === 'pii') {
      if (draft.piiLegacyMode) return null;
      previewDraft = { ...draft, piiEnabled: true };
    } else if (selectedScanner === 'secrets') {
      if (draft.secretsLegacyMode) return null;
      previewDraft = { ...draft, secretsEnabled: true };
    } else if (selectedScanner === 'regex') {
      if (draft.regexLegacyMode) return null;
      previewDraft = { ...draft, regexEnabled: true };
    } else if (selectedScanner === 'words' && !hasValidWords(draft.wordMode, draft.substrings)) {
      return null;
    }
    let scannerBody: Record<string, unknown>;
    try {
      const isolatedChanges: ScannerChanges = {
        pii: selectedScanner === 'pii' ? true : undefined,
        secrets: selectedScanner === 'secrets' ? true : undefined,
        regex: selectedScanner === 'regex' ? true : undefined,
        words: selectedScanner === 'words' ? true : undefined,
      };
      scannerBody = applyGuardrailsDraft(snapshot.body, previewDraft, isolatedChanges);
    } catch {
      return null;
    }
    const value = scannerBody[scannerId];
    if (!isRecord(value)) return null;
    const selectedMode =
      selectedScanner === 'pii'
        ? draft.piiMode
        : selectedScanner === 'secrets'
          ? draft.secretsMode
          : selectedScanner === 'regex'
            ? draft.regexMode
            : draft.wordMode;
    if (!selectedMode) return null;
    return { ...value, mode: selectedMode };
  };

  const runPreview = async () => {
    const scannerId = PREVIEW_SCANNER[selectedScanner];
    const scannerConfig = getPreviewConfig();
    if (!scannerId || !scannerConfig || !snapshot || !previewAvailable) return;
    if (!previewText.trim()) return;

    const requestGeneration = ++previewGeneration.current;
    setPreviewing(true);
    setPreviewResult(null);
    setPreviewError(null);
    try {
      const result = await window.electron.gmAccount.previewGuardrails(
        scannerId,
        { [scannerId]: scannerConfig },
        previewText,
        snapshot.context
      );
      if (previewGeneration.current !== requestGeneration) return;
      setPreviewResult(result);
    } catch (cause) {
      if (previewGeneration.current !== requestGeneration) return;
      setPreviewError(errorText(cause));
    } finally {
      if (previewGeneration.current === requestGeneration) setPreviewing(false);
    }
  };

  const canEdit = account?.connected && account.mode === 'session' && account.providerConfigured;
  const loadFailed = !!error && !snapshot;
  const disabled = !canEdit || loading || saving;
  const hasSaved = (scannerId: string) =>
    !!snapshot?.body && Object.prototype.hasOwnProperty.call(snapshot.body, scannerId);

  const selected = SCANNERS.find((scanner) => scanner.id === selectedScanner) ?? SCANNERS[0];
  const previewScannerId = PREVIEW_SCANNER[selectedScanner];
  const previewConfig = getPreviewConfig();
  const canPreview =
    !!previewScannerId &&
    !!snapshot &&
    previewAvailable &&
    !!previewConfig &&
    previewText.trim().length > 0 &&
    !loading &&
    !saving;
  const scannerEnabled = (id: ScannerId) => {
    if (id === 'pii') return draft.piiEnabled;
    if (id === 'secrets') return draft.secretsEnabled;
    if (id === 'regex') return draft.regexEnabled;
    if (id === 'words') return hasWords && !!draft.wordMode;
    return draft.compressEnabled;
  };
  const scannerState = (id: ScannerId) => {
    if (id === 'pii' && draft.piiLegacyMode) return 'Needs review';
    if (id === 'secrets' && draft.secretsLegacyMode) return 'Needs review';
    if (id === 'regex' && hasSaved(REGEX_SCANNER_ID) && !draft.regexEnabled) return 'Needs review';
    if (id === 'words' && draft.wordUnsupportedMode) return 'Needs review';
    return scannerEnabled(id) ? 'On' : 'Off';
  };
  const modeSelect = (
    label: string,
    value: GmGuardrailsMode,
    onChange: (mode: GmGuardrailsMode) => void
  ) => (
    <label className="gm-guardrails-panel__mode">
      <span className="gm-guardrails-panel__field-label">{label}</span>
      <select
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value as GmGuardrailsMode)}
        disabled={disabled}
      >
        <option value="redact">Redact</option>
        <option value="redact-restore">Redact &amp; restore</option>
        <option value="block">Block</option>
      </select>
    </label>
  );

  return (
    <section
      className="gm-guardrails-panel"
      aria-labelledby="gm-guardrails-title"
      aria-busy={loading || saving}
    >
      <header className="gm-guardrails-panel__header">
        <div>
          <p className="gm-guardrails-panel__eyebrow">Inference policy</p>
          <h2 id="gm-guardrails-title" className="gm-guardrails-panel__title">
            Guardrails
          </h2>
          <p className="gm-guardrails-panel__description">
            Configure how SayGM handles model input and output. Local tool approvals are separate.
          </p>
        </div>
      </header>

      {loading ? (
        <p role="status" className="gm-guardrails-panel__status">
          Loading saved guardrails…
        </p>
      ) : loadFailed ? (
        <div className="gm-guardrails-panel__error" role="alert">
          <p>{error}</p>
          <button type="button" onClick={() => void refresh()} disabled={loading}>
            Retry
          </button>
        </div>
      ) : !account?.connected ? (
        <p className="gm-guardrails-panel__status">
          Connect your SayGM account to load managed-key guardrails.
        </p>
      ) : account.mode === 'api_key' ? (
        <p className="gm-guardrails-panel__status">
          Native guardrail controls need a browser-connected SayGM account and a managed key.
          Key-only mode does not include account access for this policy.
        </p>
      ) : !account.providerConfigured ? (
        <p className="gm-guardrails-panel__status">
          Finish SayGM model setup before managing guardrails.
        </p>
      ) : capabilityBlock === 'unsupported' ? (
        <p className="gm-guardrails-panel__status">
          This SayGM account service does not report guardrail policy reads as deployed.
        </p>
      ) : capabilityBlock === 'unavailable' ? (
        <p className="gm-guardrails-panel__status">
          SayGM reports guardrail policy reads as unavailable for this account service.
        </p>
      ) : snapshot ? (
        <div className="gm-guardrails-panel__editor">
          {notice && (
            <p className="gm-guardrails-panel__status" role="status">
              {notice}
            </p>
          )}
          {writeIssue === 'unsupported' && (
            <p className="gm-guardrails-panel__status" role="status">
              Guardrail writes are not reported as deployed by this SayGM account service.
            </p>
          )}
          {writeIssue === 'unavailable' && (
            <p className="gm-guardrails-panel__status" role="status">
              Guardrail writes are unavailable for this SayGM account service.
            </p>
          )}

          <div className="gm-guardrails-workspace">
            <nav className="gm-guardrails-workspace__rail" aria-label="Guardrail scanners">
              {SCANNERS.map((scanner) => (
                <button
                  type="button"
                  key={scanner.id}
                  className={
                    'gm-guardrails-workspace__scanner' +
                    (scanner.id === selectedScanner ? ' is-selected' : '')
                  }
                  aria-current={scanner.id === selectedScanner ? 'page' : undefined}
                  onClick={() => selectScanner(scanner.id)}
                >
                  <span className="gm-guardrails-workspace__scanner-copy">
                    <strong>{scanner.title}</strong>
                    <span>{scanner.description}</span>
                  </span>
                  <span
                    className={
                      'gm-guardrails-workspace__state gm-guardrails-workspace__state--' +
                      scannerState(scanner.id).toLowerCase().replace(' ', '-')
                    }
                  >
                    {scannerState(scanner.id)}
                  </span>
                </button>
              ))}
              {snapshot.body &&
                Object.prototype.hasOwnProperty.call(snapshot.body, TOPICS_SCANNER_ID) && (
                  <p className="gm-guardrails-workspace__preserved" role="note">
                    Stored topic rules are preserved when you edit visible scanners.
                  </p>
                )}
            </nav>

            <div className="gm-guardrails-workspace__detail">
              <div className="gm-guardrails-workspace__detail-heading">
                <div>
                  <p className="gm-guardrails-panel__eyebrow">Scanner</p>
                  <h3>{selected.title}</h3>
                  <p>{selected.description}</p>
                </div>
                {selectedScanner === 'pii' && (
                  <ScannerToggle
                    id="gm-guardrails-pii"
                    label="Enable scanner"
                    checked={draft.piiEnabled}
                    disabled={disabled}
                    onChange={(enabled) =>
                      editDraft('pii', (current) => ({ ...current, piiEnabled: enabled }))
                    }
                  />
                )}
                {selectedScanner === 'secrets' && (
                  <ScannerToggle
                    id="gm-guardrails-secrets"
                    label="Enable scanner"
                    checked={draft.secretsEnabled}
                    disabled={disabled}
                    onChange={(enabled) =>
                      editDraft('secrets', (current) => ({ ...current, secretsEnabled: enabled }))
                    }
                  />
                )}
                {selectedScanner === 'regex' && (
                  <ScannerToggle
                    id="gm-guardrails-regex-enabled"
                    label="Enable scanner"
                    checked={draft.regexEnabled}
                    disabled={
                      disabled || (!draft.regexEnabled && !hasValidRegexRules(draft.patterns))
                    }
                    onChange={(enabled) =>
                      editDraft('regex', (current) => ({ ...current, regexEnabled: enabled }))
                    }
                  />
                )}
                {selectedScanner === 'compress' && (
                  <ScannerToggle
                    id="gm-guardrails-compress"
                    label="Enable compression"
                    checked={draft.compressEnabled}
                    disabled={disabled}
                    onChange={(enabled) =>
                      editDraft('compress', (current) => ({ ...current, compressEnabled: enabled }))
                    }
                  />
                )}
              </div>

              {selectedScanner === 'pii' && (
                <div className="gm-guardrails-editor">
                  {draft.piiLegacyMode && hasSaved(PII_SCANNER_ID) && !changes.pii && (
                    <p className="gm-guardrails-panel__warning" role="status">
                      The saved mode “{draft.piiLegacyMode}” is preserved. Choose a supported mode
                      to replace it.
                    </p>
                  )}
                  {modeSelect('When personal information is detected', draft.piiMode, (mode) =>
                    editDraft('pii', (current) => ({
                      ...current,
                      piiEnabled: true,
                      piiMode: mode,
                      piiLegacyMode: null,
                    }))
                  )}
                  <PreviewWorkspace
                    previewAvailable={previewAvailable}
                    scannerId="native:pii"
                    sample={previewText}
                    result={previewResult}
                    error={previewError}
                    pending={previewing}
                    canPreview={canPreview}
                    scannerReady={!!previewConfig}
                    onLoadExample={loadPreviewExample}
                    onSampleChange={(value) => {
                      invalidatePreview();
                      setPreviewText(value);
                    }}
                    onPreview={() => void runPreview()}
                  />
                </div>
              )}

              {selectedScanner === 'secrets' && (
                <div className="gm-guardrails-editor">
                  {draft.secretsLegacyMode && hasSaved(SECRETS_SCANNER_ID) && !changes.secrets && (
                    <p className="gm-guardrails-panel__warning" role="status">
                      The saved mode “{draft.secretsLegacyMode}” is preserved. Choose a supported
                      mode to replace it.
                    </p>
                  )}
                  {modeSelect('When a secret is detected', draft.secretsMode, (mode) =>
                    editDraft('secrets', (current) => ({
                      ...current,
                      secretsEnabled: true,
                      secretsMode: mode,
                      secretsLegacyMode: null,
                    }))
                  )}
                  <p className="gm-guardrails-panel__note">
                    Redact removes a detected value. Redact &amp; restore masks it for the model and
                    restores it in the reply. Block rejects the request.
                  </p>
                  {draft.secretsMode === 'redact-restore' && (
                    <p className="gm-guardrails-panel__warning" role="note">
                      Redact is the default for secrets. Restoring them lets a manipulated model put
                      the real key in a link or tool call.
                    </p>
                  )}
                  <PreviewWorkspace
                    previewAvailable={previewAvailable}
                    scannerId="native:secrets"
                    sample={previewText}
                    result={previewResult}
                    error={previewError}
                    pending={previewing}
                    canPreview={canPreview}
                    scannerReady={!!previewConfig}
                    onLoadExample={loadPreviewExample}
                    onSampleChange={(value) => {
                      invalidatePreview();
                      setPreviewText(value);
                    }}
                    onPreview={() => void runPreview()}
                  />
                </div>
              )}

              {selectedScanner === 'regex' && (
                <div className="gm-guardrails-editor">
                  {draft.regexLegacyMode && hasSaved(REGEX_SCANNER_ID) && !changes.regex && (
                    <p className="gm-guardrails-panel__warning" role="status">
                      The saved mode “{draft.regexLegacyMode}” is preserved. Choose a supported mode
                      to replace it.
                    </p>
                  )}
                  {modeSelect('When a pattern matches', draft.regexMode, (mode) =>
                    editDraft('regex', (current) => ({
                      ...current,
                      regexMode: mode,
                      regexLegacyMode: null,
                      regexEnabled: hasValidRegexRules(current.patterns),
                    }))
                  )}
                  {!hasValidRegexRules(draft.patterns) && (
                    <p className="gm-guardrails-panel__note">
                      Add a complete pattern and replacement label before enabling this scanner.
                    </p>
                  )}
                  <div className="gm-guardrails-panel__rows">
                    {draft.patterns.map((rule, index) => (
                      <div
                        className="gm-guardrails-panel__row gm-guardrails-panel__row--rule"
                        key={'regex-' + index}
                      >
                        <label className="sr-only" htmlFor={'gm-guardrails-pattern-' + index}>
                          Regex pattern {index + 1}
                        </label>
                        <input
                          id={'gm-guardrails-pattern-' + index}
                          type="text"
                          value={rule.pattern}
                          placeholder="ORD-\\d+"
                          onChange={(event) =>
                            editDraft('regex', (current) => ({
                              ...current,
                              patterns: current.patterns.map((item, itemIndex) =>
                                itemIndex === index
                                  ? { ...item, pattern: event.target.value }
                                  : item
                              ),
                            }))
                          }
                          disabled={disabled}
                          autoComplete="off"
                        />
                        <label className="sr-only" htmlFor={'gm-guardrails-label-' + index}>
                          Replacement label {index + 1}
                        </label>
                        <input
                          id={'gm-guardrails-label-' + index}
                          type="text"
                          value={rule.label}
                          placeholder="ORDER_ID"
                          onChange={(event) =>
                            editDraft('regex', (current) => ({
                              ...current,
                              patterns: current.patterns.map((item, itemIndex) =>
                                itemIndex === index ? { ...item, label: event.target.value } : item
                              ),
                            }))
                          }
                          disabled={disabled}
                          autoComplete="off"
                        />
                        <button
                          type="button"
                          aria-label={'Remove regex rule ' + (index + 1)}
                          onClick={() =>
                            editDraft('regex', (current) => ({
                              ...current,
                              patterns: current.patterns.filter(
                                (_, itemIndex) => itemIndex !== index
                              ),
                              regexEnabled: current.regexEnabled,
                            }))
                          }
                          disabled={disabled}
                        >
                          Remove
                        </button>
                      </div>
                    ))}
                  </div>
                  <button
                    type="button"
                    className="gm-guardrails-panel__secondary-action"
                    onClick={() =>
                      editDraft('regex', (current) => ({
                        ...current,
                        patterns: [...current.patterns, { pattern: '', label: '' }],
                      }))
                    }
                    disabled={disabled}
                  >
                    Add regex rule
                  </button>
                  <p className="gm-guardrails-panel__note">Patterns use Rust regex syntax.</p>
                  <PreviewWorkspace
                    previewAvailable={previewAvailable}
                    scannerId="native:regex"
                    sample={previewText}
                    result={previewResult}
                    error={previewError}
                    pending={previewing}
                    canPreview={canPreview}
                    scannerReady={!!previewConfig}
                    onLoadExample={loadPreviewExample}
                    onSampleChange={(value) => {
                      invalidatePreview();
                      setPreviewText(value);
                    }}
                    onPreview={() => void runPreview()}
                  />
                </div>
              )}

              {selectedScanner === 'words' && (
                <div className="gm-guardrails-editor">
                  {draft.wordUnsupportedMode && (
                    <p className="gm-guardrails-panel__warning" role="status">
                      The saved mode “{draft.wordUnsupportedMode}” is not supported by this gateway.
                      Choose redact or block before changing this list.
                    </p>
                  )}
                  <label className="gm-guardrails-panel__mode">
                    <span className="gm-guardrails-panel__field-label">
                      When a substring matches
                    </span>
                    <select
                      aria-label="When a substring matches"
                      value={draft.wordMode ?? ''}
                      onChange={(event) =>
                        editDraft('words', (current) => ({
                          ...current,
                          wordMode:
                            event.target.value === 'redact' || event.target.value === 'block'
                              ? event.target.value
                              : null,
                          wordUnsupportedMode: null,
                        }))
                      }
                      disabled={disabled}
                    >
                      <option value="">Choose an action</option>
                      <option value="redact">Redact</option>
                      <option value="block">Block</option>
                    </select>
                  </label>
                  <div className="gm-guardrails-panel__list-heading">
                    <span className="gm-guardrails-panel__field-label">Matching substrings</span>
                    <button
                      type="button"
                      className="gm-guardrails-panel__secondary-action"
                      onClick={() =>
                        editDraft('words', (current) => ({
                          ...current,
                          substrings: [...current.substrings, ''],
                        }))
                      }
                      disabled={disabled}
                    >
                      Add substring
                    </button>
                  </div>
                  <div className="gm-guardrails-panel__rows">
                    {draft.substrings.map((substring, index) => (
                      <div className="gm-guardrails-panel__row" key={'word-' + index}>
                        <label className="sr-only" htmlFor={'gm-guardrails-word-' + index}>
                          Substring {index + 1}
                        </label>
                        <input
                          id={'gm-guardrails-word-' + index}
                          type="text"
                          value={substring}
                          onChange={(event) =>
                            editDraft('words', (current) => ({
                              ...current,
                              substrings: current.substrings.map((item, itemIndex) =>
                                itemIndex === index ? event.target.value : item
                              ),
                            }))
                          }
                          disabled={disabled}
                          autoComplete="off"
                        />
                        <button
                          type="button"
                          aria-label={'Remove substring ' + (index + 1)}
                          onClick={() =>
                            editDraft('words', (current) => ({
                              ...current,
                              substrings: current.substrings.filter(
                                (_, itemIndex) => itemIndex !== index
                              ),
                            }))
                          }
                          disabled={disabled}
                        >
                          Remove
                        </button>
                      </div>
                    ))}
                  </div>
                  <p className="gm-guardrails-panel__note">
                    This is one list: choose redaction or whole-request blocking. Values are kept
                    exactly as entered.
                  </p>
                  <PreviewWorkspace
                    previewAvailable={previewAvailable}
                    scannerId="native:ban-substrings"
                    sample={previewText}
                    result={previewResult}
                    error={previewError}
                    pending={previewing}
                    canPreview={canPreview}
                    scannerReady={!!previewConfig}
                    onLoadExample={loadPreviewExample}
                    onSampleChange={(value) => {
                      invalidatePreview();
                      setPreviewText(value);
                    }}
                    onPreview={() => void runPreview()}
                  />
                </div>
              )}

              {selectedScanner === 'compress' && (
                <div className="gm-guardrails-editor">
                  <p className="gm-guardrails-panel__note">
                    Compression reduces large tool results before they become model context. It does
                    not scan free text, so a text preview is not available.
                  </p>
                </div>
              )}
            </div>
          </div>

          {error && (
            <p className="gm-guardrails-panel__error" role="alert">
              {error}
            </p>
          )}
          {invalidWords && (
            <p className="gm-guardrails-panel__warning" role="status">
              Choose redact or block before saving this word list.
            </p>
          )}
          {invalidRegex && (
            <p className="gm-guardrails-panel__warning" role="status">
              Complete or remove every partially entered regex rule before saving.
            </p>
          )}
          <footer className="gm-guardrails-panel__footer">
            {saved && (
              <div className="gm-guardrails-panel__saved" role="status">
                <svg aria-hidden="true" focusable="false" viewBox="0 0 16 16" fill="none">
                  <path
                    d="m3.5 8.25 2.8 2.8 6.2-6.1"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                <span className="gm-guardrails-panel__saved-copy">
                  <span className="gm-guardrails-panel__saved-title">Settings saved</span>
                  <span className="gm-guardrails-panel__saved-detail">
                    Changes may take a moment to apply.
                  </span>
                </span>
              </div>
            )}
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={loading || saving || (!isDraftDirty && !conflict)}
            >
              {conflict ? 'Reload saved settings' : 'Discard changes'}
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={
                !isPolicyDirty ||
                !!writeIssue ||
                invalidWords ||
                invalidRegex ||
                conflict ||
                loading ||
                saving ||
                !editedBody
              }
            >
              {saving ? 'Saving…' : 'Save guardrails'}
            </button>
          </footer>
        </div>
      ) : error ? (
        <div className="gm-guardrails-panel__error" role="alert">
          <p>{error}</p>
          <button type="button" onClick={() => void refresh()} disabled={loading}>
            Retry
          </button>
        </div>
      ) : null}
    </section>
  );
}

function PreviewWorkspace({
  previewAvailable,
  scannerId,
  sample,
  result,
  error,
  pending,
  canPreview,
  scannerReady,
  onLoadExample,
  onSampleChange,
  onPreview,
}: {
  previewAvailable: boolean;
  scannerId: GmGuardrailsPreviewScannerId;
  sample: string;
  result: GmGuardrailsPreviewResponse | null;
  error: string | null;
  pending: boolean;
  canPreview: boolean;
  scannerReady: boolean;
  onLoadExample: () => void;
  onSampleChange: (value: string) => void;
  onPreview: () => void;
}) {
  const notRun = result?.not_run.includes(scannerId) ?? false;
  const scannerCounts = result?.per_scanner[scannerId];
  const byteLength = new TextEncoder().encode(sample).length;
  const tooLarge = byteLength > 128 * 1024;

  return (
    <section className="gm-guardrails-preview" aria-label="Draft scanner preview">
      <div className="gm-guardrails-preview__heading">
        <div>
          <span className="gm-guardrails-preview__eyebrow">Draft preview</span>
          <h4>Try this scanner</h4>
        </div>
        <span className="gm-guardrails-preview__badge">Does not save</span>
      </div>
      <p className="gm-guardrails-panel__note">
        This checks only the selected scanner draft. The sample goes to SayGM for preview; no model
        is called and no balance is used. The desktop app does not save this sample. Real requests
        run all enabled scanners together.
      </p>
      <label className="gm-guardrails-panel__field-label" htmlFor="gm-guardrails-preview-sample">
        Sample text
      </label>
      <textarea
        id="gm-guardrails-preview-sample"
        value={sample}
        onChange={(event) => onSampleChange(event.target.value)}
        rows={4}
        spellCheck={false}
        autoComplete="off"
      />
      <div className="gm-guardrails-preview__actions">
        {tooLarge && (
          <span className="gm-guardrails-preview__error">
            Preview samples must be 128 KiB or smaller.
          </span>
        )}
        {!tooLarge && previewAvailable && !scannerReady && (
          <span className="gm-guardrails-panel__note">
            Complete this scanner’s settings to preview it.
          </span>
        )}
        {!tooLarge && scannerReady && !sample.trim() && (
          <span className="gm-guardrails-panel__note">Enter sample text to run the preview.</span>
        )}
        {!previewAvailable && (
          <span className="gm-guardrails-panel__note">
            Scanner previews are unavailable for this account service.
          </span>
        )}
        <div className="gm-guardrails-preview__buttons">
          <button type="button" onClick={onLoadExample} disabled={pending}>
            Load example
          </button>
          <button type="button" onClick={onPreview} disabled={!canPreview || pending || tooLarge}>
            {pending ? 'Testing…' : 'Test draft'}
          </button>
        </div>
      </div>
      {error && (
        <p className="gm-guardrails-panel__error" role="alert">
          Preview unavailable: {error}
        </p>
      )}
      {pending && (
        <p className="gm-guardrails-panel__status" role="status">
          Running a draft preview…
        </p>
      )}
      {result && notRun && (
        <div className="gm-guardrails-panel__warning" role="status">
          The selected scanner did not run in this preview. This is not a successful test result.
        </div>
      )}
      {result && !notRun && (
        <div className="gm-guardrails-preview__result" role="status">
          <strong>
            {result.blocked ? 'Request would be blocked' : 'Scanner preview complete'}
          </strong>
          {result.blocked && result.blocked_by && <span>Blocked by {result.blocked_by}.</span>}
          {scannerCounts && (
            <span>
              {scannerCounts.detections} detection{scannerCounts.detections === 1 ? '' : 's'}
              {scannerCounts.redacted > 0 ? ', ' + scannerCounts.redacted + ' redacted' : ''}
              {scannerCounts.restored > 0 ? ', ' + scannerCounts.restored + ' restored' : ''}
            </span>
          )}
          {scannerCounts && Object.keys(scannerCounts.by_entity_type).length > 0 && (
            <span>
              Detected types:{' '}
              {Object.entries(scannerCounts.by_entity_type)
                .map(([entity, count]) => entity + ' ' + count)
                .join(', ')}
            </span>
          )}
          {!result.blocked && result.forwarded_text !== null && (
            <div>
              <span className="gm-guardrails-preview__label">What the model would see</span>
              <pre>{result.forwarded_text}</pre>
            </div>
          )}
          {!result.blocked && result.returned_text !== null && (
            <div>
              <span className="gm-guardrails-preview__label">What you’d get back</span>
              <pre>{result.returned_text}</pre>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function ScannerToggle({
  id,
  label,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: (enabled: boolean) => void;
}) {
  return (
    <label className="gm-guardrails-panel__toggle" htmlFor={id}>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        disabled={disabled}
      />
      <span>{label}</span>
    </label>
  );
}

function errorText(value: unknown): string {
  return value instanceof Error ? value.message : 'Could not load SayGM guardrails. Try again.';
}

function capabilityIssue(
  capabilities: GmCapabilities,
  operationId: string
): CapabilityIssue | null {
  const capability = capabilities.operations.find((item) => item.operation_id === operationId);
  if (!capability) return null;
  if (capability.adapter_support !== 'supported') return 'unsupported';
  if (capability.available === false) return 'unavailable';
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
