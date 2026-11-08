export type Size = { readonly width: number; readonly height: number };

/** Fit follows the stage as it resizes. A scale stays put. */
export type Zoom = { readonly kind: 'fit' } | { readonly kind: 'scale'; readonly scale: number };

export const fitZoom: Zoom = { kind: 'fit' };
export const actualSize: Zoom = { kind: 'scale', scale: 1 };

const levels = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.5, 2, 3, 4, 6, 8] as const;
const smallest = levels[0];
const largest = levels[levels.length - 1] ?? 1;
// Keeps a scale that is a rounding error away from a level from stepping onto that same level.
const epsilon = 0.001;

/** Fit never enlarges a small image past 100%. */
export function fitScale(natural: Size, stage: Size): number {
  if (natural.width <= 0 || natural.height <= 0 || stage.width <= 0 || stage.height <= 0) return 1;
  return Math.min(1, stage.width / natural.width, stage.height / natural.height);
}

export function scaleOf(zoom: Zoom, fit: number): number {
  return zoom.kind === 'fit' ? fit : zoom.scale;
}

export const canZoomIn = (current: number): boolean => current < largest - epsilon;
export const canZoomOut = (current: number): boolean => current > smallest + epsilon;

export function zoomIn(current: number): number {
  return levels.find((level) => level > current + epsilon) ?? Math.max(current, largest);
}

export function zoomOut(current: number): number {
  return levels.findLast((level) => level < current - epsilon) ?? Math.min(current, smallest);
}
