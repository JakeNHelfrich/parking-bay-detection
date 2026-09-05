/**
 * Static frontend demo configuration.
 *
 * Values here are fixed demo constants (per bead: header UI) — deliberately
 * NOT environment-driven, because they describe what the demo shows, not
 * where it connects. Runtime-overridable settings (backend URL etc.) stay in
 * their own modules.
 */

/** Camera chip label shown in the header (design/desktop.png, "CAM-04"). */
export const CAMERA_ID = 'CAM-04';

/**
 * Inference latency above which the sidebar health card reads "degraded"
 * instead of "healthy", in milliseconds. Measured live baseline is 70-90 ms
 * end-to-end (bead 0ak.2); 200 ms gives ~2x headroom before flagging.
 */
export const INFERENCE_HEALTHY_MAX_MS = 200;