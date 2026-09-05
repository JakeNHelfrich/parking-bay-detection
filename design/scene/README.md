# Depot yard scene — visual reference

Approved target for epic **`parking-bay-detection-xbw`** (depot yard scene overhaul).
The mockup below is the reference the implementation must match — run it side by side with
your work in progress.

## The reference is the mockup itself

`depot-mockup.html` is a standalone page (three.js from CDN, no build step) that renders the
approved scene. Open it and look at it — it is the acceptance criterion:

```sh
open design/scene/depot-mockup.html
```

Live copy, same file: https://claude.ai/code/artifact/34d7b302-bcb4-49ca-8d11-c97cb5e78259

Query params for isolating parts of the scene:

| Param | Values | Use |
| --- | --- | --- |
| `view` | `hero` (default), `truck`, `bays`, `yard` | Camera preset — `truck` for the model, `bays` for the paint |
| `overlay` | `1` (default), `0` | Detection overlay off to judge geometry and lighting |
| `fill` | `0`–`4` | Trucks parked on load |
| `play` | `1` (default), `0` | Freeze the animation |
| `bare` | flag | Hide the page chrome, viewport only |
| `layout` / `truck` / `scene` | see switcher | The rejected options, kept for comparison |

Example: `depot-mockup.html?bare&overlay=0&view=truck&fill=4&play=0`

## Use the mockup source, don't re-derive the geometry

`depot-mockup.html` is a standalone page (three.js from CDN, no build) containing working
implementations of everything the epic asks for:

- `layoutSpec()` / `baySlots()` → the bay layout for `src/scene/layout.ts`
- `buildRigid()` / `cabAssembly()` / `wheelSet()` → the model for `src/scene/truck.ts`
- `buildScenery()` → warehouse, kerb, masts, fence, hedge, treeline, hills for `src/scene/bays.ts`
- `buildSky()` + the light rig in `buildWorld()` → atmosphere for `src/scene/world.ts`
- `frameCamera()` → the approved camera framing

Port these into the real modules with the project's TypeScript conventions (strict, no `any`,
typed exports, shared geometries/materials). The mockup is plain ES5-ish JS with `var` and no
types — that style must **not** be copied, only the geometry and the numbers.

Open it directly in a browser (`open design/scene/depot-mockup.html`) to compare against your
work in progress. Query params: `?bare` (chrome-free), `?overlay=0`, `?view=hero|truck|bays|yard`,
`?fill=0..4` (parked trucks), `?play=0`, plus `?layout=`, `?truck=`, `?scene=` for the other options.

## The approved combination

Layout **far side · 4 bays** + vehicle **rigid** + scenery **depot**. The other options in the
mockup's switcher (8 bays, semi, dusk, today's scenery) were considered and not chosen — they stay
in the file only for comparison.

## Camera

Kept at fov 55 with the fixed 16:9 projection (`TARGET_ASPECT` — capture, `bays.json` and the stub
detector constants all assume it).

```
camera.position ≈ (0.9, 17.4, 33.9)
camera.lookAt(0, 2.0, -7)
```

Equivalent orbit form used in the mockup: `theta 0.02, phi 0.34, radius 36` about `(0, 2.0, -7)`.

> Moving the camera invalidates `frontend/public/bays.json`. Stale rects do not throw — they
> silently mis-score occupancy. Regenerate them in the same commit (`parking-bay-detection-xbw.6`).

## Key dimensions

| Constant | Value | Note |
| --- | --- | --- |
| `BAY_COUNT` | 4 | North (far) side only |
| `BAY_WIDTH` | 3.4 | Along X |
| `BAY_GAP` | 1.2 | Between bays |
| `BAY_DEPTH` | 8.4 | Fits the 7.2 m rigid truck with clearance |
| `LANE_WIDTH` | 8 | |
| Bay centre z | -8.2 | `-(LANE_WIDTH/2 + BAY_DEPTH/2)` |
| Truck length / width | 7.2 / 2.5 | `TRUCK_DIMENSIONS` |

## Still open

The camera framing in the mockup is still being tuned against the approved reference — treat
`frameCamera()` as the current best guess, not a frozen number, and confirm the default view
before regenerating `bays.json` off it.
