import type { ComponentProps } from 'react';
import { cn } from '../utils';

// The gm Design System Logo symbol: a six-ray sunburst above the sun dot.
const MARK_VIEWBOX = '0 0 72.029 49.5';
const MARK_PATH =
  'M 2.045 41.11 L 10.221 41.11 C 13.33 41.11 16.266 39.699 18.224 37.281 C 20.009 35.122 22.168 33.279 24.615 31.869 C 25.219 31.523 25.824 31.207 26.457 30.919 C 27.868 30.285 29.336 29.767 30.891 29.422 C 32.503 29.048 34.201 28.846 35.957 28.846 L 36.044 28.846 C 37.771 28.846 39.47 29.048 41.111 29.422 C 42.665 29.767 44.133 30.285 45.544 30.919 C 46.177 31.207 46.782 31.523 47.386 31.869 C 49.834 33.279 51.993 35.122 53.778 37.281 C 55.735 39.699 58.672 41.11 61.781 41.11 L 69.957 41.11 C 71.108 41.11 72.029 40.189 72.029 39.037 L 72.029 32.963 C 72.029 31.811 71.108 30.89 69.957 30.89 L 50.438 30.89 C 49.661 30.89 49.258 29.94 49.834 29.393 L 63.652 15.575 C 64.458 14.768 64.458 13.473 63.652 12.667 L 59.276 8.406 C 58.47 7.6 57.175 7.6 56.368 8.406 L 42.55 22.225 C 42.003 22.772 41.053 22.397 41.053 21.62 L 41.053 2.073 C 41.053 0.921 40.132 0 38.98 0 L 32.935 0 C 31.783 0 30.862 0.921 30.862 2.073 L 30.862 21.591 C 30.862 22.369 29.912 22.772 29.365 22.196 L 15.546 8.377 C 14.74 7.571 13.445 7.571 12.639 8.377 L 8.378 12.696 C 7.572 13.502 7.572 14.797 8.378 15.603 L 22.197 29.422 C 22.744 29.969 22.369 30.919 21.592 30.919 L 2.073 30.919 C 0.922 30.919 0.001 31.84 0.001 32.992 L 0.001 39.037 C -0.028 40.16 0.893 41.11 2.045 41.11 Z';

export function SayGMMark(props: ComponentProps<'svg'>) {
  return (
    <svg viewBox={MARK_VIEWBOX} fill="none" aria-hidden="true" {...props}>
      <path d={MARK_PATH} fill="currentColor" />
      <circle cx="36.014" cy="42.3" r="7.2" fill="currentColor" />
    </svg>
  );
}

/**
 * Symbol and "SayGM" wordmark at the design system's Logo proportions. `size`
 * is the Logo size in px; colour follows `currentColor`.
 */
export function SayGMLockup({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <span className={cn('inline-flex items-center', className)} style={{ gap: size * 0.42 }}>
      <SayGMMark width={size * 1.12} height={size * 0.77} className="block shrink-0" />
      <span
        className="whitespace-nowrap font-sans font-semibold leading-none tracking-[-0.03em]"
        style={{ fontSize: size * 1.28 }}
      >
        SayGM
      </span>
    </span>
  );
}
