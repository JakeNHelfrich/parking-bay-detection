import type { ButtonHTMLAttributes } from 'react';
import styles from './Button.module.css';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Visual variant. Default: 'primary' (dark filled, per mockups). */
  readonly variant?: 'primary' | 'ghost';
  /** Renders as a block-level button that fills its container width. */
  readonly block?: boolean;
}

/**
 * Button primitive — props in, element out. All styling comes from
 * tokens.css via CSS Module; no internal state.
 */
export function Button({
  variant = 'primary',
  block = false,
  className,
  type = 'button',
  ...rest
}: ButtonProps) {
  const variantClass = variant === 'primary' ? styles.primary : styles.ghost;
  return (
    <button
      type={type}
      className={[styles.button, variantClass, block ? styles.block : '', className ?? '']
        .filter(Boolean)
        .join(' ')}
      {...rest}
    />
  );
}