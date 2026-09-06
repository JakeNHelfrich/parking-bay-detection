/**
 * Alerts REST client tests (bead rzo.5) — URL resolution, narrowing guards,
 * and fetch wrappers against a stubbed `fetch` (no network in tests).
 */

import { describe, expect, it, vi } from 'vitest';
import {
  createAlertsClient,
  isAlertSummary,
  isAlertsResponse,
  resolveAlertsApiBase,
  sameOriginAlertsApiBase,
} from './alerts-api';

const alert = {
  id: 1,
  bayId: 0,
  rule: 'overstay',
  since: '2026-09-06T08:00:00+00:00',
  raisedAt: '2026-09-06T12:00:00+00:00',
  acknowledged: false,
  detail: { dwellMinutes: 240 },
};

describe('URL resolution', () => {
  it('derives same-origin https base', () => {
    expect(sameOriginAlertsApiBase({ protocol: 'https:', host: 'yard.example' })).toBe(
      'https://yard.example/api/alerts',
    );
    expect(sameOriginAlertsApiBase({ protocol: 'http:', host: 'localhost:5173' })).toBe(
      'http://localhost:5173/api/alerts',
    );
  });

  it('prefers the env override, falls back to same-origin', () => {
    const loc = { protocol: 'https:', host: 'yard.example' };
    expect(resolveAlertsApiBase('http://localhost:8000/api/alerts', loc)).toBe(
      'http://localhost:8000/api/alerts',
    );
    expect(resolveAlertsApiBase(undefined, loc)).toBe('https://yard.example/api/alerts');
    expect(resolveAlertsApiBase('', loc)).toBe('https://yard.example/api/alerts');
    expect(resolveAlertsApiBase(42, loc)).toBe('https://yard.example/api/alerts');
  });
});

describe('guards', () => {
  it('accepts a well-formed alert', () => {
    expect(isAlertSummary(alert)).toBe(true);
  });

  it('rejects malformed alerts', () => {
    expect(isAlertSummary(null)).toBe(false);
    expect(isAlertSummary({})).toBe(false);
    expect(isAlertSummary({ ...alert, id: 'x' })).toBe(false);
    expect(isAlertSummary({ ...alert, detail: null })).toBe(false);
    expect(isAlertsResponse({ alerts: [alert] })).toBe(true);
    expect(isAlertsResponse({ alerts: ['nope'] })).toBe(false);
    expect(isAlertsResponse({})).toBe(false);
  });
});

describe('createAlertsClient', () => {
  it('fetchUnacknowledged returns validated alerts', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ alerts: [alert] }), { status: 200 }),
    );
    const client = createAlertsClient('http://x/api/alerts', fetchImpl as unknown as typeof fetch);
    await expect(client.fetchUnacknowledged()).resolves.toEqual([alert]);
    expect(fetchImpl).toHaveBeenCalledWith('http://x/api/alerts?unacknowledged=true', {
      headers: { Accept: 'application/json' },
    });
  });

  it('fetchUnacknowledged throws on HTTP failure', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('nope', { status: 503 }));
    const client = createAlertsClient('http://x/api/alerts', fetchImpl as unknown as typeof fetch);
    await expect(client.fetchUnacknowledged()).rejects.toThrow('503');
  });

  it('fetchUnacknowledged throws on an invalid payload', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ alerts: [{ nonsense: true }] }), { status: 200 }),
    );
    const client = createAlertsClient('http://x/api/alerts', fetchImpl as unknown as typeof fetch);
    await expect(client.fetchUnacknowledged()).rejects.toThrow('validation');
  });

  it('acknowledge POSTs and throws on unknown id (404)', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('{"id":1,"acknowledged":true}', { status: 200 }))
      .mockResolvedValueOnce(new Response('missing', { status: 404 }));
    const client = createAlertsClient('http://x/api/alerts', fetchImpl as unknown as typeof fetch);
    await expect(client.acknowledge(1)).resolves.toBeUndefined();
    await expect(client.acknowledge(2)).rejects.toThrow('404');
  });
});
