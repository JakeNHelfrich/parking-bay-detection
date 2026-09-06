/**
 * HistoryPanel — the occupancy history board (bead rzo.4).
 *
 * One horizontal track per bay for the chosen shift: recorded episodes drawn
 * as proportional segments across the window, plus a per-bay dwell column
 * (episodes count · total occupied time · "open now"). Shift picker offers
 * the two zero-effort presets — current shift and last night — defaulting to
 * the current shift.
 *
 * Stateless, props in / elements out: data is fetched by the shell glue in
 * `App.tsx` (`loadHistoryRows`), geometry/copy derived via the pure helpers
 * in `src/history/timeline-model.ts`. Segment positions are percentages of
 * the queried window (UI layout math only — no detection coordinates here).
 *
 * Pure copy helpers are exported for tests: `shiftButtonCopy`.
 */

import type { ShiftKey } from '../history/shifts';
import type { TimelineSegment } from '../history/timeline-model';
import { bayLabel } from './ParkingBaysPanel';
import { Card } from './components/Card';
import styles from './HistoryPanel.module.css';

/** Picker button copy. Exported for tests. */
export function shiftButtonCopy(key: ShiftKey): string {
  return key === 'current' ? 'Current shift' : 'Last night';
}

export interface HistoryRowView {
  readonly bayId: number;
  readonly segments: readonly TimelineSegment[];
  readonly dwellCopy: string;
}

export interface HistoryPanelProps {
  readonly shiftKey: ShiftKey;
  /** Human range for the resolved window, e.g. "Sep 5, 18:00 → Sep 6, 06:00 UTC". */
  readonly windowRange: string;
  readonly rows: readonly HistoryRowView[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly onShiftChange: (key: ShiftKey) => void;
}

export function HistoryPanel(props: HistoryPanelProps) {
  const { shiftKey, windowRange, rows, loading, error, onShiftChange } = props;
  const quiet = rows.every((row) => row.segments.length === 0);

  return (
    <section className={styles.panel} aria-label="Occupancy history">
      <div className={styles.heading}>
        <h2 className={styles.title}>Occupancy history</h2>
        <span className={styles.range}>{windowRange}</span>
      </div>

      {/* Zero-effort shift picker (rzo.4): two presets, no date wrangling. */}
      <div className={styles.picker} role="group" aria-label="Shift picker">
        {(['current', 'lastNight'] as const).map((key) => (
          <button
            key={key}
            type="button"
            className={`${styles.pickerButton} ${key === shiftKey ? styles.pickerButtonActive : ''}`}
            aria-pressed={key === shiftKey}
            onClick={() => onShiftChange(key)}
          >
            {shiftButtonCopy(key)}
          </button>
        ))}
      </div>

      {error !== null ? <p className={styles.error}>History unavailable · {error}</p> : null}
      {loading && error === null ? (
        <p className={styles.meta} aria-live="polite">
          Loading history…
        </p>
      ) : null}
      {!loading && error === null && quiet ? (
        <p className={styles.meta}>No occupancy recorded in this shift.</p>
      ) : null}

      <div className={styles.rows}>
        {rows.map((row) => (
          <Card key={row.bayId} className={styles.rowCard}>
            <div className={styles.rowHeading}>
              <h3 className={styles.rowTitle}>{bayLabel(row.bayId)}</h3>
              <span className={styles.rowDwell}>{row.dwellCopy}</span>
            </div>
            <div
              className={styles.track}
              role="img"
              aria-label={`${bayLabel(row.bayId)} occupancy timeline`}
            >
              {row.segments.map((segment, index) => (
                <span
                  key={index}
                  className={`${styles.segment} ${segment.open ? styles.segmentOpen : ''}`}
                  style={{ left: `${segment.leftPct}%`, width: `${segment.widthPct}%` }}
                />
              ))}
            </div>
          </Card>
        ))}
      </div>

      <p className={styles.legend}>
        <span className={`${styles.legendSwatch} ${styles.segment}`} aria-hidden="true" /> occupied
        {rows.some((row) => row.segments.some((segment) => segment.open)) ? (
          <>
            {' · '}
            <span className={`${styles.legendSwatch} ${styles.segmentOpen}`} aria-hidden="true" /> open
            now
          </>
        ) : null}
      </p>
    </section>
  );
}
