import { SquareTerminal } from 'lucide-react';
import type { ActionRequired } from '../types/message';
import { defineMessages, useIntl } from '../i18n';
import { snakeToTitleCase } from '../utils';
import ToolApprovalButtons from './ToolApprovalButtons';
import { ToolCallArguments, type ToolCallArgumentValue } from './ToolCallArguments';
import { ToolApprovalFooter } from './ToolApprovalFooter';

const i18n = defineMessages({
  allowToolCallWithName: {
    id: 'toolConfirmation.allowToolCallWithName',
    defaultMessage: 'Allow {toolName}?',
  },
  toolApproval: {
    id: 'toolConfirmation.toolApproval',
    defaultMessage: 'Tool approval',
  },
  toolLabel: {
    id: 'toolConfirmation.toolLabel',
    defaultMessage: 'Tool',
  },
});

function formatToolName(fullName: string): string {
  const delimiterIndex = fullName.lastIndexOf('__');
  const shortName = delimiterIndex === -1 ? fullName : fullName.substring(delimiterIndex + 2);
  return snakeToTitleCase(shortName);
}

type ToolConfirmationData = Extract<ActionRequired['data'], { actionType: 'toolConfirmation' }>;

interface ToolConfirmationProps {
  sessionId: string;
  isClicked: boolean;
  actionRequiredContent: ActionRequired & { type: 'actionRequired' };
}

export default function ToolConfirmation({
  sessionId,
  isClicked,
  actionRequiredContent,
}: ToolConfirmationProps) {
  const intl = useIntl();
  const data = actionRequiredContent.data as ToolConfirmationData;
  const { generation, id, toolName, arguments: toolArguments, prompt } = data;
  const displayName = formatToolName(toolName);

  return (
    <section
      aria-label={intl.formatMessage(i18n.toolApproval)}
      className="goose-message-content overflow-hidden rounded-xl border border-border-tertiary bg-surface-card"
    >
      <div className="flex items-center gap-2.5 border-b border-border-primary px-4 py-3">
        <SquareTerminal className="size-4 flex-shrink-0 text-text-secondary" aria-hidden="true" />
        <span className="font-semibold">
          {intl.formatMessage(i18n.allowToolCallWithName, { toolName: displayName })}
        </span>
      </div>
      <div className="flex flex-col gap-2.5 px-4 py-3.5">
        {prompt && (
          <p className="rounded-lg border border-[rgba(251,140,0,0.32)] bg-[rgba(251,140,0,0.1)] px-3 py-2 text-[13px] text-text-warning">
            {prompt}
          </p>
        )}
        <ToolCallArguments args={toolArguments as Record<string, ToolCallArgumentValue>} />
        <p className="text-xs text-text-secondary">
          {intl.formatMessage(i18n.toolLabel)}{' '}
          <span className="font-mono text-text-primary">{toolName}</span>
        </p>
      </div>
      <ToolApprovalFooter>
        <ToolApprovalButtons
          data={{ generation, id, toolName, prompt: prompt ?? undefined, sessionId, isClicked }}
        />
      </ToolApprovalFooter>
    </section>
  );
}
