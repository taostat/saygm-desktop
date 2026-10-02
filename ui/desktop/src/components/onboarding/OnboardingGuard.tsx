import { useCallback, useEffect, useRef, useState } from 'react';
import { RotateCw } from 'lucide-react';
import { acpReadConfig, acpUpsertConfig } from '../../acp/config';
import { acpReadDefaults } from '../../acp/providers';
import { SayGMLockup } from '../SayGMMark';
import WelcomeSetup from './WelcomeSetup';

interface OnboardingGuardProps {
  children: React.ReactNode;
}

type SetupStatus = 'checking' | 'error' | 'setup' | 'ready';

async function ensureSafeToolApprovalDefault() {
  const currentMode = await acpReadConfig('GOOSE_MODE', false);
  if (currentMode == null || currentMode === '') {
    await acpUpsertConfig('GOOSE_MODE', 'approve', false);
  }
}

async function isSayGMConfigured(): Promise<boolean> {
  const [account, defaults] = await Promise.all([
    window.electron.gmAccount.getStatus(),
    acpReadDefaults(),
  ]);
  return (
    account.connected &&
    account.providerConfigured &&
    defaults.providerId === 'saygm' &&
    typeof defaults.modelId === 'string' &&
    !!defaults.modelId.trim()
  );
}

function StartupSplash() {
  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-surface-page">
      <div aria-hidden="true" className="gm-page-glow" />
      <div className="relative flex flex-col items-center gap-5">
        <SayGMLockup size={20} className="text-gm-black dark:text-gm-yellow" />
        <p role="status" className="gm-status">
          <span className="gm-spinner" aria-hidden="true" />
          Starting SayGM Desktop…
        </p>
      </div>
    </main>
  );
}

function StartupError({ onRetry }: { onRetry: () => void }) {
  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-surface-page px-6 py-10">
      <div aria-hidden="true" className="gm-page-glow" />
      <section className="gm-card relative flex w-full max-w-lg flex-col gap-4 p-8">
        <p className="gm-mono-label">Startup</p>
        <h1 className="gm-display text-[32px] leading-[1.15]">
          SayGM Desktop could not finish <span className="gm-serif">startup.</span>
        </h1>
        <p className="text-[15px] text-text-secondary">
          The local agent service may still be starting. Check again in a moment.
        </p>
        <div>
          <button type="button" onClick={onRetry} className="gm-btn">
            <RotateCw className="size-4" aria-hidden="true" />
            Retry
          </button>
        </div>
      </section>
    </main>
  );
}

export default function OnboardingGuard({ children }: OnboardingGuardProps) {
  const [status, setStatus] = useState<SetupStatus>('checking');
  const statusRef = useRef<SetupStatus>('checking');
  const readinessCheckId = useRef(0);

  const updateStatus = useCallback((next: SetupStatus) => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  const checkSetup = useCallback(
    async (showChecking = true) => {
      const checkId = ++readinessCheckId.current;
      if (showChecking) updateStatus('checking');
      try {
        await ensureSafeToolApprovalDefault();
        const ready = await isSayGMConfigured();
        if (checkId !== readinessCheckId.current) return;
        updateStatus(ready ? 'ready' : 'setup');
      } catch (error) {
        console.error('Unable to check SayGM setup:', error);
        if (checkId === readinessCheckId.current) updateStatus('error');
      }
    },
    [updateStatus]
  );

  const completeSetup = useCallback(async () => {
    const checkId = ++readinessCheckId.current;
    try {
      if (!(await isSayGMConfigured())) {
        throw new Error('Your SayGM account or model choice was not saved. Try again.');
      }
      if (checkId === readinessCheckId.current) updateStatus('ready');
    } catch (error) {
      if (checkId === readinessCheckId.current) updateStatus('setup');
      throw error;
    }
  }, [updateStatus]);

  useEffect(() => {
    const unsubscribe = window.electron.gmAccount.onChanged(() => {
      void checkSetup(statusRef.current === 'ready');
    });
    const handleFocus = () => void checkSetup(false);

    window.addEventListener('focus', handleFocus);
    void checkSetup();

    return () => {
      readinessCheckId.current += 1;
      unsubscribe();
      window.removeEventListener('focus', handleFocus);
    };
  }, [checkSetup]);

  switch (status) {
    case 'checking':
      return <StartupSplash />;
    case 'error':
      return <StartupError onRetry={() => void checkSetup()} />;
    case 'setup':
      return <WelcomeSetup onComplete={completeSetup} />;
    case 'ready':
      return <>{children}</>;
  }
}
