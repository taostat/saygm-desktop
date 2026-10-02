import { describe, expect, it } from 'vitest';
import { getLocalDeviceName } from './localDeviceName';

describe('getLocalDeviceName', () => {
  it('keeps the Mac label on macOS', () => {
    expect(getLocalDeviceName('darwin')).toBe('Mac');
  });

  it.each(['linux', 'win32'])('uses a generic label on %s', (platform) => {
    expect(getLocalDeviceName(platform)).toBe('computer');
  });
});
