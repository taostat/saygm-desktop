import { ArrowUpRight } from 'lucide-react';
import { defineMessages, useIntl } from '../i18n';
import GooseLogo from './GooseLogo';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';

const i18n = defineMessages({
  eyebrow: { id: 'about.eyebrow', defaultMessage: 'About SayGM' },
  title: { id: 'about.title', defaultMessage: 'Built on Goose' },
  description: {
    id: 'about.description',
    defaultMessage:
      'Goose is the open source AI agent framework behind SayGM. Thank you to the Goose team and community for building this foundation.',
  },
  gooseLink: { id: 'about.gooseLink', defaultMessage: 'Explore Goose' },
  saygmLink: { id: 'about.saygmLink', defaultMessage: 'Visit SayGM.com' },
  version: { id: 'about.version', defaultMessage: 'SayGM Desktop · Version {version}' },
});

export default function AboutView() {
  const intl = useIntl();
  const version = window.electron.getVersion();

  return (
    <main className="relative h-full min-h-0 min-w-0 w-full overflow-x-hidden overflow-y-auto overscroll-contain">
      <div aria-hidden="true" className="gm-page-glow" />
      <div className="relative flex min-h-full items-center justify-center px-6 pb-12 pt-16 lg:px-[72px]">
        <div className="w-full max-w-[820px]">
          <Card className="gap-0 overflow-hidden rounded-xl py-0 shadow-lg">
            <div className="h-1.5 bg-gm-yellow" aria-hidden="true" />
            <CardHeader className="pb-5 pt-7">
              <div className="flex flex-col items-start gap-5 sm:flex-row">
                <div
                  aria-hidden="true"
                  className="flex size-20 shrink-0 items-center justify-center rounded-full bg-gm-yellow/20 text-text-primary"
                >
                  <GooseLogo size="default" hover={false} />
                </div>
                <div className="space-y-3 pt-1">
                  <span className="inline-flex rounded-full bg-gm-yellow/20 px-2.5 py-1 text-[11px] font-semibold text-text-primary">
                    {intl.formatMessage(i18n.eyebrow)}
                  </span>
                  <CardTitle>
                    <h1 className="gm-display text-3xl font-semibold tracking-tight">
                      {intl.formatMessage(i18n.title)}
                    </h1>
                  </CardTitle>
                  <CardDescription className="max-w-[620px] text-base leading-relaxed">
                    {intl.formatMessage(i18n.description)}
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="px-6 pb-6 pt-2 sm:pl-[132px]">
              <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
                <a
                  href="https://github.com/aaif-goose/goose"
                  target="_blank"
                  rel="noreferrer"
                  onClick={(event) => {
                    event.preventDefault();
                    void window.electron.openExternal('https://github.com/aaif-goose/goose');
                  }}
                  className="gm-link inline-flex items-center gap-1 text-sm font-medium"
                >
                  {intl.formatMessage(i18n.gooseLink)}
                  <ArrowUpRight className="size-3.5" aria-hidden="true" />
                </a>
                <a
                  href="https://saygm.com/"
                  target="_blank"
                  rel="noreferrer"
                  onClick={(event) => {
                    event.preventDefault();
                    void window.electron.openExternal('https://saygm.com/');
                  }}
                  className="gm-link inline-flex items-center gap-1 text-sm font-medium"
                >
                  {intl.formatMessage(i18n.saygmLink)}
                  <ArrowUpRight className="size-3.5" aria-hidden="true" />
                </a>
              </div>
              <p className="mt-7 border-t border-border-primary pt-4 text-xs text-text-secondary">
                {intl.formatMessage(i18n.version, { version })}
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </main>
  );
}
