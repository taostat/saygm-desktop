import type { ReactNode } from 'react';
import { defineMessages, useIntl } from '../i18n';

const i18n = defineMessages({
  localApprovals: {
    id: 'toolApprovalFooter.localApprovals',
    defaultMessage: 'Local approvals, not key guardrails',
  },
});

/**
 * Footer row of a tool approval card. The link explains that these approvals
 * are local tool permissions, separate from SayGM key guardrails.
 */
export function ToolApprovalFooter({ children }: { children: ReactNode }) {
  const intl = useIntl();
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-border-primary bg-surface-inset px-4 py-3">
      {children}
      <span className="flex-1" />
      <a href="#/privacy" className="gm-link text-xs text-text-secondary">
        {intl.formatMessage(i18n.localApprovals)}
      </a>
    </div>
  );
}
