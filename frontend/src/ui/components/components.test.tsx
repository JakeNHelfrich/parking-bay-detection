/**
 * Primitive renderability tests (acceptance: "primitives renderable in
 * isolation"). Rendered via react-dom/server — no DOM environment needed.
 * These are pure props-in/element-out checks, not visual snapshots.
 */

import { describe, expect, it } from 'vitest';
import { createElement, Fragment } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Button, Card, Pill } from './index';
import { CameraIcon, PulseIcon } from './icons';

describe('Button', () => {
  it('renders a button with its label', () => {
    const html = renderToStaticMarkup(createElement(Button, null, 'Start simulation'));
    expect(html).toContain('<button');
    expect(html).toContain('Start simulation');
  });

  it('defaults to the primary variant and type="button"', () => {
    const html = renderToStaticMarkup(createElement(Button, null, 'Go'));
    expect(html).toContain('type="button"');
    const classAttr = html.match(/class="([^"]*)"/) ?? ['', ''];
    expect(classAttr[1]).toContain('button');
    expect(classAttr[1]).toContain('primary');
  });

  it('applies the ghost variant and forwards extra button props', () => {
    const html = renderToStaticMarkup(
      createElement(Button, { variant: 'ghost', disabled: true, onClick: () => {} }, 'Stop'),
    );
    expect(html).toContain('ghost');
    expect(html).toContain('disabled');
    expect(html).not.toContain('primary');
  });

  it('adds the block modifier when block is set', () => {
    const html = renderToStaticMarkup(createElement(Button, { block: true }, 'Wide'));
    expect(html).toContain('block');
  });
});

describe('Pill', () => {
  it('renders label with role="status"', () => {
    const html = renderToStaticMarkup(createElement(Pill, { tone: 'ok', children: 'Connected' }));
    expect(html).toContain('role="status"');
    expect(html).toContain('Connected');
  });

  it('defaults to neutral tone with a dot', () => {
    const html = renderToStaticMarkup(createElement(Pill, { children: '18 fps' }));
    expect(html).toContain('neutral');
    expect(html).toContain('aria-hidden="true"');
  });

  it('maps tones to their classes', () => {
    for (const tone of ['ok', 'danger', 'neutral'] as const) {
      const html = renderToStaticMarkup(createElement(Pill, { tone, children: 'x' }));
      expect(html).toContain(tone);
    }
  });

  it('can omit the dot', () => {
    const html = renderToStaticMarkup(
      createElement(Pill, { tone: 'ok', dot: false, children: 'Inference healthy' }),
    );
    expect(html).not.toContain('aria-hidden');
  });
});

describe('Card', () => {
  it('renders children in a section', () => {
    const html = renderToStaticMarkup(
      createElement(Card, null, createElement(Fragment, null, 'Bay content')),
    );
    expect(html).toContain('<section');
    expect(html).toContain('Bay content');
  });

  it('renders an optional title heading', () => {
    const html = renderToStaticMarkup(createElement(Card, { title: 'Bay 01' }, 'Body'));
    expect(html).toContain('<h3');
    expect(html).toContain('Bay 01');
  });
});

describe('icons', () => {
  it('render inline SVGs at the requested size, stroked with currentColor', () => {
    for (const Icon of [CameraIcon, PulseIcon]) {
      const html = renderToStaticMarkup(createElement(Icon, { size: 24 }));
      expect(html).toContain('<svg');
      expect(html).toContain('stroke="currentColor"');
      expect(html).toContain('aria-hidden="true"');
      expect(html).toContain('width="24"');
    }
  });
});