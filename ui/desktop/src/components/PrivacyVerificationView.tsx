import { useState } from 'react';
import type { KeyboardEvent } from 'react';
import GuardrailsPanel from './GuardrailsPanel';
import { PrivacyVerificationPanel } from './PrivacyVerificationPanel';

export default function PrivacyVerificationView() {
  const [section, setSection] = useState<'guardrails' | 'privacy'>('guardrails');
  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const next =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? section === 'guardrails'
          ? 'privacy'
          : 'guardrails'
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? section === 'privacy'
            ? 'guardrails'
            : 'privacy'
          : null;
    if (!next) return;
    event.preventDefault();
    setSection(next);
    document.getElementById(next + '-tab')?.focus();
  };

  return (
    <main className="relative h-full overflow-y-auto overflow-x-hidden">
      <div aria-hidden="true" className="gm-page-glow" />
      <div className="relative px-6 pb-12 pt-16 lg:px-[72px]">
        <div className="mx-auto flex max-w-[1360px] flex-col gap-8">
          <h1 className="sr-only">Privacy and guardrails</h1>
          <nav
            className="gm-guardrails-view-tabs"
            aria-label="Privacy and guardrail sections"
            role="tablist"
          >
            <button
              type="button"
              role="tab"
              id="guardrails-tab"
              aria-selected={section === 'guardrails'}
              aria-controls="guardrails-panel"
              tabIndex={section === 'guardrails' ? 0 : -1}
              onKeyDown={handleTabKeyDown}
              onClick={() => setSection('guardrails')}
            >
              Guardrails
            </button>
            <button
              type="button"
              role="tab"
              id="privacy-tab"
              aria-selected={section === 'privacy'}
              aria-controls="privacy-panel"
              tabIndex={section === 'privacy' ? 0 : -1}
              onKeyDown={handleTabKeyDown}
              onClick={() => setSection('privacy')}
            >
              Privacy &amp; local approvals
            </button>
          </nav>
          <div
            role="tabpanel"
            id="guardrails-panel"
            aria-labelledby="guardrails-tab"
            hidden={section !== 'guardrails'}
          >
            <GuardrailsPanel />
          </div>
          <div
            role="tabpanel"
            id="privacy-panel"
            aria-labelledby="privacy-tab"
            hidden={section !== 'privacy'}
          >
            <PrivacyVerificationPanel />
          </div>
        </div>
      </div>
    </main>
  );
}
