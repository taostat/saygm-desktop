import { useState } from 'react';
import { Hand } from 'lucide-react';
import { useConfig } from './ConfigContext';
import { all_goose_modes } from './settings/mode/ModeSelectionItem';
import PermissionRulesModal from './settings/permission/PermissionRulesModal';
import { defineMessages, useIntl } from '../i18n';
import { getLocalDeviceName } from '../utils/localDeviceName';

const i18n = defineMessages({
  title: { id: 'localToolApprovals.title', defaultMessage: 'Local tool approvals' },
  scope: { id: 'localToolApprovals.scope', defaultMessage: 'This {device}' },
  description: {
    id: 'localToolApprovals.description',
    defaultMessage: 'Decide when tools on this {device} can act. Set here, stored here.',
  },
  modeGroup: { id: 'localToolApprovals.modeGroup', defaultMessage: 'Approval mode' },
  rulesLabel: { id: 'localToolApprovals.rulesLabel', defaultMessage: 'Per-tool rules' },
  rulesDescription: {
    id: 'localToolApprovals.rulesDescription',
    defaultMessage: 'Permission rules for individual tools, by extension.',
  },
  reviewRules: { id: 'localToolApprovals.reviewRules', defaultMessage: 'Review rules' },
  saveFailed: {
    id: 'localToolApprovals.saveFailed',
    defaultMessage: 'Could not change the approval mode. Try again.',
  },
});

// Safest first, matching the design's ordering.
const MODE_ORDER = ['approve', 'smart_approve', 'auto', 'chat'];
const MODES = [...all_goose_modes].sort(
  (a, b) => MODE_ORDER.indexOf(a.key) - MODE_ORDER.indexOf(b.key)
);

/** The local tool approval mode (GOOSE_MODE), kept separate from SayGM key guardrails. */
export function LocalToolApprovalsCard() {
  const intl = useIntl();
  const localDeviceName = getLocalDeviceName(window.electron.platform);
  const { config, upsert } = useConfig();
  const [isRulesOpen, setIsRulesOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const currentMode = typeof config.GOOSE_MODE === 'string' ? config.GOOSE_MODE : null;

  const selectMode = async (mode: string) => {
    setError(null);
    try {
      await upsert('GOOSE_MODE', mode, false);
    } catch (cause) {
      console.error('Failed to store the tool approval mode:', cause);
      setError(intl.formatMessage(i18n.saveFailed));
    }
  };

  return (
    <section
      aria-labelledby="local-tool-approvals-title"
      className="gm-card flex flex-col gap-3.5 p-5"
    >
      <div className="flex items-center justify-between gap-2">
        <h2
          id="local-tool-approvals-title"
          className="flex items-center gap-2 text-[17px] font-semibold"
        >
          <Hand className="size-4" aria-hidden="true" />
          {intl.formatMessage(i18n.title)}
        </h2>
        <span className="gm-badge gm-badge--outline gm-badge--mono">
          {intl.formatMessage(i18n.scope, { device: localDeviceName })}
        </span>
      </div>
      <p className="text-[13px] text-text-secondary">
        {intl.formatMessage(i18n.description, { device: localDeviceName })}
      </p>

      <fieldset className="flex flex-col gap-1.5">
        <legend className="sr-only">{intl.formatMessage(i18n.modeGroup)}</legend>
        {MODES.map((mode) => (
          <label key={mode.key} className="gm-option items-start">
            <input
              type="radio"
              name="local-tool-approval-mode"
              value={mode.key}
              checked={currentMode === mode.key}
              onChange={() => void selectMode(mode.key)}
              className="sr-only"
            />
            <span className="gm-option__radio mt-[3px]" aria-hidden="true" />
            <span className="flex flex-col gap-0.5">
              <span className="text-sm font-semibold">
                {intl.formatMessage(mode.labelDescriptor)}
              </span>
              <span className="text-xs text-text-secondary">
                {intl.formatMessage(mode.descriptionDescriptor)}
              </span>
            </span>
          </label>
        ))}
      </fieldset>

      {error && (
        <p role="alert" className="text-[13px] text-text-danger">
          {error}
        </p>
      )}

      <div className="flex flex-col gap-2 border-t border-border-primary pt-3">
        <span className="gm-section-label">{intl.formatMessage(i18n.rulesLabel)}</span>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-[13px] text-text-secondary">
            {intl.formatMessage(i18n.rulesDescription)}
          </span>
          <button
            type="button"
            className="gm-btn gm-btn--secondary gm-btn--sm"
            onClick={() => setIsRulesOpen(true)}
          >
            {intl.formatMessage(i18n.reviewRules)}
          </button>
        </div>
      </div>

      <PermissionRulesModal isOpen={isRulesOpen} onClose={() => setIsRulesOpen(false)} />
    </section>
  );
}
