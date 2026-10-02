import { useCallback, useEffect, useMemo, useRef, useState, type ComponentRef } from 'react';
import { useNavigate } from 'react-router';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { ArrowLeft, ArrowRight, Check, Cloud, Hand, Laptop, Search } from 'lucide-react';
import { acpReadDefaults, acpRefreshProviderDetails, acpSaveDefaults } from '../../acp/providers';
import type { ModelInfo } from '../../types/providers';
import { cn } from '../../utils';
import { getLocalDeviceName } from '../../utils/localDeviceName';
import { useModelAndProvider } from '../ModelAndProviderContext';
import GMAccount from './GMAccount';
import { SayGMLockup, SayGMMark } from '../SayGMMark';

type SetupStep = 'account' | 'model';

interface WelcomeSetupProps {
  /** Called after the model choice is saved; the guard re-reads defaults and reveals the app. */
  onComplete: () => Promise<void>;
}

const MODEL_FILTER_THRESHOLD = 6;
const LAUNCH_DURATION_MS = 320;

const GM_EASE_OUT = [0.2, 0.8, 0.2, 1] as const;

const stepMotion = {
  initial: { opacity: 0, y: 6 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0 },
  transition: { duration: 0.24, ease: GM_EASE_OUT },
};

function formatContextLimit(limit?: number | null): string | null {
  if (!limit || limit <= 0) return null;
  if (limit >= 1_000_000) return `${Number((limit / 1_000_000).toFixed(1))}M context`;
  if (limit >= 1_000) return `${Math.round(limit / 1_000)}K context`;
  return `${limit} context`;
}

function StepTrack({ step }: { step: SetupStep }) {
  const steps: Array<{ id: SetupStep; label: string }> = [
    { id: 'account', label: 'Sign in' },
    { id: 'model', label: 'Pick a model' },
  ];
  const currentIndex = steps.findIndex((item) => item.id === step);

  return (
    <ol
      aria-label="Setup steps"
      className="relative flex items-center justify-end gap-2.5 text-[13px]"
    >
      {steps.map((item, index) => {
        const isCurrent = index === currentIndex;
        const isDone = index < currentIndex;
        return (
          <li
            key={item.id}
            aria-current={isCurrent ? 'step' : undefined}
            className="flex items-center gap-2.5"
          >
            {index > 0 && <span aria-hidden="true" className="h-px w-6 bg-border-tertiary" />}
            <span
              className={cn(
                'grid size-[22px] place-items-center rounded-full font-mono text-[11px]',
                isCurrent ? 'bg-gm-yellow text-gm-black' : 'border border-border-tertiary'
              )}
            >
              {isDone ? <Check className="size-3" aria-hidden="true" /> : index + 1}
            </span>
            <span className={isCurrent ? 'font-semibold' : 'text-text-secondary'}>
              {item.label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function ModelOption({
  model,
  checked,
  onSelect,
}: {
  model: ModelInfo;
  checked: boolean;
  onSelect: (name: string) => void;
}) {
  const context = formatContextLimit(model.context_limit);
  return (
    <label className="gm-option relative">
      <input
        type="radio"
        name="saygm-model"
        value={model.name}
        checked={checked}
        onChange={() => onSelect(model.name)}
        className="sr-only"
      />
      <span className="gm-option__radio" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate font-mono text-[13px]" title={model.name}>
        {model.name}
      </span>
      {model.reasoning && (
        <span className="gm-badge gm-badge--outline gm-badge--mono">reasoning</span>
      )}
      {context && <span className="gm-badge gm-badge--outline gm-badge--mono">{context}</span>}
    </label>
  );
}

/** The ink brand panel beside the setup steps. */
export function WelcomeBrandPanel() {
  const localDeviceName = getLocalDeviceName(window.electron.platform);

  return (
    <section className="gm-dark relative flex flex-col overflow-hidden bg-[linear-gradient(165deg,#10161a_0%,#0a0e11_60%,#090c0f_100%)] px-8 pb-10 pt-16 sm:px-14 lg:pb-12 lg:pt-[72px]">
      <div
        aria-hidden="true"
        className="gm-burst -left-[300px] -top-[340px] size-[880px] [--burst:rgba(255,206,63,0.07)] [mask:radial-gradient(circle_at_50%_50%,#000_0%,transparent_60%)]"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(680px_460px_at_8%_-6%,rgba(255,206,63,0.18),transparent_60%)]"
      />
      <div className="relative flex flex-1 flex-col">
        <SayGMLockup size={20} className="text-gm-yellow" />
        <div className="mt-16 flex flex-col gap-5 lg:mt-auto">
          <p className="gm-mono-label">SayGM for desktop</p>
          <h1 className="gm-display text-[clamp(2.5rem,4.4vw,3.5rem)] [text-wrap:balance]">
            Say gm to the agent that works on your{' '}
            <span className="gm-serif text-gm-yellow">{localDeviceName}.</span>
          </h1>
          <p className="max-w-[40ch] text-base text-text-secondary [text-wrap:pretty]">
            Sign in, pick a model, and work with files and tools on this computer. Inference runs on
            SayGM’s hosted API.
          </p>
        </div>
        <ul className="mt-10 grid grid-cols-3 gap-4 border-t border-border-primary pt-5 text-[13px] text-text-secondary">
          <li className="flex flex-col gap-1.5">
            <Laptop className="size-4 text-gm-yellow" aria-hidden="true" />
            Runs on your {localDeviceName}
          </li>
          <li className="flex flex-col gap-1.5">
            <Hand className="size-4 text-gm-yellow" aria-hidden="true" />
            Tool approvals on by default
          </li>
          <li className="flex flex-col gap-1.5">
            <Cloud className="size-4 text-gm-yellow" aria-hidden="true" />
            Inference hosted by SayGM
          </li>
        </ul>
      </div>
    </section>
  );
}

export default function WelcomeSetup({ onComplete }: WelcomeSetupProps) {
  const navigate = useNavigate();
  const reduceMotion = useReducedMotion();
  const { refreshCurrentModelAndProvider } = useModelAndProvider();
  const [step, setStep] = useState<SetupStep>('account');
  const stepRef = useRef<SetupStep>('account');
  const setupOperationId = useRef(0);
  const hasSeenConnectedAccount = useRef(false);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [selectedModel, setSelectedModel] = useState('');
  const [modelQuery, setModelQuery] = useState('');
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [launchOrigin, setLaunchOrigin] = useState<{ x: number; y: number } | null>(null);
  const modelHeadingRef = useRef<ComponentRef<'h2'>>(null);
  const modelListRef = useRef<HTMLDivElement>(null);
  const startButtonRef = useRef<HTMLButtonElement>(null);
  const launchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const updateStep = useCallback((next: SetupStep) => {
    stepRef.current = next;
    setStep(next);
  }, []);

  const clearLaunchTimer = useCallback(() => {
    if (launchTimerRef.current) {
      clearTimeout(launchTimerRef.current);
      launchTimerRef.current = null;
    }
  }, []);

  const focusModelHeading = useCallback((node: ComponentRef<'h2'> | null) => {
    modelHeadingRef.current = node;
    node?.focus();
  }, []);

  const scrollSelectedModelIntoView = useCallback(() => {
    const selectedModelOption = modelListRef.current
      ?.querySelector('input:checked')
      ?.closest('label');
    selectedModelOption?.scrollIntoView?.({ block: 'nearest' });
  }, []);

  useEffect(
    () => () => {
      setupOperationId.current += 1;
      clearLaunchTimer();
    },
    [clearLaunchTimer]
  );

  const visibleModels = useMemo(() => {
    const query = modelQuery.trim().toLowerCase();
    return query ? models.filter((model) => model.name.toLowerCase().includes(query)) : models;
  }, [models, modelQuery]);

  const loadModels = useCallback(async () => {
    const operationId = ++setupOperationId.current;
    setError(null);
    setIsLoadingModels(true);
    try {
      const account = await window.electron.gmAccount.getStatus();
      if (operationId !== setupOperationId.current) return;
      if (account.connected) hasSeenConnectedAccount.current = true;
      if (!account.connected || !account.providerConfigured) {
        throw new Error('Connect and finish SayGM account setup before choosing a model.');
      }

      const { provider } = await acpRefreshProviderDetails('saygm');
      if (operationId !== setupOperationId.current) return;
      if (!provider?.is_configured) {
        throw new Error(
          'SayGM account setup has not finished. Reconnect your account and try again.'
        );
      }

      const availableModels = provider.metadata.known_models;
      if (availableModels.length === 0) {
        throw new Error('No compatible SayGM models are available right now. Try again shortly.');
      }

      const { providerId, modelId } = await acpReadDefaults();
      if (operationId !== setupOperationId.current) return;
      const latestAccount = await window.electron.gmAccount.getStatus();
      if (operationId !== setupOperationId.current) return;
      if (latestAccount.connected) hasSeenConnectedAccount.current = true;
      if (!latestAccount.connected || !latestAccount.providerConfigured) {
        throw new Error('Your SayGM connection changed. Sign in again before choosing a model.');
      }

      const preferredModel =
        providerId === 'saygm' && availableModels.some((model) => model.name === modelId)
          ? modelId
          : provider.metadata.default_model;
      setModels(availableModels);
      setSelectedModel(
        preferredModel && availableModels.some((model) => model.name === preferredModel)
          ? preferredModel
          : availableModels[0].name
      );
      setModelQuery('');
      updateStep('model');
    } catch (loadError) {
      if (operationId === setupOperationId.current) {
        setError(
          loadError instanceof Error ? loadError.message : 'Could not load SayGM models. Try again.'
        );
      }
    } finally {
      if (operationId === setupOperationId.current) setIsLoadingModels(false);
    }
  }, [updateStep]);

  useEffect(() => {
    let active = true;
    const handleAccountChanged = () => {
      const operationId = ++setupOperationId.current;
      clearLaunchTimer();
      setIsLoadingModels(false);
      setIsSaving(false);
      setLaunchOrigin(null);

      void window.electron.gmAccount
        .getStatus()
        .then((account) => {
          if (!active || operationId !== setupOperationId.current) return;
          if (account.connected) hasSeenConnectedAccount.current = true;
          if (!account.connected) {
            const shouldExplainDisconnect =
              hasSeenConnectedAccount.current || stepRef.current === 'model';
            updateStep('account');
            setModels([]);
            setSelectedModel('');
            setModelQuery('');
            setError(
              shouldExplainDisconnect
                ? 'Your SayGM connection changed. Sign in again before choosing a model.'
                : null
            );
            return;
          }
          if (!account.providerConfigured) {
            if (stepRef.current === 'model') {
              updateStep('account');
              setModels([]);
              setSelectedModel('');
              setModelQuery('');
              setError('Finish SayGM account setup before choosing a model.');
            }
            return;
          }
          if (stepRef.current === 'account') {
            void loadModels();
          }
        })
        .catch(() => {
          if (!active || operationId !== setupOperationId.current) return;
          const shouldExplainFailure =
            hasSeenConnectedAccount.current || stepRef.current === 'model';
          updateStep('account');
          setModels([]);
          setSelectedModel('');
          setModelQuery('');
          setError(
            shouldExplainFailure
              ? 'Could not verify your SayGM connection. Check it and try again.'
              : null
          );
        });
    };

    const unsubscribe = window.electron.gmAccount.onChanged(handleAccountChanged);
    return () => {
      active = false;
      setupOperationId.current += 1;
      unsubscribe();
    };
  }, [clearLaunchTimer, loadModels, updateStep]);

  const finishSetup = useCallback(
    async (operationId: number) => {
      if (operationId !== setupOperationId.current) return;
      try {
        navigate('/', { replace: true });
        await onComplete();
      } catch (finishError) {
        if (operationId !== setupOperationId.current) return;
        setLaunchOrigin(null);
        setIsSaving(false);
        setError(
          finishError instanceof Error
            ? finishError.message
            : 'Could not open your workspace. Try again.'
        );
      }
    },
    [navigate, onComplete]
  );

  const handleContinue = async () => {
    if (!selectedModel) return;
    const operationId = ++setupOperationId.current;
    setIsSaving(true);
    setError(null);
    try {
      const account = await window.electron.gmAccount.getStatus();
      if (operationId !== setupOperationId.current) return;
      if (!account.connected || !account.providerConfigured) {
        throw new Error('Your SayGM connection is not ready. Sign in again to continue.');
      }
      await acpSaveDefaults('saygm', selectedModel);
      if (operationId !== setupOperationId.current) return;
      await refreshCurrentModelAndProvider();
      if (operationId !== setupOperationId.current) return;
    } catch (saveError) {
      if (operationId === setupOperationId.current) {
        setError(
          saveError instanceof Error
            ? saveError.message
            : 'Could not save your model choice. Try again.'
        );
        setIsSaving(false);
      }
      return;
    }

    const button = startButtonRef.current?.getBoundingClientRect();
    if (reduceMotion || !button) {
      await finishSetup(operationId);
      return;
    }
    setLaunchOrigin({ x: button.left + button.width / 2, y: button.top + button.height / 2 });
    launchTimerRef.current = setTimeout(() => void finishSetup(operationId), LAUNCH_DURATION_MS);
  };

  const handleBack = () => {
    setupOperationId.current += 1;
    clearLaunchTimer();
    setError(null);
    setIsLoadingModels(false);
    setIsSaving(false);
    setLaunchOrigin(null);
    updateStep('account');
  };

  return (
    <main className="grid h-full min-h-0 min-w-0 w-full grid-cols-1 overflow-x-hidden overflow-y-auto overscroll-contain min-[900px]:grid-cols-[1.04fr_1fr]">
      <WelcomeBrandPanel />

      <section className="gm-light relative flex min-w-0 flex-col bg-gm-cream-warm px-6 pb-10 pt-6 sm:px-14">
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
          <div className="gm-burst -right-[260px] -top-[300px] size-[720px] [--burst:rgba(89,47,5,0.05)] [mask:radial-gradient(circle_at_50%_50%,#000_4%,transparent_60%)]" />
        </div>
        <StepTrack step={step} />

        <div className="relative mx-auto my-auto flex w-full max-w-[420px] flex-col py-10">
          <AnimatePresence mode="wait" initial={false}>
            {step === 'account' ? (
              <motion.div key="account" className="flex flex-col gap-6" {...stepMotion}>
                <GMAccount mode="onboarding" onConnected={() => void loadModels()} />
                {isLoadingModels && (
                  <p role="status" className="gm-status">
                    <span className="gm-spinner" aria-hidden="true" />
                    Loading available models…
                  </p>
                )}
                {error && (
                  <div
                    role="alert"
                    className="flex flex-col items-start gap-1 rounded-[10px] border border-[rgba(255,80,63,0.32)] bg-[rgba(255,80,63,0.08)] px-3.5 py-2.5 text-[13px] text-text-danger"
                  >
                    <p>{error}</p>
                    <button
                      type="button"
                      onClick={() => void loadModels()}
                      disabled={isLoadingModels}
                      className="gm-link text-text-primary"
                    >
                      Try again
                    </button>
                  </div>
                )}
              </motion.div>
            ) : (
              <motion.section
                key="model"
                aria-labelledby="saygm-model-title"
                {...stepMotion}
                onAnimationComplete={scrollSelectedModelIntoView}
                className="flex flex-col gap-6"
              >
                <button
                  type="button"
                  onClick={handleBack}
                  className="gm-btn gm-btn--ghost gm-btn--sm -ml-3.5 self-start"
                >
                  <ArrowLeft className="size-4" aria-hidden="true" />
                  Back to account
                </button>
                <div className="flex flex-col gap-2.5">
                  <p className="gm-mono-label">Default model</p>
                  <h2
                    id="saygm-model-title"
                    ref={focusModelHeading}
                    tabIndex={-1}
                    className="text-[32px] font-semibold leading-[1.15] tracking-[-0.02em] outline-none"
                  >
                    Pick a model
                  </h2>
                  <p className="text-[15px] text-text-secondary">
                    These models are available for this SayGM connection. You can change your choice
                    later.
                  </p>
                </div>

                {models.length > MODEL_FILTER_THRESHOLD && (
                  <label className="relative flex items-center">
                    <Search
                      className="pointer-events-none absolute left-3.5 size-4 text-text-tertiary"
                      aria-hidden="true"
                    />
                    <span className="sr-only">Filter models</span>
                    <input
                      type="search"
                      value={modelQuery}
                      onChange={(event) => setModelQuery(event.target.value)}
                      placeholder="Filter models"
                      className="gm-input pl-10"
                    />
                  </label>
                )}

                <fieldset className="min-w-0">
                  <legend className="sr-only">Default model</legend>
                  <div
                    ref={modelListRef}
                    className="-m-1 flex max-h-[min(22rem,42vh)] flex-col gap-1.5 overflow-y-auto p-1"
                  >
                    {visibleModels.map((model) => (
                      <ModelOption
                        key={model.name}
                        model={model}
                        checked={model.name === selectedModel}
                        onSelect={setSelectedModel}
                      />
                    ))}
                    {visibleModels.length === 0 && (
                      <p className="rounded-[10px] border border-dashed border-border-tertiary px-4 py-6 text-center text-[13px] text-text-secondary">
                        No models match “{modelQuery.trim()}”.
                      </p>
                    )}
                  </div>
                </fieldset>

                {error && (
                  <p role="alert" className="text-[13px] font-medium text-text-danger">
                    {error}
                  </p>
                )}

                <div className="flex flex-col items-start gap-3">
                  <button
                    ref={startButtonRef}
                    type="button"
                    onClick={() => void handleContinue()}
                    disabled={!selectedModel || isSaving}
                    className="gm-btn gm-btn--lg"
                  >
                    {isSaving ? 'Saving…' : 'Start chatting'}
                    {!isSaving && <ArrowRight className="size-4" aria-hidden="true" />}
                  </button>
                  <p className="text-xs text-text-secondary">
                    Model availability and capabilities can change. See the{' '}
                    <button
                      type="button"
                      onClick={() => void window.electron.openExternal('https://saygm.com/models')}
                      className="gm-link"
                    >
                      live model catalog
                    </button>{' '}
                    for current details.
                  </p>
                </div>
              </motion.section>
            )}
          </AnimatePresence>
        </div>
      </section>

      <AnimatePresence>
        {launchOrigin && (
          <motion.div
            key="launch"
            role="status"
            className="fixed inset-0 z-[100] grid place-items-center bg-surface-page text-text-primary"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.24, ease: GM_EASE_OUT }}
          >
            <span className="flex flex-col items-center gap-4">
              <SayGMMark className="h-[31px] w-[45px] text-gm-black dark:text-gm-yellow" />
              <span className="text-[15px] font-semibold">Opening your workspace…</span>
            </span>
          </motion.div>
        )}
      </AnimatePresence>
    </main>
  );
}
