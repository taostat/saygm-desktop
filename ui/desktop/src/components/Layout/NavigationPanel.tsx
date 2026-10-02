import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router';
import { AudioLines, ChevronDown, ChevronRight, MessageSquare, Plus } from 'lucide-react';
import { useNavigationContext } from './NavigationContext';
import { useConfig } from '../ConfigContext';
import { useNavigationSessions } from '../../hooks/useNavigationSessions';
import {
  ACCOUNT_NAV_ITEM,
  NAV_ITEMS,
  PRIVACY_NAV_ITEM,
  SETTINGS_NAV_ITEM,
  getNavItemLabel,
  type NavItem,
} from '../../hooks/useNavigationItems';
import { AppEvents } from '../../constants/events';
import { InlineEditText } from '../common/InlineEditText';
import { SessionIndicators } from '../SessionIndicators';
import { acpRenameSession, type SessionListItem } from '../../acp/sessions';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/Tooltip';
import { formatMessageTimestamp } from '../../utils/timeUtils';
import { cn } from '../../utils';
import type { ProjectGroup } from '../../utils/projectSessions';
import { defineMessages, useIntl } from '../../i18n';
import { SayGMLockup } from '../SayGMMark';
import { formatShortcut } from '../settings/keyboard/KeyboardShortcutsSection';

type StreamState = 'idle' | 'loading' | 'streaming' | 'error';

interface SessionStatus {
  streamState: StreamState;
  hasUnreadActivity: boolean;
}

const i18n = defineMessages({
  chats: {
    id: 'navigationPanel.chats',
    defaultMessage: 'Chats',
  },
  noChats: {
    id: 'navigationPanel.noChats',
    defaultMessage: 'No recent chats',
  },
  noChatsHint: {
    id: 'navigationPanel.noChatsHint',
    defaultMessage: 'Say gm to start one.',
  },
  loadingChats: {
    id: 'navigationPanel.loadingChats',
    defaultMessage: 'Loading chats…',
  },
  untitledSession: {
    id: 'navigationPanel.untitledSession',
    defaultMessage: 'Untitled session',
  },
  metaModel: {
    id: 'navigationPanel.metaModel',
    defaultMessage: 'Model',
  },
  metaDirectory: {
    id: 'navigationPanel.metaDirectory',
    defaultMessage: 'Directory',
  },
  metaStatus: {
    id: 'navigationPanel.metaStatus',
    defaultMessage: 'Status',
  },
  metaCreated: {
    id: 'navigationPanel.metaCreated',
    defaultMessage: 'Created',
  },
  metaUpdated: {
    id: 'navigationPanel.metaUpdated',
    defaultMessage: 'Updated',
  },
  statusStreaming: {
    id: 'navigationPanel.statusStreaming',
    defaultMessage: 'Streaming',
  },
  statusError: {
    id: 'navigationPanel.statusError',
    defaultMessage: 'Error',
  },
  statusUnread: {
    id: 'navigationPanel.statusUnread',
    defaultMessage: 'Unread activity',
  },
  statusIdle: {
    id: 'navigationPanel.statusIdle',
    defaultMessage: 'Idle',
  },
  returnToActiveLiveVoice: {
    id: 'liveVoice.returnToActive',
    defaultMessage: 'Return to active Live voice',
  },
  balanceUnavailable: {
    id: 'navigationPanel.balanceUnavailable',
    defaultMessage: 'Balance unavailable',
  },
});

const BALANCE_REFRESH_ON_FOCUS_MS = 60_000;

/**
 * The account balance shown beside the Account row. Never shows a zero for a
 * balance that could not be read: failures render as a dash.
 */
function useRailBalance(): number | 'unavailable' | null {
  const [balance, setBalance] = useState<number | 'unavailable' | null>(null);

  useEffect(() => {
    let active = true;
    let generation = 0;
    let lastLoadAt = 0;
    const load = async () => {
      const request = ++generation;
      lastLoadAt = Date.now();
      try {
        const status = await window.electron.gmAccount.getStatus();
        if (!status.connected) {
          if (active && request === generation) setBalance(null);
          return;
        }
        const { usd } = await window.electron.gmAccount.getBalance();
        const value = Number(usd);
        if (active && request === generation) {
          setBalance(Number.isFinite(value) ? value : 'unavailable');
        }
      } catch (error) {
        console.error('Could not load the account balance:', error);
        if (active && request === generation) setBalance('unavailable');
      }
    };

    void load();
    const unsubscribe = window.electron.gmAccount.onChanged(() => void load());
    // Balances move as the user spends, so refresh when they come back to the
    // window, but not on every quick focus change.
    const handleFocus = () => {
      if (Date.now() - lastLoadAt > BALANCE_REFRESH_ON_FOCUS_MS) void load();
    };
    window.addEventListener('focus', handleFocus);
    return () => {
      active = false;
      unsubscribe();
      window.removeEventListener('focus', handleFocus);
    };
  }, []);

  return balance;
}

/** The user's configured "New chat" accelerator, formatted for display; null when disabled. */
function useNewChatShortcut(): string | null {
  const [shortcut, setShortcut] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    window.electron
      .getSetting('keyboardShortcuts')
      .then(({ newChat }) => {
        if (!active) return;
        const isMac = window.electron.platform === 'darwin';
        const label = newChat ? formatShortcut(newChat) : null;
        setShortcut(label && isMac ? label.replaceAll('+', '') : label);
      })
      .catch((error) => console.error('Could not read keyboard shortcuts:', error));
    return () => {
      active = false;
    };
  }, []);

  return shortcut;
}

interface NavRowProps {
  item: NavItem;
  active: boolean;
  onClick: () => void;
  trailing?: React.ReactNode;
  compact?: boolean;
}

const NavRow: React.FC<NavRowProps> = ({ item, active, onClick, trailing, compact = false }) => {
  const intl = useIntl();
  const Icon = item.icon;
  return (
    <button
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={cn('gm-rail-row no-drag', compact && 'gm-rail-row--compact')}
    >
      <Icon className="size-4 flex-shrink-0 text-text-secondary" aria-hidden="true" />
      <span className="flex-1 truncate">{getNavItemLabel(item, intl)}</span>
      {item.getTag && (
        <span className="font-mono text-[11px] text-text-tertiary">{item.getTag()}</span>
      )}
      {trailing}
    </button>
  );
};

interface SessionRowProps {
  session: SessionListItem;
  active: boolean;
  isLiveVoiceActive: boolean;
  status: SessionStatus | undefined;
  onClick: () => void;
  onRenamed: () => void;
}

const formatTimestamp = (value?: string): string | null => {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  return formatMessageTimestamp(parsed / 1000);
};

const MetaRow: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex gap-2">
    <span className="text-text-inverse/60 flex-shrink-0">{label}</span>
    <span className="text-right ml-auto break-all">{value}</span>
  </div>
);

interface SessionTooltipContentProps {
  session: SessionListItem;
  statusLabel: string;
}

const SessionTooltipContent: React.FC<SessionTooltipContentProps> = ({ session, statusLabel }) => {
  const intl = useIntl();
  const model = session.modelId
    ? session.providerId
      ? `${session.modelId} (${session.providerId})`
      : session.modelId
    : session.providerId;
  const created = formatTimestamp(session.createdAt);
  const updated = formatTimestamp(session.lastMessageAt ?? session.updatedAt);

  return (
    <div className="flex flex-col gap-1 text-xs">
      <div className="font-medium break-words">
        {session.name || intl.formatMessage(i18n.untitledSession)}
      </div>
      <div className="flex flex-col gap-0.5">
        {model && <MetaRow label={intl.formatMessage(i18n.metaModel)} value={model} />}
        {session.workingDir && (
          <MetaRow label={intl.formatMessage(i18n.metaDirectory)} value={session.workingDir} />
        )}
        <MetaRow label={intl.formatMessage(i18n.metaStatus)} value={statusLabel} />
        {created && <MetaRow label={intl.formatMessage(i18n.metaCreated)} value={created} />}
        {updated && <MetaRow label={intl.formatMessage(i18n.metaUpdated)} value={updated} />}
      </div>
    </div>
  );
};

const SessionRow: React.FC<SessionRowProps> = ({
  session,
  active,
  isLiveVoiceActive,
  status,
  onClick,
  onRenamed,
}) => {
  const intl = useIntl();
  const [isEditing, setIsEditing] = useState(false);
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const isStreaming = status?.streamState === 'streaming';
  const hasError = status?.streamState === 'error';
  const hasUnread = status?.hasUnreadActivity ?? false;

  const statusLabel = isStreaming
    ? intl.formatMessage(i18n.statusStreaming)
    : hasError
      ? intl.formatMessage(i18n.statusError)
      : hasUnread
        ? intl.formatMessage(i18n.statusUnread)
        : intl.formatMessage(i18n.statusIdle);

  return (
    <Tooltip open={tooltipOpen && !isEditing} onOpenChange={setTooltipOpen} delayDuration={400}>
      <TooltipTrigger asChild>
        <div
          role="button"
          tabIndex={0}
          aria-current={active ? 'page' : undefined}
          onClick={() => !isEditing && onClick()}
          onKeyDown={(event) => {
            if (isEditing || event.target !== event.currentTarget) return;
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              onClick();
            }
          }}
          className="gm-rail-row gm-rail-row--compact no-drag min-w-0"
        >
          <MessageSquare className="size-4 flex-shrink-0 text-text-tertiary" aria-hidden="true" />
          <InlineEditText
            value={session.name}
            onSave={async (newName) => {
              await acpRenameSession(session.id, newName);
              window.dispatchEvent(
                new CustomEvent(AppEvents.SESSION_RENAMED, {
                  detail: { sessionId: session.id, newName, userInitiated: true },
                })
              );
              onRenamed();
            }}
            placeholder={intl.formatMessage(i18n.untitledSession)}
            disabled={isStreaming}
            singleClickEdit={false}
            className="truncate text-text-primary flex-1 !px-0 !py-0 hover:bg-transparent"
            editClassName="!text-sm"
            onEditStart={() => setIsEditing(true)}
            onEditEnd={() => setIsEditing(false)}
          />
          {isLiveVoiceActive && (
            <AudioLines
              className="w-3.5 h-3.5 flex-shrink-0 text-blue-500"
              aria-label={intl.formatMessage(i18n.returnToActiveLiveVoice)}
            />
          )}
          <SessionIndicators isStreaming={isStreaming} hasUnread={hasUnread} hasError={hasError} />
        </div>
      </TooltipTrigger>
      <TooltipContent side="right" align="start" className="max-w-xs text-left">
        <SessionTooltipContent session={session} statusLabel={statusLabel} />
      </TooltipContent>
    </Tooltip>
  );
};

export const Navigation: React.FC<{
  className?: string;
  activeLiveVoiceSessionId: string | null;
}> = ({ className, activeLiveVoiceSessionId }) => {
  const intl = useIntl();
  const { isNavExpanded } = useNavigationContext();
  const location = useLocation();
  const { extensionsList } = useConfig();

  const appsExtensionEnabled = !!extensionsList?.find((ext) => ext.name === 'apps')?.enabled;

  const visibleItems = useMemo<NavItem[]>(() => {
    return NAV_ITEMS.filter((item) => {
      if (item.path === '/apps') return appsExtensionEnabled;
      return true;
    });
  }, [appsExtensionEnabled]);

  const isActive = useCallback((path: string) => location.pathname === path, [location.pathname]);

  const {
    recentSessions,
    recentSessionsByProject,
    isLoadingSessions,
    activeSessionId,
    fetchSessions,
    handleNavClick,
    handleSessionClick,
  } = useNavigationSessions();

  const [sessionStatuses, setSessionStatuses] = useState<Map<string, SessionStatus>>(new Map());
  const railBalance = useRailBalance();
  const newChatShortcut = useNewChatShortcut();

  useEffect(() => {
    const handleStatusUpdate = (event: Event) => {
      const { sessionId, streamState } = (event as CustomEvent).detail;
      setSessionStatuses((prev) => {
        const existing = prev.get(sessionId);
        const shouldMarkUnread = existing?.streamState === 'streaming' && streamState === 'idle';
        const next = new Map(prev);
        next.set(sessionId, {
          streamState,
          hasUnreadActivity: existing?.hasUnreadActivity || shouldMarkUnread,
        });
        return next;
      });
    };

    window.addEventListener(AppEvents.SESSION_STATUS_UPDATE, handleStatusUpdate);
    return () => window.removeEventListener(AppEvents.SESSION_STATUS_UPDATE, handleStatusUpdate);
  }, []);

  const clearUnread = useCallback((sessionId: string) => {
    setSessionStatuses((prev) => {
      const status = prev.get(sessionId);
      if (status?.hasUnreadActivity) {
        const next = new Map(prev);
        next.set(sessionId, { ...status, hasUnreadActivity: false });
        return next;
      }
      return prev;
    });
  }, []);

  const navFocusRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isNavExpanded) {
      fetchSessions();
      requestAnimationFrame(() => navFocusRef.current?.focus());
    }
  }, [isNavExpanded, fetchSessions]);

  const [isChatsExpanded, setIsChatsExpanded] = useState(true);
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(new Set());

  const toggleProjectCollapsed = useCallback((path: string) => {
    setCollapsedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  if (!isNavExpanded) return null;

  const homeItem = visibleItems.find((item) => item.id === 'home');
  const sectionItems = visibleItems.filter((item) => item.id !== 'home');

  return (
    <div
      ref={navFocusRef}
      tabIndex={-1}
      className={cn(
        'gm-fade-up-fast gm-rail-scroll-region relative flex h-full flex-col outline-none',
        className
      )}
    >
      <div aria-hidden="true" className="gm-burst -left-10 -top-[60px] size-[360px]" />
      <div className="gm-rail-scroll-content relative flex min-h-0 flex-1 flex-col gap-4 px-3 pb-3 pt-12">
        <div className="px-2">
          <SayGMLockup size={16} className="text-gm-yellow" />
        </div>

        {homeItem && (
          <button
            onClick={() => handleNavClick(homeItem.path)}
            aria-current={isActive(homeItem.path) ? 'page' : undefined}
            className="gm-new-chat no-drag"
          >
            <Plus className="size-4" aria-hidden="true" />
            <span className="flex-1 text-left">{getNavItemLabel(homeItem, intl)}</span>
            {newChatShortcut && (
              <kbd aria-hidden="true" className="gm-kbd">
                {newChatShortcut}
              </kbd>
            )}
          </button>
        )}

        <nav aria-label="Main" className="flex flex-col gap-0.5">
          {sectionItems.map((item) => (
            <NavRow
              key={item.id}
              item={item}
              compact
              active={isActive(item.path)}
              onClick={() => handleNavClick(item.path)}
            />
          ))}
        </nav>

        <div className="gm-rail-sessions flex min-h-0 flex-1 flex-col gap-0.5">
          <button
            onClick={() => setIsChatsExpanded((v) => !v)}
            aria-expanded={isChatsExpanded}
            className="gm-section-label no-drag flex items-center gap-1.5 self-start rounded-md px-2.5 pb-1.5 pt-2 transition-colors hover:text-text-secondary"
          >
            <span>{intl.formatMessage(i18n.chats)}</span>
            <ChevronDown
              className={cn('size-3 transition-transform', !isChatsExpanded && '-rotate-90')}
              aria-hidden="true"
            />
          </button>
          {isChatsExpanded && (
            <div className="gm-rail-session-list flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
              {recentSessions.length === 0 ? (
                isLoadingSessions ? (
                  <p role="status" className="gm-status px-2.5 py-2">
                    <span className="gm-spinner" aria-hidden="true" />
                    {intl.formatMessage(i18n.loadingChats)}
                  </p>
                ) : (
                  <div className="px-2.5 py-2 text-[13px]">
                    <p className="text-text-secondary">{intl.formatMessage(i18n.noChats)}</p>
                    <p className="text-text-tertiary">{intl.formatMessage(i18n.noChatsHint)}</p>
                  </div>
                )
              ) : recentSessionsByProject.length > 1 ? (
                recentSessionsByProject.map((group: ProjectGroup) => {
                  const isCollapsed = collapsedProjects.has(group.path);
                  return (
                    <React.Fragment key={group.path}>
                      <button
                        onClick={() => toggleProjectCollapsed(group.path)}
                        aria-expanded={!isCollapsed}
                        className="no-drag flex w-full items-center gap-1 rounded-md px-2.5 pb-1 pt-2 font-mono text-[10px] uppercase tracking-[0.08em] text-text-tertiary transition-colors hover:text-text-secondary"
                        title={group.path}
                      >
                        {isCollapsed ? (
                          <ChevronRight className="w-3 h-3 flex-shrink-0" />
                        ) : (
                          <ChevronDown className="w-3 h-3 flex-shrink-0" />
                        )}
                        <span className="truncate">{group.label}</span>
                      </button>
                      {!isCollapsed &&
                        group.sessions.map((session) => (
                          <SessionRow
                            key={session.id}
                            session={session}
                            active={session.id === activeSessionId}
                            isLiveVoiceActive={session.id === activeLiveVoiceSessionId}
                            status={sessionStatuses.get(session.id)}
                            onClick={() => {
                              clearUnread(session.id);
                              handleSessionClick(session.id);
                            }}
                            onRenamed={fetchSessions}
                          />
                        ))}
                    </React.Fragment>
                  );
                })
              ) : (
                recentSessions.map((session) => (
                  <SessionRow
                    key={session.id}
                    session={session}
                    active={session.id === activeSessionId}
                    isLiveVoiceActive={session.id === activeLiveVoiceSessionId}
                    status={sessionStatuses.get(session.id)}
                    onClick={() => {
                      clearUnread(session.id);
                      handleSessionClick(session.id);
                    }}
                    onRenamed={fetchSessions}
                  />
                ))
              )}
            </div>
          )}
        </div>

        <div className="mt-auto flex flex-col gap-0.5 border-t border-border-primary pt-3">
          <NavRow
            item={ACCOUNT_NAV_ITEM}
            active={isActive(ACCOUNT_NAV_ITEM.path)}
            onClick={() => handleNavClick(ACCOUNT_NAV_ITEM.path)}
            trailing={
              railBalance !== null && (
                <span className="font-mono text-[11px] text-text-tertiary">
                  {railBalance === 'unavailable' ? (
                    <>
                      <span aria-hidden="true">—</span>
                      <span className="sr-only">{intl.formatMessage(i18n.balanceUnavailable)}</span>
                    </>
                  ) : (
                    intl.formatNumber(railBalance, { style: 'currency', currency: 'USD' })
                  )}
                </span>
              )
            }
          />
          <NavRow
            item={PRIVACY_NAV_ITEM}
            active={isActive(PRIVACY_NAV_ITEM.path)}
            onClick={() => handleNavClick(PRIVACY_NAV_ITEM.path)}
          />
          <NavRow
            item={SETTINGS_NAV_ITEM}
            active={isActive(SETTINGS_NAV_ITEM.path)}
            onClick={() => handleNavClick(SETTINGS_NAV_ITEM.path)}
          />
        </div>
      </div>
    </div>
  );
};
