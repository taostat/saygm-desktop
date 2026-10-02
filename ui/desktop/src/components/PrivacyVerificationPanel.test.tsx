import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PrivacyVerificationPanel } from './PrivacyVerificationPanel';

vi.mock('./LocalToolApprovalsCard', () => ({
  LocalToolApprovalsCard: () => null,
}));

describe('PrivacyVerificationPanel platform copy', () => {
  beforeEach(() => {
    Object.assign(window.electron, { platform: 'darwin' });
  });

  it.each([
    ['darwin', 'This Mac'],
    ['linux', 'This computer'],
    ['win32', 'This computer'],
  ])('labels the local machine correctly on %s', (platform, label) => {
    Object.assign(window.electron, { platform });
    render(<PrivacyVerificationPanel />);

    expect(screen.getByText(label)).toBeInTheDocument();
  });
});
