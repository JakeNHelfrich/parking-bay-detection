/**
 * UI component primitives & conventions (bead: component system).
 *
 * Conventions (AGENTS.md + src/ui/styles/README.md):
 * - Function components only: **props in / element out**. No hooks that own
 *   state inside these primitives; UI derives everything from props/store.
 * - Styling exclusively via CSS Modules consuming `src/ui/styles/tokens.css`
 *   (the only file with raw values). No CSS-in-JS, no UI framework deps.
 * - Wire-protocol types come only from `src/net/protocol.ts`; components
 *   never import from `src/net/`, `src/capture/`, or `src/scene/`.
 */

export { Button, type ButtonProps } from './Button';
export { Pill, type PillProps } from './Pill';
export { Card, type CardProps } from './Card';
export { CameraIcon, PulseIcon, type IconProps } from './icons';