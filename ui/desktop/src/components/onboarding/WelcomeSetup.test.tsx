import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { WelcomeBrandPanel } from './WelcomeSetup';

describe('WelcomeBrandPanel platform copy', () => {
  beforeEach(() => {
    Object.assign(window.electron, { platform: 'darwin' });
  });

  it.each([
    ['darwin', 'Mac'],
    ['linux', 'computer'],
    ['win32', 'computer'],
  ])('uses the correct device label on %s', (platform, deviceName) => {
    Object.assign(window.electron, { platform });
    render(<WelcomeBrandPanel />);

    expect(
      screen.getByRole('heading', {
        name: `Say gm to the agent that works on your ${deviceName}.`,
      })
    ).toBeInTheDocument();
    expect(screen.getByText(`Runs on your ${deviceName}`)).toBeInTheDocument();
  });
});
