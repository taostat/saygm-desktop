/**
 * Theme tokens — the single source of truth for all MCP semantic token values.
 *
 * Every key in McpUiStyleVariableKey must be present in both lightTokens and
 * darkTokens. The TypeScript compiler enforces this: if the SDK adds a new key,
 * the build breaks until both maps are updated.
 *
 * Values are applied to :root via style.setProperty() before first paint
 * (see renderer.tsx). main.css only registers the variable names for Tailwind
 * class generation — it does NOT define values.
 *
 * These tokens serve two purposes:
 *  1. Goose desktop — applied to :root per resolved theme.
 *  2. MCP apps — encoded as light-dark() in hostContext.styles.variables.
 */
import type {
  McpUiHostStyles,
  McpUiStyleVariableKey,
  McpUiStyles,
} from '@modelcontextprotocol/ext-apps/app-bridge';

type ThemeTokens = Record<McpUiStyleVariableKey, string>;

// Subset of keys that are the same across both themes.
type BaseTokenKey = Extract<
  McpUiStyleVariableKey,
  `--font-${string}` | `--border-radius-${string}` | `--border-width-${string}`
>;

type ColorTokenKey = Exclude<McpUiStyleVariableKey, BaseTokenKey>;

// ---------------------------------------------------------------------------
// Base tokens — shared across light and dark themes
// ---------------------------------------------------------------------------
const baseTokens: Pick<ThemeTokens, BaseTokenKey> = {
  // Typography — design-system fonts bundled locally from pinned OFL packages.
  '--font-sans':
    '"Onest Variable", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  '--font-mono':
    '"Geist Mono Variable", "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace',

  // Typography — weights
  '--font-weight-normal': '400',
  '--font-weight-medium': '500',
  '--font-weight-semibold': '600',
  '--font-weight-bold': '700',

  // Typography — text sizes
  '--font-text-xs-size': '0.75rem',
  '--font-text-sm-size': '0.875rem',
  '--font-text-md-size': '1rem',
  '--font-text-lg-size': '1.125rem',

  // Typography — heading sizes
  '--font-heading-xs-size': '1rem',
  '--font-heading-sm-size': '1.125rem',
  '--font-heading-md-size': '1.25rem',
  '--font-heading-lg-size': '1.5rem',
  '--font-heading-xl-size': '1.875rem',
  '--font-heading-2xl-size': '2.25rem',
  '--font-heading-3xl-size': '3rem',

  // Typography — text line heights
  '--font-text-xs-line-height': '1rem',
  '--font-text-sm-line-height': '1.25rem',
  '--font-text-md-line-height': '1.5rem',
  '--font-text-lg-line-height': '1.75rem',

  // Typography — heading line heights
  '--font-heading-xs-line-height': '1.5rem',
  '--font-heading-sm-line-height': '1.75rem',
  '--font-heading-md-line-height': '1.75rem',
  '--font-heading-lg-line-height': '2rem',
  '--font-heading-xl-line-height': '2.25rem',
  '--font-heading-2xl-line-height': '2.5rem',
  '--font-heading-3xl-line-height': '3.5rem',

  // Border radius
  '--border-radius-xs': '4px',
  '--border-radius-sm': '6px',
  '--border-radius-md': '8px',
  '--border-radius-lg': '12px',
  '--border-radius-xl': '16px',
  '--border-radius-full': '9999px',

  // Border width
  '--border-width-regular': '1px',
};

// Theme-specific color/shadow tokens only.
type ColorTokens = Pick<ThemeTokens, ColorTokenKey>;

// ---------------------------------------------------------------------------
// Light theme — colors & shadows
// ---------------------------------------------------------------------------
const lightColorTokens: ColorTokens = {
  // Backgrounds: gm cream canvas. Secondary/tertiary are the design's ink-tinted
  // chip wells flattened onto the canvas so they stay opaque for MCP apps.
  '--color-background-primary': '#fff5d8',
  '--color-background-secondary': '#f5ecd0',
  '--color-background-tertiary': '#ebe3c8',
  '--color-background-inverse': '#0a0f12',
  '--color-background-ghost': 'transparent',
  '--color-background-info': '#2f6feb',
  '--color-background-danger': '#ff503f',
  '--color-background-success': '#2bbf6a',
  '--color-background-warning': '#ffb300',
  '--color-background-disabled': '#ebe3c8',

  // Text: ink with the design system's 62% / 42% tiers
  '--color-text-primary': '#0a0f12',
  '--color-text-secondary': 'rgba(10, 15, 18, 0.62)',
  '--color-text-tertiary': 'rgba(10, 15, 18, 0.42)',
  '--color-text-inverse': '#ffffff',
  '--color-text-ghost': 'rgba(10, 15, 18, 0.42)',
  '--color-text-info': '#2458c6',
  '--color-text-danger': '#b42318',
  '--color-text-success': '#1e7a45',
  '--color-text-warning': '#8a5b00',
  '--color-text-disabled': 'rgba(10, 15, 18, 0.3)',

  // Borders: hairline / default / strong ink alphas
  '--color-border-primary': 'rgba(10, 15, 18, 0.1)',
  '--color-border-secondary': 'rgba(10, 15, 18, 0.14)',
  '--color-border-tertiary': 'rgba(10, 15, 18, 0.2)',
  '--color-border-inverse': '#0a0f12',
  '--color-border-ghost': 'transparent',
  '--color-border-info': '#2f6feb',
  '--color-border-danger': '#ff503f',
  '--color-border-success': '#2bbf6a',
  '--color-border-warning': '#ffb300',
  '--color-border-disabled': 'rgba(10, 15, 18, 0.1)',

  // Rings: brown focus ring on cream (amber is under 3:1 against the canvas)
  '--color-ring-primary': '#592f05',
  '--color-ring-secondary': 'rgba(10, 15, 18, 0.2)',
  '--color-ring-inverse': '#ffffff',
  '--color-ring-info': '#2f6feb',
  '--color-ring-danger': '#ff503f',
  '--color-ring-success': '#2bbf6a',
  '--color-ring-warning': '#ffb300',

  // Shadows: soft ink on cream
  '--shadow-hairline': '0 0 0 1px rgba(10, 15, 18, 0.06)',
  '--shadow-sm': '0 1px 2px 0 rgba(10, 15, 18, 0.06)',
  '--shadow-md': '0 2px 10px 0 rgba(10, 15, 18, 0.06)',
  '--shadow-lg': '0 20px 40px -14px rgba(10, 15, 18, 0.22)',
};

// ---------------------------------------------------------------------------
// Dark theme — colors & shadows
// ---------------------------------------------------------------------------
const darkColorTokens: ColorTokens = {
  // Backgrounds: gm ink canvas with the design system's ink surface ramp
  '--color-background-primary': '#0a0f12',
  '--color-background-secondary': '#15181b',
  '--color-background-tertiary': '#1d2225',
  '--color-background-inverse': '#ffffff',
  '--color-background-ghost': 'transparent',
  '--color-background-info': '#7aa7ff',
  '--color-background-danger': '#ff503f',
  '--color-background-success': '#2bbf6a',
  '--color-background-warning': '#fb8c00',
  '--color-background-disabled': '#1d2225',

  // Text: white with the design system's 62% / 40% tiers
  '--color-text-primary': '#ffffff',
  '--color-text-secondary': 'rgba(255, 255, 255, 0.62)',
  '--color-text-tertiary': 'rgba(255, 255, 255, 0.4)',
  '--color-text-inverse': '#0a0f12',
  '--color-text-ghost': 'rgba(255, 255, 255, 0.4)',
  '--color-text-info': '#8db4ff',
  '--color-text-danger': '#ff8074',
  '--color-text-success': '#54d98c',
  '--color-text-warning': '#ffb152',
  '--color-text-disabled': 'rgba(255, 255, 255, 0.28)',

  // Borders: hairline / default / strong white alphas
  '--color-border-primary': 'rgba(255, 255, 255, 0.08)',
  '--color-border-secondary': 'rgba(255, 255, 255, 0.12)',
  '--color-border-tertiary': 'rgba(255, 255, 255, 0.15)',
  '--color-border-inverse': '#ffffff',
  '--color-border-ghost': 'transparent',
  '--color-border-info': '#7aa7ff',
  '--color-border-danger': '#ff503f',
  '--color-border-success': '#2bbf6a',
  '--color-border-warning': '#fb8c00',
  '--color-border-disabled': 'rgba(255, 255, 255, 0.08)',

  // Rings: gm yellow focus ring on ink
  '--color-ring-primary': '#ffce3f',
  '--color-ring-secondary': 'rgba(255, 255, 255, 0.15)',
  '--color-ring-inverse': '#0a0f12',
  '--color-ring-info': '#7aa7ff',
  '--color-ring-danger': '#ff503f',
  '--color-ring-success': '#2bbf6a',
  '--color-ring-warning': '#fb8c00',

  // Shadows: the design system's restrained ink shadows
  '--shadow-hairline': '0 0 0 1px rgba(10, 13, 18, 0.3)',
  '--shadow-sm': '0 1px 2px 0 rgba(10, 13, 18, 0.3)',
  '--shadow-md': '0 4px 16px 0 rgba(10, 13, 18, 0.35)',
  '--shadow-lg': '0 16px 48px 0 rgba(10, 13, 18, 0.45)',
};

// ---------------------------------------------------------------------------
// Aura theme — colors & shadows (dark variant)
// Ported from OpenChamber's Aura preset: purple-black surfaces, purple accent,
// mint/peach/cyan/coral status colors, monospace typography.
// ---------------------------------------------------------------------------
const auraColorTokens: ColorTokens = {
  // Backgrounds
  '--color-background-primary': '#15141b',
  '--color-background-secondary': '#1a1921',
  '--color-background-tertiary': '#201e2b',
  '--color-background-inverse': '#a277ff',
  '--color-background-ghost': 'transparent',
  '--color-background-info': '#82e2ff',
  '--color-background-danger': '#ff6767',
  '--color-background-success': '#61ffca',
  '--color-background-warning': '#ffca85',
  '--color-background-disabled': '#25232f',

  // Text
  '--color-text-primary': '#edecee',
  '--color-text-secondary': '#8a8282',
  '--color-text-tertiary': '#6d6d6d',
  '--color-text-inverse': '#15141b',
  '--color-text-ghost': '#8a8282',
  '--color-text-info': '#82e2ff',
  '--color-text-danger': '#ff6767',
  '--color-text-success': '#61ffca',
  '--color-text-warning': '#ffca85',
  '--color-text-disabled': '#525b68',

  // Borders
  '--color-border-primary': '#2d2b38',
  '--color-border-secondary': '#47415a',
  '--color-border-tertiary': '#4e496c',
  '--color-border-inverse': '#edecee',
  '--color-border-ghost': 'transparent',
  '--color-border-info': '#82e2ff',
  '--color-border-danger': '#ff6767',
  '--color-border-success': '#61ffca',
  '--color-border-warning': '#ffca85',
  '--color-border-disabled': '#2d2b38',

  // Rings
  '--color-ring-primary': '#47415a',
  '--color-ring-secondary': '#2d2b38',
  '--color-ring-inverse': '#15141b',
  '--color-ring-info': '#82e2ff',
  '--color-ring-danger': '#ff6767',
  '--color-ring-success': '#61ffca',
  '--color-ring-warning': '#ffca85',

  // Shadows (dark)
  '--shadow-hairline': '0 0 0 1px rgba(0, 0, 0, 0.2)',
  '--shadow-sm': '0 1px 2px 0 rgba(0, 0, 0, 0.2)',
  '--shadow-md': '0 4px 6px -1px rgba(0, 0, 0, 0.3), 0 2px 4px -2px rgba(0, 0, 0, 0.2)',
  '--shadow-lg': '0 10px 15px -3px rgba(0, 0, 0, 0.3), 0 4px 6px -4px rgba(0, 0, 0, 0.2)',
};

// Aura is monospace-first — override the shared sans family.
const auraFontTokens: Partial<Pick<ThemeTokens, BaseTokenKey>> = {
  '--font-sans':
    'ui-monospace, "SFMono-Regular", "Menlo", "Cascadia Mono", "Segoe UI Mono", monospace',
  '--font-mono':
    'ui-monospace, "SFMono-Regular", "Menlo", "Cascadia Mono", "Segoe UI Mono", monospace',
};

// ---------------------------------------------------------------------------
// Merged token maps — used by applyThemeTokens() and buildMcpHostStyles()
// ---------------------------------------------------------------------------
export const lightTokens: ThemeTokens = { ...baseTokens, ...lightColorTokens };
export const darkTokens: ThemeTokens = { ...baseTokens, ...darkColorTokens };
export const auraTokens: ThemeTokens = { ...baseTokens, ...auraFontTokens, ...auraColorTokens };

// ---------------------------------------------------------------------------
// Theme registry — the set of selectable named themes.
// `variant` drives the .dark/.light class and colorScheme for anything outside
// the token system; `tokens` is the map applied to :root. Adding a future theme
// is a single entry here plus its token map above.
// ---------------------------------------------------------------------------
export type ThemeId = 'light' | 'dark' | 'aura';
export type ThemeVariant = 'light' | 'dark';

interface ThemeDefinition {
  variant: ThemeVariant;
  tokens: ThemeTokens;
}

export const themes: Record<ThemeId, ThemeDefinition> = {
  light: { variant: 'light', tokens: lightTokens },
  dark: { variant: 'dark', tokens: darkTokens },
  aura: { variant: 'dark', tokens: auraTokens },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build the McpUiHostStyles object for MCP apps.
 *
 * For the built-in light/dark pair, color keys use light-dark() so a single
 * payload resolves correctly against the guest's color-scheme. Custom themes
 * (e.g. aura) share a variant with dark but carry their own palette and fonts,
 * so light-dark() can't express them — emit that theme's concrete token values
 * instead. Non-color keys always use the theme's own values so overrides like
 * Aura's monospace font family reach the guest. The host ships no webfont
 * files, so no @font-face payload is sent.
 */
export function buildMcpHostStyles(themeId: ThemeId = 'light'): McpUiHostStyles {
  const tokens = (themes[themeId] ?? themes.light).tokens;
  const isBuiltinVariant = themeId === 'light' || themeId === 'dark';
  const variables: McpUiStyles = {} as McpUiStyles;
  for (const key of Object.keys(lightTokens) as McpUiStyleVariableKey[]) {
    if (key.startsWith('--color-') && isBuiltinVariant) {
      variables[key] = `light-dark(${lightTokens[key]}, ${darkTokens[key]})`;
    } else {
      variables[key] = tokens[key];
    }
  }
  return { variables };
}

/**
 * Resolve the current theme id from localStorage / system preference.
 * Best-effort pre-paint resolution; the authoritative preference lives in the
 * Electron settings store and is applied by ThemeContext once loaded.
 */
export function getResolvedTheme(): ThemeId {
  const useSystem = localStorage.getItem('use_system_theme') !== 'false';
  if (useSystem) {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  const stored = localStorage.getItem('theme');
  if (stored === 'aura') return 'aura';
  return stored === 'dark' ? 'dark' : 'light';
}

const SCOPED_TOKENS_STYLE_ID = 'gm-scoped-theme-tokens';

function scopedColorRule(selector: string, tokens: ThemeTokens): string {
  const declarations = Object.entries(tokens)
    .filter(([key]) => key.startsWith('--color-') || key.startsWith('--shadow-'))
    .map(([key, value]) => `${key}: ${value};`)
    .join(' ');
  return `${selector} { ${declarations} }`;
}

/**
 * The gm design pins some regions to one canvas regardless of the app theme
 * (the ink sidebar, the cream sign-in panel). `.gm-dark` / `.gm-light` subtrees
 * receive the full dark / light colour set so nested upstream components follow.
 */
function ensureScopedThemeTokens(): void {
  if (document.getElementById(SCOPED_TOKENS_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = SCOPED_TOKENS_STYLE_ID;
  style.textContent = [
    scopedColorRule('.gm-light', lightTokens),
    scopedColorRule('.gm-dark', darkTokens),
  ].join('\n');
  document.head.appendChild(style);
}

/**
 * Apply a theme's tokens to the document root as CSS custom properties.
 * When called without an argument, resolves the theme from localStorage.
 */
export function applyThemeTokens(theme?: ThemeId): void {
  const resolved = theme ?? getResolvedTheme();
  const { tokens } = themes[resolved] ?? themes.light;
  const root = document.documentElement;
  for (const [key, value] of Object.entries(tokens)) {
    root.style.setProperty(key, value);
  }
  ensureScopedThemeTokens();
}
