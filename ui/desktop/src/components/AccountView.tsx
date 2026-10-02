import GMAccount from './onboarding/GMAccount';

export default function AccountView() {
  return (
    <main className="relative h-full min-h-0 min-w-0 w-full overflow-x-hidden overflow-y-auto overscroll-contain">
      <div aria-hidden="true" className="gm-page-glow" />
      <div className="relative px-6 pb-12 pt-16 lg:px-[72px]">
        <div className="mx-auto flex max-w-[860px] flex-col gap-8">
          <header className="flex flex-col gap-2.5">
            <p className="gm-mono-label">Account</p>
            <h1 className="gm-display text-[clamp(2.25rem,4.5vw,3rem)]">
              Credit where it’s <span className="gm-serif">due.</span>
            </h1>
            <p className="text-[15px] text-text-secondary">
              Sign-in, balance and credit for this desktop.
            </p>
          </header>

          <GMAccount mode="full" />
        </div>
      </div>
    </main>
  );
}
