# UI styles

Design-token architecture extracted from `design/desktop.png`, `design/tablet.png`,
and `design/mobile.png`. All three mockups share a single palette and type scale;
only arrangement changes per breakpoint.

## Files

- `tokens.css` — CSS custom properties on `:root`. **The only file allowed to
  contain raw color / font / spacing / radius / shadow values.**
- `base.css` — minimal reset + document baseline (font, colors) consuming the
  tokens. Loads after `tokens.css`.

Both are imported once, at the top of `src/style.css` (Vite resolves the
`@import`s at build time), so every component sees them via the cascade.

## Convention

1. **Tokens only in `tokens.css`.** Never hardcode a color, font size, spacing,
   radius, or shadow in a component stylesheet.
2. **Components consume via `var()`.** e.g. `color: var(--color-muted);`
   `border-radius: var(--radius-pill);`.
3. **Semantic over raw.** Prefer intent-named tokens (`--color-ok`,
   `--color-viewport`) over palette values; palette-level tokens are only for
   defining other tokens.
4. **New token?** Add it to `tokens.css` with a comment naming the mockup
   element it was sampled from; do not introduce one-off values inline.

## Token map (mockup element → token)

| Mockup element | Token(s) |
| --- | --- |
| Page background (light gray-green) | `--color-page` |
| Cards / header bar surface | `--color-surface` |
| Simulator viewport (dark slate) | `--color-viewport`, `--color-viewport-muted` |
| Headings, titles | `--color-ink`, `--text-title-*` |
| Meta text ("98% confidence", "18 fps") | `--color-muted`, `--text-meta-*` |
| "Live feed connected" pill / "Inference healthy" | `--color-accent-bg`, `--color-accent`, `--color-accent-strong`, `--radius-pill` |
| "Start simulation" button (dark navy) | `--color-btn-dark`, `--radius-button` |
| Bay card border / shadow | `--color-border`, `--border-hairline`, `--shadow-card` |
| Clear / connected status | `--color-ok`, `--color-ok-bg` |
| Occupied / offline status | `--color-danger`, `--color-danger-bg`, `--color-danger-strong` |

Sampled values (from `design/desktop.png`): page `#f5f7f7`, surface `#ffffff`,
viewport `#20343c`, accent dot `#4ea477`, accent text `#336a56`, accent tint
`#ebf5f1`, button navy `#223d4a`, ink `#1f333c`, muted `#6b7f86`, border
`#dee4e7`.