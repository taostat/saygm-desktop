import { describe, expect, it } from 'vitest';
import {
  applyGuardrailsDraft,
  emptyGuardrailsDraft,
  hasIncompleteRegexRules,
  hasIncompleteTopics,
  hasValidRegexRules,
  hasValidTopics,
  readGuardrailsPolicy,
} from './guardrailsPolicy';

describe('guardrails policy edits', () => {
  it('starts from the actual empty policy without default-on controls', () => {
    expect(readGuardrailsPolicy(null)).toEqual(emptyGuardrailsDraft());
  });

  it('preserves untouched scanner configs and unknown fields when toggling PII', () => {
    const body = {
      'native:pii': { mode: 'redact', vendor_option: 'preserve' },
      'native:secrets': { vendor_option: 'custom', nested: { x: 1 } },
      'native:compress-tool-results': { vendor_option: 'preserve' },
      'native:custom': { enabled: true },
    };
    const draft = { ...readGuardrailsPolicy(body), piiEnabled: false };

    expect(applyGuardrailsDraft(body, draft, { pii: true })).toEqual({
      'native:secrets': { vendor_option: 'custom', nested: { x: 1 } },
      'native:compress-tool-results': { vendor_option: 'preserve' },
      'native:custom': { enabled: true },
    });
  });

  it('uses the current defaults for new PII and secrets controls without changing unrelated fields', () => {
    const body = { 'native:custom': { keep: true } };
    const draft = { ...readGuardrailsPolicy(body), piiEnabled: true, secretsEnabled: true };

    expect(applyGuardrailsDraft(body, draft, { pii: true, secrets: true })).toEqual({
      'native:custom': { keep: true },
      'native:pii': { mode: 'redact-restore' },
      'native:secrets': { mode: 'redact' },
    });
  });

  it('preserves absent mode and custom config on unrelated edits', () => {
    const body = {
      'native:pii': { custom: 'keep' },
      'native:regex': {
        patterns: [{ pattern: '(?i)secret', label: 'SECRET', opaque: 'keep' }],
        metadata: 'keep',
      },
      'native:ban-topics': {
        topics: [{ name: 'violence', keywords: ['harm'], opaque: 8 }],
        custom: true,
      },
      'native:compress-tool-results': { mode: 'legacy', extra: true },
    };
    const draft = { ...readGuardrailsPolicy(body), secretsEnabled: true };

    expect(applyGuardrailsDraft(body, draft, { secrets: true })).toEqual({
      ...body,
      'native:secrets': { mode: 'redact' },
    });
  });

  it('keeps a legacy log-only PII config inactive and unchanged until explicitly enabled', () => {
    const body = { 'native:pii': { mode: 'log-only', custom: true } };
    expect(readGuardrailsPolicy(body).piiEnabled).toBe(false);
    const draft = { ...readGuardrailsPolicy(body), secretsEnabled: true };
    expect(applyGuardrailsDraft(body, draft, { secrets: true })).toEqual({
      ...body,
      'native:secrets': { mode: 'redact' },
    });
  });

  it('emits an empty config when compression is first enabled and removes only it when disabled', () => {
    const body = { 'native:pii': { mode: 'redact' }, 'native:custom': { keep: 2 } };
    const enabled = { ...readGuardrailsPolicy(body), compressEnabled: true };
    expect(applyGuardrailsDraft(body, enabled, { compress: true })).toEqual({
      ...body,
      'native:compress-tool-results': {},
    });

    const withCompression = { ...body, 'native:compress-tool-results': { option: 'keep' } };
    const disabled = { ...readGuardrailsPolicy(withCompression), compressEnabled: false };
    expect(applyGuardrailsDraft(withCompression, disabled, { compress: true })).toEqual(body);
  });

  it('accepts complete Rust regex syntax without applying JavaScript regex rules', () => {
    expect(hasValidRegexRules([{ pattern: '(?i)secret', label: 'SECRET' }])).toBe(true);
    expect(hasValidRegexRules([{ pattern: '', label: 'EMPTY' }])).toBe(false);
    expect(hasValidRegexRules([{ pattern: 'secret', label: ' ' }])).toBe(false);
  });

  it('writes regex rules while preserving scanner and matched-row custom fields', () => {
    const body = {
      'native:regex': {
        mode: 'redact',
        patterns: [
          { pattern: 'OLD', label: 'ORDER', opaque: 'same rule' },
          { pattern: 'DROP', label: 'DROP', opaque: 'must not move' },
        ],
        vendor_option: 'preserve',
      },
      'native:custom': { preserve: true },
    };
    const current = readGuardrailsPolicy(body);
    const draft = {
      ...current,
      patterns: current.patterns.map((pattern, index) =>
        index === 0 ? { ...pattern, pattern: 'NEW' } : pattern
      ),
      regexEnabled: true,
    };

    expect(applyGuardrailsDraft(body, draft, { regex: true })).toEqual({
      'native:regex': {
        mode: 'redact',
        patterns: [
          { pattern: 'NEW', label: 'ORDER', opaque: 'same rule' },
          { pattern: 'DROP', label: 'DROP', opaque: 'must not move' },
        ],
        vendor_option: 'preserve',
      },
      'native:custom': { preserve: true },
    });
  });

  it('preserves an unchanged regex label when the pattern changes', () => {
    const body = {
      'native:regex': {
        mode: 'redact',
        patterns: [{ pattern: '(?i)private', label: ' keep ', future: { row: 1 } }],
      },
    };
    const current = readGuardrailsPolicy(body);
    const draft = {
      ...current,
      patterns: current.patterns.map((pattern) => ({ ...pattern, pattern: '(?i)internal' })),
      regexEnabled: true,
    };

    expect(applyGuardrailsDraft(body, draft, { regex: true })['native:regex']).toEqual({
      mode: 'redact',
      patterns: [{ pattern: '(?i)internal', label: ' keep ', future: { row: 1 } }],
    });
  });

  it('keeps duplicate-label regex rows bound to their own opaque fields', () => {
    const body = {
      'native:regex': {
        mode: 'redact',
        patterns: [
          { pattern: 'FIRST', label: 'SAME', future: 'first' },
          { pattern: 'SECOND', label: 'SAME', future: 'second' },
        ],
      },
    };
    const current = readGuardrailsPolicy(body);
    const draft = {
      ...current,
      patterns: current.patterns.map((pattern, index) =>
        index === 0 ? { ...pattern, pattern: 'UPDATED' } : pattern
      ),
      regexEnabled: true,
    };

    expect(applyGuardrailsDraft(body, draft, { regex: true })['native:regex']).toEqual({
      mode: 'redact',
      patterns: [
        { pattern: 'UPDATED', label: 'SAME', future: 'first' },
        { pattern: 'SECOND', label: 'SAME', future: 'second' },
      ],
    });
  });

  it('preserves an untouched whitespace label when another regex row changes', () => {
    const body = {
      'native:regex': {
        mode: 'redact',
        patterns: [
          { pattern: 'FIRST', label: ' spaced ', future: 'keep exact' },
          { pattern: 'SECOND', label: 'OTHER', future: 'also keep' },
        ],
      },
    };
    const current = readGuardrailsPolicy(body);
    const draft = {
      ...current,
      patterns: current.patterns.map((pattern, index) =>
        index === 1 ? { ...pattern, pattern: 'UPDATED' } : pattern
      ),
      regexEnabled: true,
    };

    expect(applyGuardrailsDraft(body, draft, { regex: true })['native:regex']).toEqual({
      mode: 'redact',
      patterns: [
        { pattern: 'FIRST', label: ' spaced ', future: 'keep exact' },
        { pattern: 'UPDATED', label: 'OTHER', future: 'also keep' },
      ],
    });
  });

  it('does not enable regex rules without a complete pattern and label', () => {
    expect(
      readGuardrailsPolicy({ 'native:regex': { mode: 'redact', patterns: [] } }).regexEnabled
    ).toBe(false);
    const draft = { ...emptyGuardrailsDraft(), regexEnabled: true };
    expect(() => applyGuardrailsDraft(null, draft, { regex: true })).toThrow(/valid regex pattern/);
  });

  it('rejects partial regex rows when editing an enabled scanner', () => {
    const body = { 'native:regex': { patterns: [{ pattern: 'A', label: 'A' }] } };
    const current = readGuardrailsPolicy(body);
    const draft = {
      ...current,
      patterns: [...current.patterns, { pattern: 'PARTIAL', label: '' }],
      regexEnabled: true,
    };
    expect(hasIncompleteRegexRules(draft.patterns)).toBe(true);
    expect(() => applyGuardrailsDraft(body, draft, { regex: true })).toThrow(
      /partially entered regex rule/
    );
  });

  it('uses a block default for topic rules and requires a name plus a keyword', () => {
    const body = { 'native:ban-topics': { topics: [{ name: 'weapons', keywords: ['bomb'] }] } };
    expect(readGuardrailsPolicy(body).topicsEnabled).toBe(true);
    expect(hasValidTopics([{ name: ' ', keywords: ['keyword'] }])).toBe(false);
    expect(hasValidTopics([{ name: 'topic', keywords: [' ', ''] }])).toBe(false);
  });

  it('rejects partially entered topic rows when editing an enabled scanner', () => {
    const body = { 'native:ban-topics': { topics: [{ name: 'weapons', keywords: ['bomb'] }] } };
    const current = readGuardrailsPolicy(body);
    const draft = {
      ...current,
      topics: [...current.topics, { name: 'violence', keywords: [''] }],
      topicsEnabled: true,
    };
    expect(hasIncompleteTopics(draft.topics)).toBe(true);
    expect(() => applyGuardrailsDraft(body, draft, { topics: true })).toThrow(
      /partially entered topic rule/
    );
  });

  it('preserves an unchanged topic name when its keywords change', () => {
    const body = {
      'native:ban-topics': {
        mode: 'block',
        topics: [{ name: ' keep ', keywords: ['old'], opaque: 'retain' }],
      },
    };
    const current = readGuardrailsPolicy(body);
    const draft = {
      ...current,
      topics: current.topics.map((topic) => ({ ...topic, keywords: ['new'] })),
      topicsEnabled: true,
    };

    expect(applyGuardrailsDraft(body, draft, { topics: true })['native:ban-topics']).toEqual({
      mode: 'block',
      topics: [{ name: ' keep ', keywords: ['new'], opaque: 'retain' }],
    });
  });

  it('writes topic rules in block mode and keeps custom row fields by topic identity', () => {
    const body = {
      'native:ban-topics': {
        topics: [
          { name: 'first', keywords: ['one'], opaque: 'first' },
          { name: 'second', keywords: ['two'], opaque: 'second' },
        ],
        extra: 'keep',
      },
    };
    const current = readGuardrailsPolicy(body);
    const draft = {
      ...current,
      topics: current.topics.map((topic) =>
        topic.name === 'second' ? { ...topic, keywords: ['updated'] } : topic
      ),
      topicsEnabled: true,
    };

    expect(applyGuardrailsDraft(body, draft, { topics: true })).toEqual({
      'native:ban-topics': {
        topics: [
          { name: 'first', keywords: ['one'], opaque: 'first' },
          { name: 'second', keywords: ['updated'], opaque: 'second' },
        ],
        extra: 'keep',
      },
    });
  });

  it('changes only the word scanner and preserves unknown scanners and config', () => {
    const body = {
      'native:ban-substrings': {
        mode: 'redact',
        substrings: ['customer phrase'],
        case_sensitive: false,
        upstream_hint: 'keep',
      },
      'native:custom-scanner': { enabled: true, config: { nested: ['keep'] } },
    };
    const draft = {
      ...readGuardrailsPolicy(body),
      wordMode: 'block' as const,
      substrings: ['restricted phrase'],
    };

    expect(applyGuardrailsDraft(body, draft, { words: true })).toEqual({
      'native:ban-substrings': {
        mode: 'block',
        substrings: ['restricted phrase'],
        case_sensitive: false,
        upstream_hint: 'keep',
      },
      'native:custom-scanner': { enabled: true, config: { nested: ['keep'] } },
    });
  });

  it('keeps meaningful substring whitespace but drops blank rows', () => {
    const draft = {
      ...emptyGuardrailsDraft(),
      wordMode: 'redact' as const,
      substrings: ['  literal match  ', '  ', ''],
    };
    expect(applyGuardrailsDraft(null, draft, { words: true })).toEqual({
      'native:ban-substrings': { mode: 'redact', substrings: ['  literal match  '] },
    });
  });

  it('clears only the word guardrail when the list is empty', () => {
    const body = {
      'native:ban-substrings': { mode: 'block', substrings: ['term'] },
      'native:pii': { mode: 'redact' },
    };
    const draft = { ...readGuardrailsPolicy(body), substrings: [''] };
    expect(applyGuardrailsDraft(body, draft, { words: true })).toEqual({
      'native:pii': { mode: 'redact' },
    });
  });

  it('uses the gateway default of redact for an existing word list without a mode', () => {
    const draft = readGuardrailsPolicy({ 'native:ban-substrings': { substrings: ['term'] } });
    expect(draft.wordMode).toBe('redact');
    expect(draft.wordUnsupportedMode).toBeNull();
  });

  it('does not present an explicit legacy word mode as active redaction', () => {
    const draft = readGuardrailsPolicy({
      'native:ban-substrings': { mode: 'log-only', substrings: ['term'] },
    });
    expect(draft.wordMode).toBeNull();
    expect(draft.wordUnsupportedMode).toBe('log-only');
  });
});
