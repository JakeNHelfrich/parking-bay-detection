/**
 * AlertsPanel — the in-app notification area (bead rzo.5).
 *
 * Read-only over the store's `alerts` snapshot (published by the polling glue
 * in `sim/alert-polling.ts`); acknowledgement dispatches through the provided
 * callback — components stay stateless, props in / elements out. The panel
 * renders only when there is news (unacknowledged alerts or a fetch error):
 * a notification area that is invisible when quiet.
 *
 * Pure copy helpers are exported for tests: `alertTitleCopy`, `alertDetailCopy`,
 * `alertAgeCopy`, `alertTone`.
 */

import type { AlertSummary } from '../net/alerts-api';
import { Card } from './components/Card';
import { bayLabel } from './ParkingBaysPanel';
import styles from './AlertsPanel.module.css';

/** Rule → display name (unknown rules fall back to the raw rule id). */
const RULE_NAMES: Record<string, string> = {
  overstay: 'Overstay',
  afterHours: 'After hours',
};

/** Card accent tone: alerts are always warnings (red) today. */
export function alertTone(_alert: AlertSummary): 'danger' {
  return 'danger';
}

/** One-line title: "Bay 03 · Overstay". */
export function alertTitleCopy(alert: AlertSummary): string {
  const rule = RULE_NAMES[alert.rule] ?? alert.rule;
  return `${bayLabel(alert.bayId)} · ${rule}`;
}

/** Human copy for the rule-specific detail, tolerant of unknown shapes. */
export function alertDetailCopy(alert: AlertSummary): string {
  const detail = alert.detail;
  if (alert.rule === 'overstay') {
    const elapsed = typeof detail.elapsedMinutes === 'number' ? detail.elapsedMinutes : null;
    const dwell = typeof detail.dwellMinutes === 'number' ? detail.dwellMinutes : null;
    const state = detail.stillOpen === false ? 'Was occupied' : 'Occupied';
    if (elapsed !== null && dwell !== null) {
      return `${state} ${formatDuration(elapsed)} · window ${formatDuration(dwell)}`;
    }
  }
  if (alert.rule === 'afterHours') {
    const hours = detail.activeHours;
    if (
      typeof hours === 'object' &&
      hours !== null &&
      typeof (hours as Record<string, unknown>).startHour === 'number' &&
      typeof (hours as Record<string, unknown>).endHour === 'number'
    ) {
      const { startHour, endHour } = hours as { startHour: number; endHour: number };
      return `Opened outside yard hours (${pad(startHour)}:00–${pad(endHour)}:00 UTC)`;
    }
    return 'Opened outside yard hours';
  }
  return 'Rule triggered';
}

/** Coarse age copy for the raised-at stamp: "just now" … "3d ago". */
export function alertAgeCopy(raisedAt: string, now: Date): string {
  const raised = new Date(raisedAt);
  const elapsedMs = Math.max(0, now.getTime() - raised.getTime());
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function pad(hour: number): string {
  return String(hour).padStart(2, '0');
}

function formatDuration(minutes: number): string {
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = minutes / 60;
  return `${hours % 1 === 0 ? hours : hours.toFixed(1)}h`;
}

export interface AlertsPanelProps {
  readonly alerts: readonly AlertSummary[];
  readonly error: string | null;
  readonly now: Date;
  readonly onAcknowledge: (id: number) => void;
}

export function AlertsPanel(props: AlertsPanelProps) {
  const { alerts, error, now, onAcknowledge } = props;
  if (alerts.length === 0 && error === null) return null;

  return (
    <section className={styles.panel} aria-label="Alerts">
      <div className={styles.heading}>
        <h2 className={styles.title}>Alerts</h2>
        {alerts.length > 0 ? (
          <span className={styles.count} aria-label={`${alerts.length} unacknowledged alerts`}>
            {alerts.length}
          </span>
        ) : null}
      </div>
      {error !== null ? <p className={styles.error}>Alerts unavailable · {error}</p> : null}
      <div className={styles.list}>
        {alerts.map((alert) => (
          <Card key={alert.id} className={`${styles.alertCard} ${styles.alertCardDanger}`}>
            <div className={styles.alertRow}>
              <div className={styles.alertCopy}>
                <h3 className={styles.alertTitle}>{alertTitleCopy(alert)}</h3>
                <p className={styles.alertDetail}>{alertDetailCopy(alert)}</p>
                <p className={styles.alertAge}>{alertAgeCopy(alert.raisedAt, now)}</p>
              </div>
              <button
                type="button"
                className={styles.ack}
                onClick={() => onAcknowledge(alert.id)}
                aria-label={`Acknowledge alert for ${bayLabel(alert.bayId)}`}
              >
                Dismiss
              </button>
            </div>
          </Card>
        ))}
      </div>
    </section>
  );
}
