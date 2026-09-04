import { describe, expect, it, vi } from 'vitest';
import { loadBayLayout, parseBayLayout, type BayLayout } from './bay-defs';

const validLayout: BayLayout = {
  version: 1,
  bays: [
    { id: 0, side: 'north', rect: [0.1, 0.2, 0.3, 0.4] },
    { id: 1, side: 'south', rect: [0.5, 0.5, 0.1, 0.1] },
  ],
};

describe('parseBayLayout', () => {
  it('accepts a valid layout', () => {
    expect(parseBayLayout(validLayout)).toEqual(validLayout);
  });

  it('rejects non-object payloads', () => {
    expect(parseBayLayout(null)).toBeNull();
    expect(parseBayLayout('nope')).toBeNull();
    expect(parseBayLayout(42)).toBeNull();
  });

  it('rejects unsupported versions', () => {
    expect(parseBayLayout({ ...validLayout, version: 2 })).toBeNull();
  });

  it('rejects empty or missing bay arrays', () => {
    expect(parseBayLayout({ version: 1, bays: [] })).toBeNull();
    expect(parseBayLayout({ version: 1 })).toBeNull();
  });

  it('rejects duplicate ids', () => {
    const layout = {
      version: 1,
      bays: [
        { id: 0, side: 'north', rect: [0.1, 0.2, 0.3, 0.4] },
        { id: 0, side: 'south', rect: [0.5, 0.5, 0.1, 0.1] },
      ],
    };
    expect(parseBayLayout(layout)).toBeNull();
  });

  it('rejects negative ids', () => {
    const layout = { version: 1, bays: [{ id: -1, side: 'north', rect: [0.1, 0.2, 0.3, 0.4] }] };
    expect(parseBayLayout(layout)).toBeNull();
  });

  it('rejects unknown sides', () => {
    const layout = { version: 1, bays: [{ id: 0, side: 'east', rect: [0.1, 0.2, 0.3, 0.4] }] };
    expect(parseBayLayout(layout)).toBeNull();
  });

  it('rejects out-of-range or malformed rects', () => {
    const bad: Array<unknown> = [
      [0.1, 0.2, 0.3, 1.5], // w > 1
      [0.1, 0.2, 0.3], // too short
      [-0.1, 0.2, 0.3, 0.4], // negative x
      [0.1, 0.2, 'x', 0.4], // non-numeric
      [0.1, 0.2, Number.NaN, 0.4],
    ];
    for (const rect of bad) {
      const layout = { version: 1, bays: [{ id: 0, side: 'north', rect }] };
      expect(parseBayLayout(layout)).toBeNull();
    }
  });

  it('rejects non-array bay entries', () => {
    expect(parseBayLayout({ version: 1, bays: 'all of them' })).toBeNull();
    expect(parseBayLayout({ version: 1, bays: [null] })).toBeNull();
  });
});

describe('loadBayLayout', () => {
  it('resolves parsed layout on a successful fetch', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => validLayout })),
    );
    expect(await loadBayLayout()).toEqual(validLayout);
    vi.unstubAllGlobals();
  });

  it('resolves null on fetch failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
    expect(await loadBayLayout()).toBeNull();
    vi.unstubAllGlobals();
  });

  it('resolves null on invalid JSON shape', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ version: 99 }) })),
    );
    expect(await loadBayLayout()).toBeNull();
    vi.unstubAllGlobals();
  });
});
