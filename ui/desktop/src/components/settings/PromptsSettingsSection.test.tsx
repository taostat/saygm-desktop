import { describe, expect, it } from 'vitest';
import { promptDisplayDescription } from './PromptsSettingsSection';

describe('promptDisplayDescription', () => {
  it('uses SayGM display copy for the built-in prompt descriptions', () => {
    expect(
      promptDisplayDescription("Main system prompt that defines goose's personality and behavior")
    ).toBe("Main instructions that shape SayGM's responses and behavior.");
    expect(
      promptDisplayDescription('Prompt for generating new Goose apps based on the user instructions')
    ).toBe('Instructions for creating an app from your request.');
    expect(
      promptDisplayDescription('Prompt for updating existing Goose apps based on feedback')
    ).toBe('Instructions for updating an app from your feedback.');
  });

  it('leaves other backend descriptions unchanged', () => {
    expect(promptDisplayDescription('A custom prompt description')).toBe(
      'A custom prompt description'
    );
    expect(promptDisplayDescription('constructor')).toBe('constructor');
    expect(promptDisplayDescription('__proto__')).toBe('__proto__');
  });
});
