/**
 * HistoryPanel tests (bead rzo.4). Rendered via react-dom/server against
 * props — the panel is stateless, so no store or DOM environment needed.
 *
 * Covers the shift picker (aria-pressed states), per-bay rows (label, dwell
 * copy, proportional segment geometry), error/loading/empty states, and the
 * legend.
 */

import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { TimelineSegment } from '../history/timeline-model';
import { HistoryPanel, shiftButtonCopy, type HistoryRowView } from './HistoryPanel';

function segment(overrides: Partial<TimelineSegment> = {}): TimelineSegment {
  return { leftPct: 10, widthPct: 20, open: false, confidence: 0.9, ...overrides };
}

function row(overrides: Partial<HistoryRowView> = {}): HistoryRowView {
  return { bayId: 0, segments: [segment()], dwellCopy: '1 episode · 2h', ...overrides };
}

function render(props: Partial<Parameters<typeof HistoryPanel>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(HistoryPanel, {
      shiftKey: 'current',
      windowRange: 'Sep 6, 06:00 → Sep 6, 12:00 UTC',
      rows: [row()],
      loading: false,
      error: null,
      onShiftChange: () => {},
      ...props,
    }),
  );
}

describe('shiftButtonCopy', () => {
  it('names the two zero-effort presets', () => {
    expect(shiftButtonCopy('current')).toBe('Current shift');
    expect(shiftButtonCopy('lastNight')).toBe('Last night');
  });
});

describe('HistoryPanel', () => {
  it('renders the heading, window range, and picker with pressed states', () => {
    const html = render();
    expect(html).toContain('Occupancy history');
    expect(html).toContain('Sep 6, 06:00 → Sep 6, 12:00 UTC');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('Current shift');
    expect(html).toContain('Last night');
  });

  it('renders per-bay rows with dwell copy and proportional segments', () => {
    const html = render({ rows: [row(), row({ bayId: 2, segments: [], dwellCopy: 'No episodes' })] });
    expect(html).toContain('Bay 01');
    expect(html).toContain('Bay 03');
    expect(html).toContain('1 episode · 2h');
    expect(html).toContain('No episodes');
    expect(html).toContain('left:10%');
    expect(html).toContain('width:20%');
    expect(html).toContain('Bay 01 occupancy timeline'); // track aria-label
  });

  it('marks open segments and shows the open legend only when one exists', () => {
    // Legend swatches: one (occupied) normally, two when an open episode exists.
    const countSwatches = (html: string) => (html.match(/legendSwatch/g) ?? []).length;
    expect(countSwatches(render({ rows: [row({ segments: [segment({ open: true })] })] }))).toBe(2);
    expect(countSwatches(render())).toBe(1);
  });

  it('renders the error banner instead of rows content when fetch fails', () => {
    const html = render({ error: 'history fetch failed: 503' });
    expect(html).toContain('History unavailable · history fetch failed: 503');
    expect(html).not.toContain('Loading history');
  });

  it('renders a loading note while fetching', () => {
    const html = render({ loading: true });
    expect(html).toContain('Loading history…');
  });

  it('renders the empty state when no bay recorded anything in the shift', () => {
    const html = render({ rows: [row({ segments: [] })] });
    expect(html).toContain('No occupancy recorded in this shift.');
  });
});
