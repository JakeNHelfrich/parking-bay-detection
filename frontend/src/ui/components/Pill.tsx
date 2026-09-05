import styles from './Pill.module.css';

export interface PillProps {
  /** Semantic tone. Default: 'neutral'. */
  readonly tone?: 'ok' | 'danger' | 'neutral';
  /** Small status dot before the label (matches mockup pills). Default: true. */
  readonly dot?: boolean;
  readonly children: string;
  /** Accessible label override if the visible text is ambiguous. */
  readonly ariaLabel?: string;
}

/**
 * Pill / status badge — props in, element out. No state; the tone is
 * data-driven (callers derive it from store state, e.g. connection status).
 */
export function Pill({ tone = 'neutral', dot = true, children, ariaLabel }: PillProps) {
  const toneClass =
    tone === 'ok' ? styles.ok : tone === 'danger' ? styles.danger : styles.neutral;
  return (
    <span
      className={[styles.pill, toneClass].join(' ')}
      role="status"
      aria-label={ariaLabel}
    >
      {dot ? <span className={styles.dot} aria-hidden="true" /> : null}
      {children}
    </span>
  );
}