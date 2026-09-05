import { describe, expect, it } from 'vitest';
import { bayLabelTexts, labelBudget, overlayFont } from './overlay';

describe('bayLabelTexts', () => {
  it('pads the bay number to two digits (matches the painted bay numbers)', () => {
    expect(bayLabelTexts(0, false).full).toBe('01 CLEAR');
    expect(bayLabelTexts(3, false).full).toBe('04 CLEAR');
  });

  it('uses compact status words', () => {
    expect(bayLabelTexts(0, true).full).toBe('01 OCC');
    expect(bayLabelTexts(2, true).full).toBe('03 OCC');
  });

  it('short form is the number only', () => {
    expect(bayLabelTexts(1, false).short).toBe('02');
    expect(bayLabelTexts(1, true).short).toBe('02');
  });
});

describe('labelBudget', () => {
  it('returns the distance to the nearest neighbouring centre', () => {
    // Head-on default viewport: bays.json rects ~0.045-0.054 wide at ~0.05
    // pitch; in a 960 px viewport that is ~48 px quads on ~50 px centres.
    const centers = [100, 148, 196, 244];
    expect(labelBudget(centers, 0)).toBe(48);
    expect(labelBudget(centers, 1)).toBe(48);
    expect(labelBudget(centers, 2)).toBe(48);
    expect(labelBudget(centers, 3)).toBe(48);
  });

  it('uses the smaller side for uneven spacing', () => {
    const centers = [0, 60, 180];
    expect(labelBudget(centers, 1)).toBe(60);
    expect(labelBudget(centers, 2)).toBe(120);
  });

  it('is infinite for a single bay (no neighbour to collide with)', () => {
    expect(labelBudget([42], 0)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('overlayFont', () => {
  it('scales with the viewport and never drops below 9 px', () => {
    expect(overlayFont(960)).toBe('600 11px ui-monospace, SFMono-Regular, Menlo, monospace');
    expect(overlayFont(1920)).toBe('600 22px ui-monospace, SFMono-Regular, Menlo, monospace');
    expect(overlayFont(320)).toBe('600 9px ui-monospace, SFMono-Regular, Menlo, monospace');
  });
});
