import type {
  GmGuardrailsMode,
  GmGuardrailsPolicyBody,
  GmGuardrailsWordMode,
} from '../types/gmAccount';

export const PII_SCANNER_ID = 'native:pii';
export const SECRETS_SCANNER_ID = 'native:secrets';
export const REGEX_SCANNER_ID = 'native:regex';
export const BAN_SUBSTRINGS_SCANNER_ID = 'native:ban-substrings';
export const BAN_TOPICS_SCANNER_ID = 'native:ban-topics';
export const COMPRESS_SCANNER_ID = 'native:compress-tool-results';

export type RegexPattern = {
  pattern: string;
  label: string;
  storedConfig?: Record<string, unknown>;
  originalPattern?: string;
  originalLabel?: string;
};
export type TopicRule = {
  name: string;
  keywords: string[];
  storedConfig?: Record<string, unknown>;
  originalName?: string;
  originalKeywords?: string[];
};
export type ScannerChange = 'pii' | 'secrets' | 'compress' | 'regex' | 'words' | 'topics';
export type ScannerChanges = Partial<Record<ScannerChange, true>>;

export type GuardrailsDraft = {
  piiEnabled: boolean;
  piiMode: GmGuardrailsMode;
  piiLegacyMode: string | null;
  secretsEnabled: boolean;
  secretsMode: GmGuardrailsMode;
  secretsLegacyMode: string | null;
  compressEnabled: boolean;
  regexEnabled: boolean;
  regexMode: GmGuardrailsMode;
  regexLegacyMode: string | null;
  patterns: RegexPattern[];
  wordMode: GmGuardrailsWordMode | null;
  wordUnsupportedMode: string | null;
  substrings: string[];
  topicsEnabled: boolean;
  topics: TopicRule[];
};

export function emptyGuardrailsDraft(): GuardrailsDraft {
  return {
    piiEnabled: false,
    piiMode: 'redact-restore',
    piiLegacyMode: null,
    secretsEnabled: false,
    secretsMode: 'redact',
    secretsLegacyMode: null,
    compressEnabled: false,
    regexEnabled: false,
    regexMode: 'redact-restore',
    regexLegacyMode: null,
    patterns: [{ pattern: '', label: '' }],
    wordMode: 'redact',
    wordUnsupportedMode: null,
    substrings: [''],
    topicsEnabled: false,
    topics: [{ name: '', keywords: [''] }],
  };
}

export function readGuardrailsPolicy(body: GmGuardrailsPolicyBody | null): GuardrailsDraft {
  const draft = emptyGuardrailsDraft();
  if (!body) return draft;

  const pii = asRecord(body[PII_SCANNER_ID]);
  const secrets = asRecord(body[SECRETS_SCANNER_ID]);
  const piiMode = readMode(pii?.mode, 'redact-restore');
  const secretsMode = readMode(secrets?.mode, 'redact');
  draft.piiEnabled = pii !== null && piiMode.active;
  draft.piiMode = piiMode.mode;
  draft.piiLegacyMode = pii !== null ? piiMode.legacy : null;
  draft.secretsEnabled = secrets !== null && secretsMode.active;
  draft.secretsMode = secretsMode.mode;
  draft.secretsLegacyMode = secrets !== null ? secretsMode.legacy : null;
  draft.compressEnabled = Object.prototype.hasOwnProperty.call(body, COMPRESS_SCANNER_ID);

  const regex = asRecord(body[REGEX_SCANNER_ID]);
  if (regex) {
    const regexMode = readMode(regex.mode, 'redact-restore');
    draft.patterns = readPatterns(regex.patterns);
    draft.regexEnabled = regexMode.active && hasValidRegexRules(draft.patterns);
    draft.regexMode = regexMode.mode;
    draft.regexLegacyMode = regexMode.legacy;
  }

  const words = asRecord(body[BAN_SUBSTRINGS_SCANNER_ID]);
  if (words) {
    const values = words.substrings;
    if (
      values !== undefined &&
      (!Array.isArray(values) || values.some((value) => typeof value !== 'string'))
    ) {
      throw new Error('The saved word list could not be read.');
    }
    const hasMode = Object.prototype.hasOwnProperty.call(words, 'mode');
    const mode = words.mode;
    draft.wordMode = mode === 'redact' || mode === 'block' ? mode : !hasMode ? 'redact' : null;
    draft.wordUnsupportedMode =
      hasMode && mode !== 'redact' && mode !== 'block'
        ? typeof mode === 'string'
          ? mode
          : 'unknown'
        : null;
    draft.substrings =
      Array.isArray(values) && values.length > 0 ? ([...values] as string[]) : [''];
  }

  const topics = asRecord(body[BAN_TOPICS_SCANNER_ID]);
  if (topics) {
    draft.topics = readTopics(topics.topics);
    draft.topicsEnabled = isBlockTopicsMode(topics.mode) && hasValidTopics(draft.topics);
  }

  return draft;
}

export function hasValidRegexRules(patterns: RegexPattern[]): boolean {
  // The gateway uses Rust regex syntax, which differs from JavaScript's. The
  // desktop can confirm each rule has the required values, but cannot compile
  // it with the gateway's engine. Unsupported expressions are skipped there.
  return cleanPatterns(patterns).length > 0;
}

export function hasIncompleteRegexRules(patterns: RegexPattern[]): boolean {
  return patterns.some((item) => {
    const hasPattern = item.pattern.trim().length > 0;
    const hasLabel = item.label.trim().length > 0;
    return (hasPattern || hasLabel) && !(hasPattern && hasLabel);
  });
}

export function hasValidTopics(topics: TopicRule[]): boolean {
  return topics.some(
    (topic) => topic.name.trim().length > 0 && cleanStrings(topic.keywords).length > 0
  );
}

export function hasIncompleteTopics(topics: TopicRule[]): boolean {
  return topics.some((topic) => {
    const hasName = topic.name.trim().length > 0;
    const hasKeyword = cleanStrings(topic.keywords).length > 0;
    const hasAnyValue = hasName || topic.keywords.some((keyword) => keyword.trim().length > 0);
    return hasAnyValue && !(hasName && hasKeyword);
  });
}

export function hasValidWords(mode: GmGuardrailsMode | null, substrings: string[]): boolean {
  return mode !== null && cleanStrings(substrings).length > 0;
}

export function applyGuardrailsDraft(
  body: GmGuardrailsPolicyBody | null,
  draft: GuardrailsDraft,
  changes: ScannerChanges
): GmGuardrailsPolicyBody {
  const next: GmGuardrailsPolicyBody = { ...(body ?? {}) };

  if (changes.pii) {
    const config = updateRedactScanner(
      body?.[PII_SCANNER_ID],
      draft.piiEnabled,
      draft.piiMode,
      'redact-restore'
    );
    if (config === DELETE_VALUE) delete next[PII_SCANNER_ID];
    else next[PII_SCANNER_ID] = config;
  }
  if (changes.secrets) {
    const config = updateRedactScanner(
      body?.[SECRETS_SCANNER_ID],
      draft.secretsEnabled,
      draft.secretsMode,
      'redact'
    );
    if (config === DELETE_VALUE) delete next[SECRETS_SCANNER_ID];
    else next[SECRETS_SCANNER_ID] = config;
  }
  if (changes.compress) {
    if (draft.compressEnabled) {
      if (!Object.prototype.hasOwnProperty.call(next, COMPRESS_SCANNER_ID)) {
        next[COMPRESS_SCANNER_ID] = {};
      }
    } else {
      delete next[COMPRESS_SCANNER_ID];
    }
  }
  if (changes.regex) {
    if (!draft.regexEnabled) {
      delete next[REGEX_SCANNER_ID];
    } else {
      const patterns = serializePatterns(draft.patterns);
      if (!hasValidRegexRules(draft.patterns))
        throw new Error(
          'Add at least one valid regex pattern and label before enabling this rule.'
        );
      if (hasIncompleteRegexRules(draft.patterns))
        throw new Error('Complete or remove every partially entered regex rule before saving.');
      const previous = asRecord(body?.[REGEX_SCANNER_ID]);
      const config: Record<string, unknown> = { ...(previous ?? {}) };
      if (previous?.mode === undefined && draft.regexMode === 'redact-restore') {
        delete config.mode;
      } else {
        config.mode = draft.regexMode;
      }
      config.patterns = patterns;
      next[REGEX_SCANNER_ID] = config;
    }
  }
  if (changes.words) {
    const values = cleanStrings(draft.substrings);
    if (values.length === 0) {
      delete next[BAN_SUBSTRINGS_SCANNER_ID];
    } else {
      if (!draft.wordMode)
        throw new Error('Choose whether matching words should be redacted or blocked.');
      const previous = asRecord(body?.[BAN_SUBSTRINGS_SCANNER_ID]);
      next[BAN_SUBSTRINGS_SCANNER_ID] = {
        ...(previous ?? {}),
        mode: draft.wordMode,
        substrings: values,
      };
    }
  }
  if (changes.topics) {
    if (!draft.topicsEnabled) {
      delete next[BAN_TOPICS_SCANNER_ID];
    } else {
      const topics = serializeTopics(draft.topics);
      if (!hasValidTopics(draft.topics))
        throw new Error('Add a topic with at least one keyword before enabling topic blocking.');
      if (hasIncompleteTopics(draft.topics))
        throw new Error('Complete or remove every partially entered topic rule before saving.');
      const previous = asRecord(body?.[BAN_TOPICS_SCANNER_ID]);
      const config: Record<string, unknown> = { ...(previous ?? {}) };
      if (!isBlockTopicsMode(previous?.mode)) config.mode = 'block';
      config.topics = topics;
      next[BAN_TOPICS_SCANNER_ID] = config;
    }
  }

  return next;
}

export function sameDraft(a: GuardrailsDraft, b: GuardrailsDraft): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function updateRedactScanner(
  currentValue: unknown,
  enabled: boolean,
  mode: GmGuardrailsMode,
  defaultMode: GmGuardrailsMode
): unknown {
  if (!enabled) return DELETE_VALUE;
  const current = asRecord(currentValue);
  if (current && isSupportedMode(current.mode)) {
    return current.mode === mode ? currentValue : { ...current, mode };
  }
  if (current && current.mode === undefined && mode === defaultMode) return currentValue;
  return { ...(current ?? {}), mode };
}

const DELETE_VALUE = Symbol('delete scanner');

function isSupportedMode(value: unknown): value is GmGuardrailsMode {
  return value === 'redact' || value === 'redact-restore' || value === 'block';
}

function readMode(
  value: unknown,
  defaultMode: GmGuardrailsMode
): { mode: GmGuardrailsMode; active: boolean; legacy: string | null } {
  if (value === undefined) return { mode: defaultMode, active: true, legacy: null };
  if (isSupportedMode(value)) return { mode: value, active: true, legacy: null };
  return {
    mode: defaultMode,
    active: false,
    legacy: typeof value === 'string' ? value : 'unknown',
  };
}

function isBlockTopicsMode(value: unknown): boolean {
  // Topics are block-only and default to block when mode is absent.
  return value === undefined || value === 'block';
}

function readPatterns(value: unknown): RegexPattern[] {
  const rows = Array.isArray(value) ? value : [];
  const parsed = rows.flatMap((row) => {
    const record = asRecord(row);
    return typeof record?.pattern === 'string' && typeof record.label === 'string'
      ? [
          {
            pattern: record.pattern,
            label: record.label,
            storedConfig: { ...record },
            originalPattern: record.pattern,
            originalLabel: record.label,
          },
        ]
      : [];
  });
  return parsed.length > 0 ? parsed : [{ pattern: '', label: '' }];
}

function readTopics(value: unknown): TopicRule[] {
  const rows = Array.isArray(value) ? value : [];
  const parsed = rows.flatMap((row) => {
    const record = asRecord(row);
    return typeof record?.name === 'string'
      ? [
          {
            name: record.name,
            keywords: Array.isArray(record.keywords)
              ? record.keywords.filter((keyword): keyword is string => typeof keyword === 'string')
              : [''],
            storedConfig: { ...record },
            originalName: record.name,
            originalKeywords: Array.isArray(record.keywords)
              ? record.keywords.filter((keyword): keyword is string => typeof keyword === 'string')
              : [''],
          },
        ]
      : [];
  });
  return parsed.length > 0 ? parsed : [{ name: '', keywords: [''] }];
}

function cleanPatterns(patterns: RegexPattern[]): RegexPattern[] {
  return patterns.filter((item) => item.pattern.trim().length > 0 && item.label.trim().length > 0);
}

function serializePatterns(patterns: RegexPattern[]): Record<string, unknown>[] {
  return cleanPatterns(patterns).map((item) => {
    const unchanged =
      item.storedConfig &&
      item.pattern === item.originalPattern &&
      item.label === item.originalLabel;
    if (unchanged) return { ...item.storedConfig };
    return {
      ...(item.storedConfig ?? {}),
      pattern: item.pattern,
      label: item.label === item.originalLabel ? item.originalLabel : item.label.trim(),
    };
  });
}

function serializeTopics(topics: TopicRule[]): Record<string, unknown>[] {
  return topics
    .filter((topic) => topic.name.trim().length > 0 && cleanStrings(topic.keywords).length > 0)
    .map((topic) => {
      const unchanged =
        topic.storedConfig &&
        topic.name === topic.originalName &&
        JSON.stringify(topic.keywords) === JSON.stringify(topic.originalKeywords);
      if (unchanged) return { ...topic.storedConfig };
      return {
        ...(topic.storedConfig ?? {}),
        name: topic.name === topic.originalName ? topic.originalName : topic.name.trim(),
        keywords:
          JSON.stringify(topic.keywords) === JSON.stringify(topic.originalKeywords)
            ? topic.originalKeywords
            : cleanStrings(topic.keywords),
      };
    });
}

function cleanStrings(values: string[]): string[] {
  return values.filter((value) => value.trim().length > 0);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
