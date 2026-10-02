/**
 * Hub Component
 *
 * The empty-chat landing screen: a time-of-day greeting above the composer and
 * starter prompts that seed (never send) the input. Submitting creates a
 * session and navigates to /pair so the rest of the chat lifecycle lives there.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { defineMessages, useIntl } from '../i18n';
import { AppEvents } from '../constants/events';
import ChatInput from './ChatInput';
import { ChatInputCard } from './ChatInputCard';
import { ChatState } from '../types/chatState';
import 'react-toastify/dist/ReactToastify.css';
import { View, ViewOptions } from '../utils/navigationUtils';
import { useConfig } from './ConfigContext';
import { getEffectiveWorkingDir, getInitialWorkingDir } from '../utils/workingDir';
import { createSession } from '../sessions';
import LoadingGoose from './LoadingGoose';
import { UserInput } from '../types/message';
import {
  createNextChatExtensionDraft,
  selectNextChatExtensions,
  type NextChatExtensionDraft,
} from '../utils/nextChatExtensions';
import { formatAcpError } from '../acp/errors';
import { toastError } from '../toasts';
import { formatClockDisplay } from '../utils/timeUtils';
import { acpGetLiveVoiceAvailability } from '../acp/liveVoice';
import type { LiveVoiceAvailabilityResponse_unstable } from '@aaif/goose-acp-client';
import { subscribeToAcpRecovery } from '../acp/acpConnection';
import type { LiveVoiceController } from '../liveVoice/useLiveVoice';

const i18n = defineMessages({
  greetingLate: { id: 'hub.greetingLate', defaultMessage: 'Up late?' },
  greetingMorning: { id: 'hub.greetingMorning', defaultMessage: 'gm.' },
  greetingAfternoon: { id: 'hub.greetingAfternoon', defaultMessage: 'Good afternoon.' },
  greetingEvening: { id: 'hub.greetingEvening', defaultMessage: 'Good evening.' },
  greetingQuestion: { id: 'hub.greetingQuestion', defaultMessage: 'what are we building?' },
  starterLabel: { id: 'hub.starterLabel', defaultMessage: 'Starter prompts' },
  modeApprove: { id: 'hub.modeApprove', defaultMessage: 'Manual approvals' },
  modeSmartApprove: { id: 'hub.modeSmartApprove', defaultMessage: 'Smart approvals' },
  modeAuto: { id: 'hub.modeAuto', defaultMessage: 'Autonomous' },
  modeChat: { id: 'hub.modeChat', defaultMessage: 'Chat only' },
  starterTour: { id: 'hub.starterTour', defaultMessage: 'Tour this folder' },
  starterTourPrompt: {
    id: 'hub.starterTourPrompt',
    defaultMessage: 'Give me a quick tour of this folder: what’s here and how it fits together.',
  },
  starterBug: { id: 'hub.starterBug', defaultMessage: 'Chase down a bug' },
  starterBugPrompt: {
    id: 'hub.starterBugPrompt',
    defaultMessage: 'Help me find the cause of this error and suggest a fix: ',
  },
  starterReadme: { id: 'hub.starterReadme', defaultMessage: 'Draft a README' },
  starterReadmePrompt: {
    id: 'hub.starterReadmePrompt',
    defaultMessage: 'Read this project and draft a README for it.',
  },
  starterChecklist: { id: 'hub.starterChecklist', defaultMessage: 'Notes to checklist' },
  starterChecklistPrompt: {
    id: 'hub.starterChecklistPrompt',
    defaultMessage: 'Turn these notes into a clear checklist: ',
  },
});

const APPROVAL_MODE_LABELS: Record<string, keyof typeof i18n> = {
  approve: 'modeApprove',
  smart_approve: 'modeSmartApprove',
  auto: 'modeAuto',
  chat: 'modeChat',
};

const STARTERS: Array<{
  label: keyof typeof i18n;
  prompt: keyof typeof i18n;
}> = [
  { label: 'starterTour', prompt: 'starterTourPrompt' },
  { label: 'starterBug', prompt: 'starterBugPrompt' },
  { label: 'starterReadme', prompt: 'starterReadmePrompt' },
  { label: 'starterChecklist', prompt: 'starterChecklistPrompt' },
];

function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(interval);
  }, []);

  return { ...formatClockDisplay(now), now };
}

export default function Hub({
  setView,
  draftRef,
  liveVoice,
}: {
  setView: (view: View, viewOptions?: ViewOptions) => void;
  /** Unsent input of this screen, kept above the route outlet across the unmount. */
  draftRef: RefObject<string>;
  liveVoice: LiveVoiceController;
}) {
  const intl = useIntl();
  const { config, extensionsList } = useConfig();
  const approvalModeKey = APPROVAL_MODE_LABELS[String(config.GOOSE_MODE ?? '')];
  const approvalModeLabel = approvalModeKey ? intl.formatMessage(i18n[approvalModeKey]) : undefined;
  const [workingDir, setWorkingDir] = useState(getInitialWorkingDir());
  const userSelectedWorkingDirRef = useRef(false);
  const [isCreatingSession, setIsCreatingSession] = useState(false);
  const [liveVoiceAvailability, setLiveVoiceAvailability] =
    useState<LiveVoiceAvailabilityResponse_unstable | null>(null);
  const [nextChatExtensionDraft, setNextChatExtensionDraft] =
    useState<NextChatExtensionDraft | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [composerVersion, setComposerVersion] = useState(0);
  const { time, meridiem, hour, now } = useClock();

  // Re-resolve the working dir on mount: GOOSE_WORKING_DIR is fixed at window
  // creation, so a configured remote directory may have changed since then.
  useEffect(() => {
    let active = true;
    void getEffectiveWorkingDir().then((dir) => {
      if (active && !userSelectedWorkingDirRef.current) setWorkingDir(dir);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let requestGeneration = 0;
    const requestAvailability = async () => {
      const generation = ++requestGeneration;
      try {
        const availability = await acpGetLiveVoiceAvailability();
        if (generation === requestGeneration) {
          setLiveVoiceAvailability(availability);
        }
      } catch {
        if (generation === requestGeneration) {
          setLiveVoiceAvailability(null);
        }
      }
    };

    void requestAvailability();
    const unsubscribe = subscribeToAcpRecovery((recovering) => {
      if (!recovering) {
        void requestAvailability();
      }
    });

    return () => {
      requestGeneration += 1;
      unsubscribe();
    };
  }, []);

  const greeting = useMemo(() => {
    if (hour < 5) return intl.formatMessage(i18n.greetingLate);
    if (hour < 12) return intl.formatMessage(i18n.greetingMorning);
    if (hour < 18) return intl.formatMessage(i18n.greetingAfternoon);
    return intl.formatMessage(i18n.greetingEvening);
  }, [intl, hour]);
  const weekday = intl.formatDate(now, { weekday: 'long' });

  // ChatInput restores its text from the draft ref on mount, so a starter prompt
  // is seeded by writing the draft and remounting the composer. Nothing is sent.
  const seedComposer = (prompt: string) => {
    draftRef.current = prompt;
    setComposerVersion((version) => version + 1);
    requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      input.setSelectionRange(prompt.length, prompt.length);
    });
  };

  const draftForMenu = useMemo(
    () => nextChatExtensionDraft ?? createNextChatExtensionDraft(extensionsList),
    [extensionsList, nextChatExtensionDraft]
  );

  // rAF is more reliable than autoFocus across async render boundaries.
  useEffect(() => {
    const frameId = requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
    return () => cancelAnimationFrame(frameId);
  }, []);

  const handleNextChatExtensionDraftChange = useCallback((draft: NextChatExtensionDraft) => {
    setNextChatExtensionDraft(draft);
  }, []);

  const handleWorkingDirChange = useCallback((dir: string) => {
    userSelectedWorkingDirRef.current = true;
    setWorkingDir(dir);
  }, []);

  const createHubSession = async () => {
    if (isCreatingSession) return null;
    setIsCreatingSession(true);

    try {
      // A draft exists only once the user has opened the picker, so its absence is
      // "not specified" while an empty draft is "start with no extensions".
      const sessionOptions = nextChatExtensionDraft
        ? {
            extensionConfigs: selectNextChatExtensions(extensionsList, nextChatExtensionDraft),
          }
        : { allExtensions: extensionsList };

      // Resolve the effective directory at submit time: the IPC lookup may still
      // be pending when the user submits, and an explicit pick must win.
      const dir = userSelectedWorkingDirRef.current ? workingDir : await getEffectiveWorkingDir();
      const session = await createSession(dir, sessionOptions);
      setNextChatExtensionDraft(null);
      return session;
    } catch (error) {
      console.error('Failed to create session:', error);
      toastError({ title: "Couldn't start chat", msg: formatAcpError(error) });
      setIsCreatingSession(false);
      return null;
    }
  };

  const handleSubmit = async (input: UserInput) => {
    const { msg: userMessage, images } = input;
    if (!(images.length > 0 || userMessage.trim())) return;

    const draftAtSubmit = draftRef.current;
    const session = await createHubSession();
    if (!session) return;

    window.dispatchEvent(new CustomEvent(AppEvents.SESSION_CREATED));
    window.dispatchEvent(
      new CustomEvent(AppEvents.ADD_ACTIVE_SESSION, {
        detail: { sessionId: session.id, initialMessage: { msg: userMessage, images } },
      })
    );

    // Preserve edits made while the session was being created.
    if (draftRef.current === draftAtSubmit) {
      draftRef.current = '';
    }

    setView('pair', {
      disableAnimation: true,
      resumeSessionId: session.id,
      initialMessage: { msg: userMessage, images },
    });
  };

  const handleStartLiveVoice = async () => {
    if (liveVoice.activeSessionId) {
      setView('pair', { resumeSessionId: liveVoice.activeSessionId });
      return;
    }

    const session = await createHubSession();
    if (!session) return;

    window.dispatchEvent(new CustomEvent(AppEvents.SESSION_CREATED));
    window.dispatchEvent(
      new CustomEvent(AppEvents.ADD_ACTIVE_SESSION, {
        detail: { sessionId: session.id },
      })
    );

    setView('pair', {
      disableAnimation: true,
      resumeSessionId: session.id,
      startLiveVoice: true,
    });
  };

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-y-auto">
      <div aria-hidden="true" className="gm-page-glow" />
      <div className="relative flex flex-1 flex-col justify-center px-6 pb-24 pt-12 lg:px-24">
        <div className="mx-auto flex w-full max-w-[720px] flex-col gap-7">
          <div className="flex flex-col gap-3">
            <p className="gm-mono-label tabular-nums">
              {weekday} · {time}
              {meridiem ? ` ${meridiem}` : null}
            </p>
            <h1 className="gm-display text-[clamp(2.5rem,5vw,3.5rem)] leading-[1.02]">
              {greeting}{' '}
              <span className="gm-serif text-text-secondary">
                {intl.formatMessage(i18n.greetingQuestion)}
              </span>
            </h1>
          </div>

          <ChatInputCard>
            <ChatInput
              key={composerVersion}
              sessionId={null}
              draftRef={draftRef}
              handleSubmit={handleSubmit}
              chatState={isCreatingSession ? ChatState.LoadingConversation : ChatState.Idle}
              hasActiveRun={false}
              onStop={() => {}}
              initialValue=""
              setView={setView}
              totalTokens={0}
              accumulatedInputTokens={0}
              accumulatedOutputTokens={0}
              droppedFiles={[]}
              onFilesProcessed={() => {}}
              messages={[]}
              disableAnimation={false}
              workingDir={workingDir}
              onWorkingDirChange={handleWorkingDirChange}
              inputRef={inputRef}
              nextChatExtensionDraft={draftForMenu}
              onNextChatExtensionDraftChange={handleNextChatExtensionDraftChange}
              approvalModeLabel={approvalModeLabel}
              liveVoice={{
                availability: isCreatingSession ? null : liveVoiceAvailability,
                phase: 'idle',
                muted: false,
                activeInAnotherSession: liveVoice.activeSessionId !== null,
                start: handleStartLiveVoice,
                stop: liveVoice.stop,
                toggleMute: liveVoice.toggleMute,
              }}
            />
          </ChatInputCard>

          <ul aria-label={intl.formatMessage(i18n.starterLabel)} className="flex flex-wrap gap-2">
            {STARTERS.map(({ label, prompt }) => (
              <li key={label}>
                <button
                  type="button"
                  className="gm-btn gm-btn--secondary gm-btn--sm"
                  onClick={() => seedComposer(intl.formatMessage(i18n[prompt]))}
                >
                  {intl.formatMessage(i18n[label])}
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {isCreatingSession && (
        <div className="absolute bottom-4 left-4 z-20 pointer-events-none">
          <LoadingGoose chatState={ChatState.LoadingConversation} />
        </div>
      )}
    </div>
  );
}
