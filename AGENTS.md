# AGENTS.md

Guidance for AI coding agents working in this repository.

## What this project is

A two-service computer-vision demo:

1. **`frontend/`** — Vite + TypeScript + Three.js simulation of a parking lot with trucks. It captures canvas frames and streams them over a WebSocket to the backend, then overlays returned bounding boxes and parking-bay occupancy state on top of the render.
2. **`server/`** — FastAPI + Ultralytics YOLO service. Receives JPEG frames, runs truck detection, returns normalized bounding boxes.

Full architecture, wire protocol, and milestones: see `README.md`.

## Repo layout

```
frontend/     Vite + TS + Three.js sim with a React 18 shell (entry src/main.tsx →
              App.tsx; UI in src/ui, immutable snapshot store in src/state,
              pipeline glue in src/sim; scene, capture, net, overlay, bays)
frontend/public/bays.json   Parking bay definitions (normalized rects, editable without code)
server/       FastAPI app (app/main.py, app/detection.py, app/config.py) + tests/
```

### React UI conventions (frontend)

- **The React UI is the HUD.** The overlay canvas draws only detection boxes + bay rects; connection status lives in the header pill, fps/latency in the sidebar health card. Do not draw text status back onto the canvas.
- **State flows one way**: `src/state/store.ts` holds a single immutable `AppState` snapshot (created at the composition root, not a module singleton); components read it via `useAppState` (`useSyncExternalStore`, `src/state/react.ts`) and act only by dispatching store commands (e.g. `setSimRunning`). The imperative sim loop (`src/sim/bootstrap.ts`) reads `store.getState()` per frame — no subscriptions, no awaits (invariant 2).
- **UI components are stateless, props-in/elements-out.** Derive everything from the store snapshot; extract pure mapping functions (`pillForStatus`, `inferenceHealth`, `bayLabel`, `bayStatusCopy`) as exported, unit-testable functions. Styling is plain-CSS Modules consuming tokens from `src/ui/styles/tokens.css` — no raw values outside tokens.

## Commands

```bash
# Frontend
cd frontend && npm install
npm run dev            # dev server on :5173
npm run build          # type-check + production build (must pass before committing)
npm run check          # tsc --noEmit

# Backend
cd server
source .venv/bin/activate
uvicorn app.main:app --reload --port 8000
pytest                 # run tests
ruff check app tests   # lint
ruff format app tests  # format
```

There is no monorepo task runner; run frontend and backend in separate terminals.

## Non-negotiable invariants

These are architectural contracts. Do not break them without updating `README.md` and `AGENTS.md` together:

1. **Normalized coordinates on the wire.** All bounding boxes in the WebSocket protocol are `[x, y, w, h]` in `0..1`, origin top-left. Never send pixel coordinates from the server, and never let capture resolution leak into overlay or bay-occupancy math. Pixel conversion happens only in the frontend overlay layer.
2. **Decoupled render and inference.** The Three.js render loop must never await or block on detection results. Detections are consumed asynchronously; the overlay always draws the latest available result. Stale results (frameId older than the latest captured frame) are dropped, never queued.
3. **Frame ID echo.** Every response must echo the `frameId` it was given, plus `latencyMs` and `inferenceMs`. Tests should assert this.
4. **Bays are data, not code.** Bay geometry lives in `frontend/public/bays.json` as normalized rects. Changes to bay layout must not require TS changes.
5. **Bays have identity; the model never learns them.** A bay's identity is its stable `id` in the bay map, not anything the detector produces. The CV model only detects *trucks*; bay state is derived purely in the frontend by matching truck bboxes against bay rects (IoU + center-in-rect, greedy one-to-one — see `frontend/src/bays/occupancy.ts`). Never ask the server to classify or segment bays, and never derive bay identity from model output. This keeps bay layout swappable without retraining and occupancy logic testable without a model. (A real-world deployment would add a CV calibration pass that *writes* the bay map; runtime matching would not change.)
6. **Server never touches pixels it doesn't decode.** Frame decoding happens in exactly one place (`server/app/detection.py` or its decode helper). Keep binary-frame handling out of route logic.

## Code conventions

### TypeScript (frontend)

- Strict mode; no `any` — use `unknown` + narrowing or proper types.
- Wire-protocol types live in a single shared module (e.g. `src/net/protocol.ts`) and are the source of truth. Keep them in sync with the server's schemas.
- No state hidden in module-level mutable singletons except the single WebSocket client and the single overlay canvas context.
- Frame capture throttling is a constant, not a magic number inline (target ~10–15 fps capture while rendering at 60).

### Python (server)

- Ruff for lint + format; type hints on all public functions (`mypy`-friendly style, pydantic models for JSON payloads).
- Model is lazy-loaded once at startup (or first request), never per connection. Expose model load failure as a 503 on `/health`, not a crash.
- Keep inference parameters (model name, confidence threshold, allowed classes) in `app/config.py`, overridable via environment variables.
- Tests must not require the real YOLO weights or network; stub the model wrapper.

## Gotchas

- **`toBlob` is async and rate-limited.** Capture must skip frames when a previous capture is still in flight, not queue them.
- **JPEG blob → ArrayBuffer.** Send `ArrayBuffer` over the WS, not base64 — it roughly halves payload size.
- **COCO `truck` (class 7)** is the detection target. `car` overlaps visually for pickups; don't add `car` to the class filter without checking bay-occupancy false positives first.
- **WebSocket lifecycle.** Frontend must reconnect with backoff if the server drops; the sim keeps rendering while disconnected (overlay just freezes/states "offline").
- **Top-left origin.** Canvas and COCO-style pixel boxes both use top-left origin; Three.js uses bottom-left. Convert once, in the capture layer, and document the direction of conversion at the conversion site.
- **bays.json is served from `public/`**, so it is fetched at runtime — remember it is not bundled and can be edited without a rebuild in dev.

## When making changes

- **Protocol changes**: update `frontend/src/net/protocol.ts`, the server schemas, this file, and the README protocol section in the same commit.
- **New detection classes or thresholds**: change `server/app/config.py`, and note the effect on bay occupancy tests.
- **Overlay changes**: remember overlay draws in display-pixel space converted from normalized boxes; test with a resized window.
- **Performance work**: measure via the latency HUD (`latencyMs`, `inferenceMs`) before and after; don't optimize blind.

## Testing expectations

- Server: pytest with a stubbed model covering frame decode → detections payload, frameId echo, malformed frames (must be rejected gracefully, socket stays open).
- Frontend: keep pure logic (IoU/occupancy, throttle, coordinate conversion, stale-frame drop) in testable modules separate from three.js/WebSocket glue; add Vitest tests for those.
- End-to-end smoke: run both services, confirm boxes render and bay states flip when a truck parks. This is manual for now; automate later if flaky.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:6cd5cc61 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->

<!-- BEGIN BEADS CODEX SETUP: generated by bd setup codex -->
## Beads Issue Tracker

Use Beads (`bd`) for durable task tracking in repositories that include it. Use the `beads` skill at `.agents/skills/beads/SKILL.md` (project install) or `~/.agents/skills/beads/SKILL.md` (global install) for Beads workflow guidance, then use the `bd` CLI for issue operations.

### Quick Reference

```bash
bd ready                # Find available work
bd show <id>            # View issue details
bd update <id> --claim  # Claim work
bd close <id>           # Complete work
bd prime                # Refresh Beads context
```

### Rules

- Use `bd` for all task tracking; do not create markdown TODO lists.
- Run `bd prime` when Beads context is missing or stale. Codex 0.129.0+ can load Beads context automatically through native hooks; use `/hooks` to inspect or toggle them.
- Keep persistent project memory in Beads via `bd remember`; do not create ad hoc memory files.

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.
<!-- END BEADS CODEX SETUP -->
