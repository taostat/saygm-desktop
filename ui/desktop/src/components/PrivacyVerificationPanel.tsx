import type { ReactNode } from 'react';
import { Cpu, Laptop, Plug } from 'lucide-react';
import { SayGMMark } from './SayGMMark';
import { LocalToolApprovalsCard } from './LocalToolApprovalsCard';

function FlowStop({
  icon,
  label,
  children,
  highlight = false,
}: {
  icon: ReactNode;
  label: string;
  children: ReactNode;
  highlight?: boolean;
}) {
  return (
    <li
      className={`gm-card flex min-w-0 flex-col gap-2 p-4 ${highlight ? 'border-gm-yellow bg-gm-yellow text-gm-black' : ''}`}
    >
      <span className="flex items-center gap-2 font-semibold">
        {icon}
        {label}
      </span>
      <span
        className={`text-[13px] leading-5 ${highlight ? 'text-gm-brown' : 'text-text-secondary'}`}
      >
        {children}
      </span>
    </li>
  );
}

function FlowConnector() {
  return (
    <li aria-hidden="true" className="flex items-center justify-center md:w-8">
      <span className="gm-flow-connector gm-flow-connector--vertical md:hidden" />
      <span className="gm-flow-connector hidden w-full md:block" />
    </li>
  );
}

export function PrivacyVerificationPanel() {
  return (
    <section aria-labelledby="privacy-verification-title" className="text-text-primary">
      <p className="gm-mono-label">Privacy &amp; guardrails</p>
      <h2
        id="privacy-verification-title"
        className="gm-display mt-2 text-[clamp(2.25rem,4.5vw,3rem)]"
      >
        Where your work <span className="gm-serif">goes.</span>
      </h2>
      <p className="mt-2 text-[15px] text-text-secondary">What runs here and what travels.</p>

      <ol
        aria-label="Request path"
        className="mt-7 grid grid-cols-1 items-stretch gap-y-2 md:grid-cols-[minmax(0,1fr)_32px_minmax(0,1fr)_32px_minmax(0,1fr)]"
      >
        <FlowStop icon={<Laptop className="size-4" aria-hidden="true" />} label="This Mac">
          Your desktop agent and local tools run on this computer.
        </FlowStop>
        <FlowConnector />
        <FlowStop
          highlight
          icon={<SayGMMark className="size-4" aria-hidden="true" />}
          label="SayGM hosted API"
        >
          A model request is sent to SayGM’s hosted API.
        </FlowStop>
        <FlowConnector />
        <FlowStop icon={<Cpu className="size-4" aria-hidden="true" />} label="Model provider">
          The request is routed to the selected model provider.
        </FlowStop>
      </ol>

      <p className="mt-4 flex items-center gap-2 text-[13px] text-text-secondary">
        <Plug className="size-4 shrink-0" aria-hidden="true" />
        Connected remote tools may process information on their own servers.
      </p>

      <div className="mt-8 max-w-[900px]">
        <LocalToolApprovalsCard />
      </div>
    </section>
  );
}
