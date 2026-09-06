import type { SVGProps } from 'react';

export interface IconProps extends SVGProps<SVGSVGElement> {
  /** Square size in px. Default: 20 (mockup meta-icon scale). */
  readonly size?: number;
}

/**
 * Shared inline-SVG icon scaffolding: square viewBox, currentColor strokes,
 * so icons inherit text color from their surroundings (tokens, not hardcoded
 * colors). Props in, element out; icons are stateless by definition.
 */
function IconSvg({ size = 20, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

/** Camera: the sim viewport / capture indicator. */
export function CameraIcon(props: IconProps) {
  return (
    <IconSvg {...props}>
      <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h9A1.5 1.5 0 0 1 15 7.5v9a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 3 16.5z" />
      <path d="m15 10 5-3v10l-5-3" />
    </IconSvg>
  );
}

/** Play: the idle-viewport start affordance (filled triangle). */
export function PlayIcon(props: IconProps) {
  return (
    <IconSvg {...props}>
      <path d="M8 5.5v13l11-6.5z" fill="currentColor" stroke="none" />
    </IconSvg>
  );
}

/** Pulse: inference activity / latency indicator. */
export function PulseIcon(props: IconProps) {
  return (
    <IconSvg {...props}>
      <path d="M3 12h4l2.5-7 5 14 2.5-7h4" />
    </IconSvg>
  );
}