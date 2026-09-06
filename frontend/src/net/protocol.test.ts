import { describe, expect, it } from 'vitest';
import {
  bayStateMessage,
  frameHeaderMessage,
  helloMessage,
  isBaySnapshotMessage,
  isBayStateAckMessage,
  isDetectionsMessage,
  isErrorMessage,
  parseServerMessage,
  type DetectionsMessage,
} from './protocol';

const validDetections: DetectionsMessage = {
  type: 'detections',
  frameId: 412,
  latencyMs: 23.4,
  inferenceMs: 18.1,
  detections: [{ cls: 'truck', conf: 0.91, bbox: [0.12, 0.3, 0.18, 0.11] }],
};

describe('helloMessage / frameHeaderMessage', () => {
  it('serializes the session hello with capture size', () => {
    expect(JSON.parse(helloMessage(960, 540))).toEqual({
      type: 'hello',
      captureWidth: 960,
      captureHeight: 540,
    });
  });

  it('includes the bay-map version in the hello when provided', () => {
    expect(JSON.parse(helloMessage(960, 540, '1a2b3c4d'))).toEqual({
      type: 'hello',
      captureWidth: 960,
      captureHeight: 540,
      bayMapVersion: '1a2b3c4d',
    });
  });

  it('serializes the per-frame header', () => {
    expect(JSON.parse(frameHeaderMessage(412))).toEqual({ type: 'frame', frameId: 412 });
  });

  it('serializes the batched bayState report', () => {
    const events = [
      { bayId: 0, occupied: true, confidence: 0.87 },
      { bayId: 2, occupied: false },
    ];
    expect(JSON.parse(bayStateMessage(412, events))).toEqual({
      type: 'bayState',
      frameId: 412,
      events,
    });
  });
});

describe('parseServerMessage', () => {
  it('parses a valid detections message', () => {
    const raw = JSON.stringify(validDetections);
    const parsed = parseServerMessage(raw);
    expect(parsed).not.toBeNull();
    expect(isDetectionsMessage(parsed!)).toBe(true);
    expect(parsed).toEqual(validDetections);
  });

  it('parses a valid error message', () => {
    const parsed = parseServerMessage(JSON.stringify({ type: 'error', message: 'bad frame' }));
    expect(parsed).not.toBeNull();
    expect(isErrorMessage(parsed!)).toBe(true);
    if (isErrorMessage(parsed!)) expect(parsed.message).toBe('bad frame');
  });

  it('parses a valid bayStateAck message', () => {
    const parsed = parseServerMessage(JSON.stringify({ type: 'bayStateAck', frameId: 412, accepted: 2 }));
    expect(parsed).not.toBeNull();
    expect(isBayStateAckMessage(parsed!)).toBe(true);
    if (isBayStateAckMessage(parsed!)) {
      expect(parsed.frameId).toBe(412);
      expect(parsed.accepted).toBe(2);
    }
  });

  it('rejects bayStateAck with a non-integer frameId or accepted', () => {
    expect(
      parseServerMessage(JSON.stringify({ type: 'bayStateAck', frameId: 1.5, accepted: 1 })),
    ).toBeNull();
    expect(
      parseServerMessage(JSON.stringify({ type: 'bayStateAck', frameId: 1, accepted: -1 })),
    ).toBeNull();
    expect(parseServerMessage(JSON.stringify({ type: 'bayStateAck', frameId: 1 }))).toBeNull();
  });

  it('rejects non-JSON text', () => {
    expect(parseServerMessage('not json')).toBeNull();
  });

  it('rejects non-object JSON', () => {
    expect(parseServerMessage(JSON.stringify([1, 2]))).toBeNull();
  });

  it('rejects unknown message types', () => {
    expect(parseServerMessage(JSON.stringify({ type: 'mystery' }))).toBeNull();
  });

  it('rejects detections with a negative frameId', () => {
    const raw = JSON.stringify({ ...validDetections, frameId: -1 });
    expect(parseServerMessage(raw)).toBeNull();
  });

  it('rejects detections with out-of-range bbox values', () => {
    const raw = JSON.stringify({
      ...validDetections,
      detections: [{ cls: 'truck', conf: 0.9, bbox: [0, 0, 1.2, 0.5] }],
    });
    expect(parseServerMessage(raw)).toBeNull();
  });

  it('rejects detections with non-numeric bbox entries', () => {
    const raw = JSON.stringify({
      ...validDetections,
      detections: [{ cls: 'truck', conf: 0.9, bbox: [0, 'x', 0.5, 0.5] }],
    });
    expect(parseServerMessage(raw)).toBeNull();
  });

  it('rejects error messages with a non-string message', () => {
    expect(parseServerMessage(JSON.stringify({ type: 'error', message: 42 }))).toBeNull();
  });

  describe('baySnapshot (rzo.6)', () => {
    const entry = {
      bayId: 1,
      since: '2026-09-06T08:00:00+00:00',
      dwellSeconds: 305.2,
      confidence: 0.9,
      mapVersion: 'feedface',
    };

    it('parses a valid snapshot with entries', () => {
      const raw = JSON.stringify({ type: 'baySnapshot', serverTime: '2026-09-06T12:00:00Z', bays: [entry] });
      expect(parseServerMessage(raw)).toEqual({
        type: 'baySnapshot',
        serverTime: '2026-09-06T12:00:00Z',
        bays: [entry],
      });
    });

    it('parses an empty snapshot and drops optional confidence', () => {
      const raw = JSON.stringify({
        type: 'baySnapshot',
        serverTime: '2026-09-06T12:00:00Z',
        bays: [{ ...entry, confidence: undefined }],
      });
      const parsed = parseServerMessage(raw);
      expect(parsed).toEqual({
        type: 'baySnapshot',
        serverTime: '2026-09-06T12:00:00Z',
        bays: [{ bayId: 1, since: entry.since, dwellSeconds: 305.2, mapVersion: 'feedface' }],
      });
    });

    it('rejects malformed snapshots', () => {
      const base = { type: 'baySnapshot', serverTime: '2026-09-06T12:00:00Z', bays: [] };
      expect(parseServerMessage(JSON.stringify({ ...base, serverTime: 'not a date' }))).toBeNull();
      expect(parseServerMessage(JSON.stringify({ ...base, bays: 'no' }))).toBeNull();
      expect(
        parseServerMessage(JSON.stringify({ ...base, bays: [{ ...entry, bayId: -1 }] })),
      ).toBeNull();
      expect(
        parseServerMessage(JSON.stringify({ ...base, bays: [{ ...entry, since: 'nope' }] })),
      ).toBeNull();
      expect(
        parseServerMessage(JSON.stringify({ ...base, bays: [{ ...entry, dwellSeconds: -1 }] })),
      ).toBeNull();
      expect(
        parseServerMessage(JSON.stringify({ ...base, bays: [{ ...entry, mapVersion: '' }] })),
      ).toBeNull();
      expect(
        parseServerMessage(JSON.stringify({ ...base, bays: [{ ...entry, confidence: 'high' }] })),
      ).toBeNull();
      expect(parseServerMessage(JSON.stringify({ ...base, bays: ['junk'] }))).toBeNull();
    });

    it('narrows via isBaySnapshotMessage', () => {
      const msg = parseServerMessage(
        JSON.stringify({ type: 'baySnapshot', serverTime: '2026-09-06T12:00:00Z', bays: [] }),
      );
      expect(msg).not.toBeNull();
      if (msg && isBaySnapshotMessage(msg)) {
        expect(msg.serverTime).toBe('2026-09-06T12:00:00Z');
      } else {
        expect.unreachable('snapshot should parse and narrow');
      }
    });
  });

  it('rejects non-string input', () => {
    expect(parseServerMessage(42)).toBeNull();
    expect(parseServerMessage(undefined)).toBeNull();
    expect(parseServerMessage(null)).toBeNull();
  });
});
