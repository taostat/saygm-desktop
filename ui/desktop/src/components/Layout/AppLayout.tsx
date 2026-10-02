import React, { useCallback, useEffect, useRef, useState } from 'react';
import { IpcRendererEvent } from 'electron';
import { Outlet, useLocation } from 'react-router';
import { motion, useReducedMotion } from 'framer-motion';
import { PanelLeft } from 'lucide-react';
import { defineMessages, useIntl } from '../../i18n';
import { Button } from '../ui/button';
import ChatSessionsContainer from '../ChatSessionsContainer';
import { useChatContext } from '../../contexts/ChatContext';
import { NavigationProvider, useNavigationContext } from './NavigationContext';
import { Navigation } from './NavigationPanel';
import { Z_INDEX } from './constants';
import { cn } from '../../utils';
import { SayGMLockup } from '../SayGMMark';
import { UserInput } from '../../types/message';
import type { LiveVoiceController } from '../../liveVoice/useLiveVoice';

const i18n = defineMessages({
  openNavigation: {
    id: 'appLayout.openNavigation',
    defaultMessage: 'Open navigation',
  },
  collapseNavigation: {
    id: 'appLayout.collapseNavigation',
    defaultMessage: 'Collapse navigation',
  },
});

interface AppLayoutContentProps {
  activeSessions: Array<{
    sessionId: string;
    initialMessage?: UserInput;
    noAutoSubmit?: boolean;
  }>;
  liveVoice: LiveVoiceController;
}

const AppLayoutContent: React.FC<AppLayoutContentProps> = ({ activeSessions, liveVoice }) => {
  const intl = useIntl();
  const location = useLocation();
  const prefersReducedMotion = useReducedMotion() ?? false;
  const safeIsMacOS = (window?.electron?.platform || 'darwin') === 'darwin';
  const chatContext = useChatContext();
  const isOnPairRoute = location.pathname === '/pair';
  const isOnSettingsRoute = location.pathname === '/settings';

  const [isFullScreen, setIsFullScreen] = useState(false);

  useEffect(() => {
    if (!safeIsMacOS) return;
    window.electron
      .getIsFullScreen()
      .then(setIsFullScreen)
      .catch(() => {});
    const handler = (_event: IpcRendererEvent, ...args: unknown[]) => {
      setIsFullScreen(Boolean(args[0]));
    };
    window.electron.on('fullscreen-change', handler);
    return () => window.electron.off('fullscreen-change', handler);
  }, [safeIsMacOS]);

  const { isNavExpanded, setIsNavExpanded, navWidth, setNavWidth } = useNavigationContext();
  const [isDragging, setIsDragging] = useState(false);
  const isResizing = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);

  const handleResizeMouseDown = useCallback(
    (e: React.MouseEvent) => {
      isResizing.current = true;
      startX.current = e.clientX;
      startWidth.current = navWidth;
      setIsDragging(true);
      e.preventDefault();
    },
    [navWidth]
  );

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing.current) return;
      setNavWidth(startWidth.current + (e.clientX - startX.current));
    };
    const handleMouseUp = () => {
      if (isResizing.current) {
        isResizing.current = false;
        setIsDragging(false);
      }
    };
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [setNavWidth]);

  if (!chatContext) {
    throw new Error('AppLayoutContent must be used within ChatProvider');
  }

  const { setChat } = chatContext;

  if (isOnSettingsRoute) {
    return (
      <div className="relative flex h-full w-full flex-1 bg-background-secondary">
        <Outlet />
        <div className="hidden">
          <ChatSessionsContainer
            setChat={setChat}
            activeSessions={activeSessions}
            liveVoice={liveVoice}
          />
        </div>
      </div>
    );
  }

  const needsTrafficLightInset = safeIsMacOS && !isFullScreen;
  const headerPadding = needsTrafficLightInset ? 'pl-[96px]' : 'pl-4';
  const headerTop = needsTrafficLightInset ? 'top-[14px]' : 'top-[11px]';
  const navToggleTitle = intl.formatMessage(
    isNavExpanded ? i18n.collapseNavigation : i18n.openNavigation
  );
  // Left inset for content headers so they clear the window controls and the
  // collapsed-navigation toggle overlay.
  const collapsedHeaderInset = needsTrafficLightInset ? 240 : 156;
  const layoutStyle = {
    '--gm-header-inset': `${isNavExpanded ? 24 : collapsedHeaderInset}px`,
  } as React.CSSProperties;

  return (
    <div
      className="flex flex-1 w-full h-full relative bg-background-primary flex-row"
      style={layoutStyle}
    >
      <div
        style={{ zIndex: Z_INDEX.HEADER }}
        className={cn('absolute flex items-center gap-2', headerPadding, headerTop, 'ml-1.5')}
      >
        <Button
          onClick={() => setIsNavExpanded(!isNavExpanded)}
          className={cn(
            'no-drag rounded-full',
            isNavExpanded
              ? 'text-white/60 hover:!bg-white/10 hover:text-white'
              : 'text-text-secondary hover:!bg-surface-chip hover:text-text-primary'
          )}
          variant="ghost"
          size="xs"
          title={navToggleTitle}
          aria-label={navToggleTitle}
          aria-expanded={isNavExpanded}
        >
          <PanelLeft className="w-5 h-5" />
        </Button>
        {!isNavExpanded && (
          <SayGMLockup size={14} className="no-drag text-gm-black dark:text-gm-yellow" />
        )}
      </div>

      {/* The ink sidebar sits flush against the cream canvas. */}
      <div className="flex flex-1 w-full h-full min-h-0 flex-row">
        <motion.div
          key="nav"
          initial={false}
          animate={{ width: isNavExpanded ? navWidth : 0 }}
          transition={
            isDragging || prefersReducedMotion
              ? { duration: 0 }
              : { duration: 0.24, ease: [0.2, 0.8, 0.2, 1] }
          }
          style={{ height: '100%' }}
          className="relative flex-shrink-0 overflow-hidden h-full"
        >
          <aside
            aria-label="Sidebar"
            className="gm-dark gm-rail relative w-full h-full overflow-hidden border-r border-border-primary"
          >
            <Navigation activeLiveVoiceSessionId={liveVoice.activeSessionId} />
          </aside>
          {isNavExpanded && (
            <div
              className="gm-resize-handle absolute right-0 top-0 h-full w-1.5 cursor-col-resize"
              onMouseDown={handleResizeMouseDown}
            />
          )}
        </motion.div>

        {/* Main content flows on the canvas. */}
        <div className={cn('flex-1 overflow-hidden min-h-0', !isNavExpanded && 'pt-14')}>
          {isOnPairRoute ? (
            <Outlet />
          ) : (
            <motion.div
              key={location.pathname}
              className="h-full"
              initial={prefersReducedMotion ? false : { opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={
                prefersReducedMotion
                  ? { duration: 0 }
                  : { duration: 0.24, ease: [0.2, 0.8, 0.2, 1] }
              }
            >
              <Outlet />
            </motion.div>
          )}
          {/* Always render ChatSessionsContainer to keep SSE connections alive.
              When navigating away from /pair, hide it with CSS */}
          <div className={isOnPairRoute ? 'contents' : 'hidden'}>
            <ChatSessionsContainer
              setChat={setChat}
              activeSessions={activeSessions}
              liveVoice={liveVoice}
            />
          </div>
        </div>
      </div>
    </div>
  );
};

interface AppLayoutProps {
  activeSessions: Array<{
    sessionId: string;
    initialMessage?: UserInput;
    noAutoSubmit?: boolean;
  }>;
  liveVoice: LiveVoiceController;
}

export const AppLayout: React.FC<AppLayoutProps> = ({ activeSessions, liveVoice }) => {
  return (
    <NavigationProvider>
      <AppLayoutContent activeSessions={activeSessions} liveVoice={liveVoice} />
    </NavigationProvider>
  );
};
