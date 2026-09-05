import type { HTMLAttributes } from 'react';
import styles from './Card.module.css';

export interface CardProps extends HTMLAttributes<HTMLElement> {
  /** Optional card title, rendered per the mockup ("Bay 01") style. */
  readonly title?: string;
}

/**
 * Card primitive — a raised white surface. Props in, element out; content
 * composition is the caller's job (no slots, no hidden state).
 */
export function Card({ title, className, children, ...rest }: CardProps) {
  return (
    <section className={[styles.card, className ?? ''].filter(Boolean).join(' ')} {...rest}>
      {title !== undefined ? <h3 className={styles.title}>{title}</h3> : null}
      {children}
    </section>
  );
}