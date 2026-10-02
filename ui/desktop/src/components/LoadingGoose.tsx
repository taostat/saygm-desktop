import { ChatState } from '../types/chatState';
import { defineMessages, useIntl } from '../i18n';

interface LoadingGooseProps {
  message?: string;
  chatState?: ChatState;
}

const i18n = defineMessages({
  loadingConversation: {
    id: 'saygmLoading.loadingConversation',
    defaultMessage: 'Loading conversation…',
  },
  thinking: {
    id: 'saygmLoading.thinking',
    defaultMessage: 'Thinking…',
  },
  streaming: {
    id: 'saygmLoading.streaming',
    defaultMessage: 'Working on it…',
  },
  waiting: {
    id: 'saygmLoading.waiting',
    defaultMessage: 'Waiting for your input…',
  },
  compacting: {
    id: 'saygmLoading.compacting',
    defaultMessage: 'Compacting the conversation…',
  },
  idle: {
    id: 'saygmLoading.idle',
    defaultMessage: 'Working on it…',
  },
  restartingAgent: {
    id: 'saygmLoading.restartingAgent',
    defaultMessage: 'Restarting session…',
  },
});

const STATE_MESSAGE_KEYS: Record<ChatState, keyof typeof i18n> = {
  [ChatState.LoadingConversation]: 'loadingConversation',
  [ChatState.Thinking]: 'thinking',
  [ChatState.Streaming]: 'streaming',
  [ChatState.WaitingForUserInput]: 'waiting',
  [ChatState.Compacting]: 'compacting',
  [ChatState.Idle]: 'idle',
  [ChatState.RestartingAgent]: 'restartingAgent',
};

/** Agent progress line. Kept under its upstream name so existing call sites stay unchanged. */
const LoadingGoose = ({ message, chatState = ChatState.Idle }: LoadingGooseProps) => {
  const intl = useIntl();
  const displayMessage = message || intl.formatMessage(i18n[STATE_MESSAGE_KEYS[chatState]]);

  return (
    <div className="w-full gm-fade-up py-2">
      <div data-testid="loading-indicator" className="gm-status" role="status">
        {chatState !== ChatState.Idle && <span className="gm-spinner" aria-hidden="true" />}
        {displayMessage}
      </div>
    </div>
  );
};

export default LoadingGoose;
