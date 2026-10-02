function isMac(): boolean {
  return window.electron?.platform === 'darwin';
}

export function getSearchShortcutText(): string {
  return isMac() ? '⌘F' : 'Ctrl+F';
}
