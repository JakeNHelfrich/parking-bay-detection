/**
 * History REST client tests (bead rzo.4): base-URL resolution, narrowing
 * guards, and fetch behavior via a stubbed `fetch` (URL building, `+`-safe
 * query encoding, non-2xx and invalid-payload errors).
 */

import { describe, expect, it, vi } from 'vitest';
import {
  createHistoryClient,
  isBayDwellSummary,
  isBayTimelineResponse,
  isDwellResponse,
  isHistoryInterval,
  isOpenEpisode,
  resolveHistoryApiBase,
  sameOriginHistoryApiBase,
  type BayTimelineResponse,
} from './history-api';

const LOC = { protocol: 'https:', host: 'yard.example' };

describe('base-URL resolution', () => {
  it('prefers the explicit env override', () => {
    expect(resolveHistoryApiBase('http://localhost:8000/api/history', LOC)).toBe(
      'http://localhost:8000/api/history',
    );
  });

  it('falls back to same-origin when no override is set', () => {
    expect(resolveHistoryApiBase(undefined, LOC)).toBe('https://yard.example/api/history');
    expect(resolveHistoryApiBase('', LOC)).toBe(sameOriginHistoryApiBase(LOC));
  });
});

const validInterval = {
  id: 7,
  bayId: 2,
  mapVersion: 'feedface',
  since: '2026-09-06T08:00:00+00:00',
  until: '2026-09-06T10:00:00+00:00',
  open: false,
  durationSeconds: 7200,
  confidence: 0.9,
  openFrameId: 10,
  closeFrameId: 20,
};

describe('guards', () => {
  it('accepts a valid interval and timeline response', () => {
    expect(isHistoryInterval(validInterval)).toBe(true);
    const response = { bayId: 2, from: 'x', to: 'y', intervals: [validInterval] };
    expect(isBayTimelineResponse(response)).toBe(true);
  });

  it('accepts open intervals with null until/closeFrameId/confidence variants', () => {
    expect(
      isHistoryInterval({
        ...validInterval,
        until: null,
        open: true,
        confidence: null,
        closeFrameId: null,
      }),
    ).toBe(true);
  });

  it.each([
    ['non-object', 'nope'],
    ['missing field', { ...validInterval, durationSeconds: undefined }],
    ['wrong until type', { ...validInterval, until: 5 }],
    ['wrong open type', { ...validInterval, open: 'yes' }],
    ['wrong confidence type', { ...validInterval, confidence: 'high' }],
    ['wrong mapVersion type', { ...validInterval, mapVersion: 9 }],
  ])('rejects an interval with %s', (_label, value) => {
    expect(isHistoryInterval(value)).toBe(false);
  });

  it('rejects malformed timeline/dwell envelopes', () => {
    expect(isBayTimelineResponse({ ...validInterval })).toBe(false);
    expect(isBayTimelineResponse({ bayId: 1, from: 'x', to: 'y', intervals: 'no' })).toBe(false);
    expect(isBayTimelineResponse({ bayId: 1, from: 'x', to: 'y', intervals: [{}] })).toBe(false);
    expect(isDwellResponse({ from: 'x', bays: [] })).toBe(false);
    expect(isDwellResponse({ from: 'x', to: 'y', bays: 'no' })).toBe(false);
    expect(isBayDwellSummary({ bayId: 1, episodes: 'many' })).toBe(false);
    expect(isBayDwellSummary({ bayId: 1, episodes: 1, open: 'now' })).toBe(false);
    expect(isOpenEpisode({ since: 'x', durationSeconds: 'long' })).toBe(false);
  });
});

/** Fetch stub capturing request URLs, returning canned JSON. */
function stubFetch(status: number, payload: unknown) {
  const urls: string[] = [];
  const impl = vi.fn(async (input: string | URL | Request) => {
    urls.push(String(input));
    return new Response(status === 200 ? JSON.stringify(payload) : 'nope', { status });
  });
  return { impl, urls };
}

const timelinePayload: BayTimelineResponse = {
  bayId: 2,
  from: '2026-09-06T06:00:00+00:00',
  to: '2026-09-06T18:00:00+00:00',
  intervals: [validInterval],
};

describe('createHistoryClient', () => {
  const FROM = '2026-09-06T06:00:00+00:00';
  const TO = '2026-09-06T18:00:00+00:00';

  it('fetches a bay timeline with a `+`-safe encoded window query', async () => {
    const stub = stubFetch(200, timelinePayload);
    const client = createHistoryClient('https://yard.example/api/history', stub.impl);
    const payload = await client.fetchTimeline(2, FROM, TO);
    expect(payload).toEqual(timelinePayload);
    expect(stub.urls[0]).toBe(
      'https://yard.example/api/history/timeline/2?from=2026-09-06T06%3A00%3A00%2B00%3A00&to=2026-09-06T18%3A00%3A00%2B00%3A00',
    );
  });

  it('fetches dwell summaries', async () => {
    const stub = stubFetch(200, { from: FROM, to: TO, bays: [] });
    const client = createHistoryClient('https://yard.example/api/history', stub.impl);
    await expect(client.fetchDwell(FROM, TO)).resolves.toEqual({ from: FROM, to: TO, bays: [] });
    expect(stub.urls[0]).toBe('https://yard.example/api/history/dwell?from=2026-09-06T06%3A00%3A00%2B00%3A00&to=2026-09-06T18%3A00%3A00%2B00%3A00');
  });

  it('throws on non-2xx responses', async () => {
    const client = createHistoryClient('https://yard.example/api/history', stubFetch(503, null).impl);
    await expect(client.fetchTimeline(0, FROM, TO)).rejects.toThrow('history fetch failed: 503');
    await expect(client.fetchDwell(FROM, TO)).rejects.toThrow('history fetch failed: 503');
  });

  it('throws when a payload fails validation', async () => {
    const client = createHistoryClient(
      'https://yard.example/api/history',
      stubFetch(200, { bayId: 'two' }).impl,
    );
    await expect(client.fetchTimeline(2, FROM, TO)).rejects.toThrow(
      'history payload failed validation',
    );
  });
});
