import { describe, expect, it } from 'vitest';
import {
  frameHeaderMessage,
  helloMessage,
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

  it('serializes the per-frame header', () => {
    expect(JSON.parse(frameHeaderMessage(412))).toEqual({ type: 'frame', frameId: 412 });
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

  it('rejects non-string input', () => {
    expect(parseServerMessage(42)).toBeNull();
    expect(parseServerMessage(undefined)).toBeNull();
    expect(parseServerMessage(null)).toBeNull();
  });
});
