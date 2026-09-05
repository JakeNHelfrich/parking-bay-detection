import { describe, expect, it } from 'vitest';
import { resolveDetectWsUrl, sameOriginDetectWsUrl } from './ws-url';

describe('sameOriginDetectWsUrl', () => {
  it('uses wss for an https page', () => {
    expect(
      sameOriginDetectWsUrl({ protocol: 'https:', host: 'app.fly.dev' }),
    ).toBe('wss://app.fly.dev/ws/detect');
  });

  it('uses ws for an http page (localhost dev)', () => {
    expect(
      sameOriginDetectWsUrl({ protocol: 'http:', host: 'localhost:5173' }),
    ).toBe('ws://localhost:5173/ws/detect');
  });

  it('preserves a non-default port', () => {
    expect(
      sameOriginDetectWsUrl({ protocol: 'https:', host: 'example.com:8443' }),
    ).toBe('wss://example.com:8443/ws/detect');
  });
});

describe('resolveDetectWsUrl', () => {
  it('prefers an explicit env override', () => {
    expect(
      resolveDetectWsUrl('ws://localhost:8000/ws/detect', {
        protocol: 'https:',
        host: 'app.fly.dev',
      }),
    ).toBe('ws://localhost:8000/ws/detect');
  });

  it('falls back to same-origin when the env var is missing', () => {
    expect(
      resolveDetectWsUrl(undefined, { protocol: 'https:', host: 'app.fly.dev' }),
    ).toBe('wss://app.fly.dev/ws/detect');
  });

  it('treats an empty-string env var as unset', () => {
    expect(
      resolveDetectWsUrl('', { protocol: 'http:', host: 'localhost:5173' }),
    ).toBe('ws://localhost:5173/ws/detect');
  });

  it('ignores non-string env values', () => {
    expect(
      resolveDetectWsUrl(42, { protocol: 'https:', host: 'app.fly.dev' }),
    ).toBe('wss://app.fly.dev/ws/detect');
  });
});
