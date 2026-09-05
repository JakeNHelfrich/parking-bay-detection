import {
  frameHeaderMessage,
  helloMessage,
  parseServerMessage,
  type ServerMessage,
} from './protocol';
import { reconnectDelayMs } from './backoff';

/** Connection lifecycle surfaced to the overlay HUD. */
export type ConnectionStatus = 'connecting' | 'online' | 'offline';

export interface DetectClientOptions {
  /** WebSocket URL of the detection service (e.g. ws://localhost:8000/ws/detect). */
  readonly url: string;
  readonly captureWidth: number;
  readonly captureHeight: number;
  /** Called for every validated server message. Must never throw. */
  readonly onMessage: (message: ServerMessage) => void;
  /** Called whenever the connection status changes. */
  readonly onStatus: (status: ConnectionStatus) => void;
}

/**
 * The single WebSocket client. Owns the connect/reconnect lifecycle and the
 * send path for captured frames. The render loop never awaits this class —
 * `sendFrame` is fire-and-forget and returns false (frame dropped, NOT
 * queued) whenever the socket is not open.
 */
export class DetectClient {
  private readonly options: DetectClientOptions;
  private socket: WebSocket | null = null;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByUser = false;
  /** frameId of the last sent frame whose reply has not arrived yet. */
  private pendingFrameId: number | null = null;

  constructor(options: DetectClientOptions) {
    this.options = options;
  }

  /** Opens the socket and schedules automatic reconnects with backoff. */
  connect(): void {
    this.closedByUser = false;
    this.openSocket();
  }

  /** Closes the socket and stops reconnecting. */
  close(): void {
    this.closedByUser = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.close();
    this.socket = null;
  }

  /**
   * True while a sent frame awaits its server reply (detections OR error).
   * The capture loop reads this to pace itself: at most one frame in flight,
   * so the send rate converges to the server's real throughput instead of
   * overrunning a slow backend with frames it will only coalesce away.
   */
  get awaitingReply(): boolean {
    return this.pendingFrameId !== null;
  }

  /**
   * Sends one frame (text header + binary JPEG). Returns false when the
   * socket is not open — the frame is dropped, never buffered.
   */
  sendFrame(frameId: number, jpegData: ArrayBuffer): boolean {
    const socket = this.socket;
    if (socket === null || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(frameHeaderMessage(frameId));
    socket.send(jpegData);
    this.pendingFrameId = frameId;
    return true;
  }

  private openSocket(): void {
    this.options.onStatus('connecting');
    const socket = new WebSocket(this.options.url);
    socket.binaryType = 'arraybuffer'; // JPEG frames go over the wire as binary, not base64.
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.attempt = 0; // successful connect resets the backoff sequence
      this.options.onStatus('online');
      socket.send(helloMessage(this.options.captureWidth, this.options.captureHeight));
    });

    socket.addEventListener('message', (event: MessageEvent) => {
      // Binary data never arrives server→client; only JSON text is expected.
      const parsed = parseServerMessage(event.data);
      if (parsed !== null) {
        // Any server message (detections or error) settles the pending frame —
        // the server replies to every frame it processes and skips only
        // frames superseded by a newer one, which cannot be the pending one.
        this.pendingFrameId = null;
        this.options.onMessage(parsed);
      }
    });

    const scheduleReconnect = (): void => {
      this.socket = null;
      // A dropped socket can never deliver the pending reply; clear it so
      // capture resumes once reconnected instead of stalling forever.
      this.pendingFrameId = null;
      this.options.onStatus('offline');
      if (this.closedByUser) return;
      const delay = reconnectDelayMs(this.attempt);
      this.attempt += 1;
      this.reconnectTimer = setTimeout(() => this.openSocket(), delay);
    };

    socket.addEventListener('close', scheduleReconnect);
    socket.addEventListener('error', () => {
      // 'close' always follows 'error'; nothing to do here beyond logging.
      console.warn(`[detect-client] connection error to ${this.options.url}`);
    });
  }
}
