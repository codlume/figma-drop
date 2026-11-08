import { describe, expect, it } from 'vite-plus/test';
import {
  actualSize,
  canZoomIn,
  canZoomOut,
  fitScale,
  fitZoom,
  scaleOf,
  zoomIn,
  zoomOut,
} from './imageZoom.ts';

const stage = { width: 800, height: 600 };

describe('fitScale', () => {
  it('fits a tall mobile frame by its height', () => {
    expect(fitScale({ width: 750, height: 1624 }, stage)).toBeCloseTo(600 / 1624);
  });

  it('fits a wide frame by its width', () => {
    expect(fitScale({ width: 2880, height: 1800 }, stage)).toBeCloseTo(800 / 2880);
  });

  it('never enlarges an image smaller than the stage', () => {
    expect(fitScale({ width: 120, height: 80 }, stage)).toBe(1);
  });

  it('falls back to 100% before either size is known', () => {
    expect(fitScale({ width: 0, height: 0 }, stage)).toBe(1);
    expect(fitScale({ width: 750, height: 1624 }, { width: 0, height: 0 })).toBe(1);
  });
});

describe('scaleOf', () => {
  it('uses the fit scale in fit mode and the chosen scale otherwise', () => {
    expect(scaleOf(fitZoom, 0.37)).toBe(0.37);
    expect(scaleOf(actualSize, 0.37)).toBe(1);
  });
});

describe('zoom ladder', () => {
  it('steps from an off-ladder fit to the next level either way', () => {
    const fit = fitScale({ width: 750, height: 1624 }, stage);
    expect(zoomIn(fit)).toBe(0.5);
    expect(zoomOut(fit)).toBe(0.33);
  });

  it('steps strictly past a level it is already on', () => {
    expect(zoomIn(1)).toBe(1.5);
    expect(zoomOut(1)).toBe(0.75);
    expect(zoomIn(0.3333)).toBe(0.5);
  });

  it('clamps at both ends and reports the limit', () => {
    expect(zoomIn(8)).toBe(8);
    expect(canZoomIn(8)).toBe(false);
    expect(canZoomIn(6)).toBe(true);
    expect(zoomOut(0.1)).toBe(0.1);
    expect(canZoomOut(0.1)).toBe(false);
    expect(canZoomOut(0.25)).toBe(true);
  });

  it('never steps the wrong way from beyond the ladder', () => {
    expect(zoomOut(0.05)).toBe(0.05);
    expect(canZoomOut(0.05)).toBe(false);
    expect(zoomIn(0.05)).toBe(0.1);
  });
});
