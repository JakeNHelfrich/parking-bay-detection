/**
 * Wire-protocol types — the single source of truth for the frontend side.
 * Mirror: `server/app/main.py` module docstring + README "Wire protocol".
 *
 * All bounding boxes are `[x, y, w, h]` normalized to `0..1` with a
 * **top-left** origin. Pixel conversion happens ONLY in the overlay layer.
 */

/** One detected object. `bbox` is [x, y, w, h] in 0..1, origin top-left. */
export interface Detection {
  readonly cls: string;
  readonly conf: number;
  readonly bbox: readonly [number, number, number, number];
}

/** Server reply for one processed frame; echoes the frame's `frameId`. */
export interface DetectionsMessage {
  readonly type: 'detections';
  readonly frameId: number;
  readonly latencyMs: number;
  readonly inferenceMs: number;
  readonly detections: readonly Detection[];
}

/** Server reply for malformed input; the socket stays open afterwards. */
export interface ErrorMessage {
  readonly type: 'error';
  readonly message: string;
}

/** One reported bay transition inside a `bayState` batch (client → server). */
export interface BayStateEvent {
  readonly bayId: number;
  readonly occupied: boolean;
  /** Confidence of the matched truck; present only when `occupied` is true. */
  readonly confidence?: number;
}

/**
 * Client → server: confirmed bay occupancy transitions (see
 * `src/bays/transitions.ts`), batched into one message per frame that
 * produced at least one transition. `frameId` identifies the detections
 * frame that confirmed the transitions. Occupancy math stays frontend-only
 * (invariant 5) — the server records state, it never derives it.
 */
export interface BayStateMessage {
  readonly type: 'bayState';
  readonly frameId: number;
  readonly events: readonly BayStateEvent[];
}

/** Server ack for a `bayState` batch; echoes the batch's `frameId`. */
export interface BayStateAckMessage {
  readonly type: 'bayStateAck';
  readonly frameId: number;
  /** Number of events accepted from the batch. */
  readonly accepted: number;
}

export type ServerMessage = DetectionsMessage | ErrorMessage | BayStateAckMessage;

/** Session hello; the bay-map version is included once bays.json has loaded. */
export function helloMessage(
  captureWidth: number,
  captureHeight: number,
  bayMapVersion?: string,
): string {
  return JSON.stringify(
    bayMapVersion === undefined
      ? { type: 'hello', captureWidth, captureHeight }
      : { type: 'hello', captureWidth, captureHeight, bayMapVersion },
  );
}

/** Per-frame text header sent immediately before each binary JPEG. */
export function frameHeaderMessage(frameId: number): string {
  return JSON.stringify({ type: 'frame', frameId });
}

/** Batched bay-transition report; only called with a non-empty event list. */
export function bayStateMessage(frameId: number, events: readonly BayStateEvent[]): string {
  return JSON.stringify({ type: 'bayState', frameId, events });
}

export function isDetectionsMessage(msg: ServerMessage): msg is DetectionsMessage {
  return msg.type === 'detections';
}

export function isErrorMessage(msg: ServerMessage): msg is ErrorMessage {
  return msg.type === 'error';
}

export function isBayStateAckMessage(msg: ServerMessage): msg is BayStateAckMessage {
  return msg.type === 'bayStateAck';
}

function isValidBbox(value: unknown): value is [number, number, number, number] {
  return (
    Array.isArray(value) &&
    value.length === 4 &&
    value.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1)
  );
}

function parseDetections(raw: Record<string, unknown>): DetectionsMessage | null {
  const { frameId, latencyMs, inferenceMs, detections } = raw;
  if (typeof frameId !== 'number' || !Number.isInteger(frameId) || frameId < 0) return null;
  if (typeof latencyMs !== 'number' || !Number.isFinite(latencyMs)) return null;
  if (typeof inferenceMs !== 'number' || !Number.isFinite(inferenceMs)) return null;
  if (!Array.isArray(detections)) return null;
  const parsed: Detection[] = [];
  for (const item of detections) {
    if (typeof item !== 'object' || item === null) return null;
    const det = item as Record<string, unknown>;
    const { cls, conf, bbox } = det;
    if (typeof cls !== 'string') return null;
    if (typeof conf !== 'number' || !Number.isFinite(conf)) return null;
    if (!isValidBbox(bbox)) return null;
    parsed.push({ cls, conf, bbox });
  }
  return {
    type: 'detections',
    frameId,
    latencyMs,
    inferenceMs,
    detections: parsed,
  };
}

function parseBayStateAck(raw: Record<string, unknown>): BayStateAckMessage | null {
  const { frameId, accepted } = raw;
  if (typeof frameId !== 'number' || !Number.isInteger(frameId) || frameId < 0) return null;
  if (typeof accepted !== 'number' || !Number.isInteger(accepted) || accepted < 0) return null;
  return { type: 'bayStateAck', frameId, accepted };
}

/**
 * Parses an incoming text-frame payload into a validated ServerMessage.
 * Returns null for anything that does not match the protocol — callers must
 * treat null as "ignore this message", never as a fatal error.
 */
export function parseServerMessage(raw: unknown): ServerMessage | null {
  if (typeof raw !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  if (obj.type === 'detections') return parseDetections(obj);
  if (obj.type === 'bayStateAck') return parseBayStateAck(obj);
  if (obj.type === 'error') {
    const { message } = obj;
    if (typeof message !== 'string') return null;
    return { type: 'error', message };
  }
  return null;
}
