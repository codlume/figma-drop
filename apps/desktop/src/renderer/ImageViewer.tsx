import * as stylex from '@stylexjs/stylex';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { CloseIcon, MinusIcon, PlusIcon } from './Icons.tsx';
import {
  actualSize,
  canZoomIn,
  canZoomOut,
  fitScale,
  fitZoom,
  scaleOf,
  type Size,
  type Zoom,
  zoomIn,
  zoomOut,
} from './imageZoom.ts';
import { UntrustedImage } from './PreviewImage.tsx';
import { color, font, motion, radius, space } from './tokens.stylex.ts';
import { Button, Truncate, shared } from './ui.tsx';

type Drag = {
  readonly pointerId: number;
  readonly x: number;
  readonly y: number;
  readonly left: number;
  readonly top: number;
};

type Point = { readonly x: number; readonly y: number };

type Load =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly natural: Size }
  | { readonly kind: 'failed' };

const appear = stylex.keyframes({ from: { opacity: 0 }, to: { opacity: 1 } });

const styles = stylex.create({
  dialog: {
    '::backdrop': { backgroundColor: 'rgb(0 0 0 / 45%)' },
    animationDuration: motion.durationFast,
    animationName: { default: appear, '@media (prefers-reduced-motion: reduce)': 'none' },
    animationTimingFunction: motion.easing,
    backgroundColor: color.surfaceRaised,
    borderColor: color.border,
    borderRadius: radius.lg,
    borderStyle: 'solid',
    borderWidth: '1px',
    boxShadow: '0 12px 32px rgb(0 0 0 / 24%)',
    boxSizing: 'border-box',
    color: color.text,
    height: 'auto',
    inset: { default: space.xxl, '@media (max-width: 960px)': space.xl },
    margin: 0,
    maxHeight: 'none',
    maxWidth: 'none',
    overflow: 'hidden',
    // Children cover the whole box, so a click that lands on the dialog itself is on the backdrop.
    padding: 0,
    width: 'auto',
  },
  panel: { display: 'flex', flexDirection: 'column', height: '100%' },
  header: {
    alignItems: 'center',
    borderBottomColor: color.border,
    borderBottomStyle: 'solid',
    borderBottomWidth: '1px',
    columnGap: space.md,
    display: 'flex',
    flexShrink: 0,
    paddingBlock: space.sm,
    paddingInline: space.md,
  },
  title: {
    flexGrow: 1,
    fontSize: font.sizeLg,
    fontWeight: font.weightBold,
    margin: 0,
    minWidth: 0,
  },
  toolbar: { alignItems: 'center', columnGap: space.xs, display: 'flex', flexShrink: 0 },
  readout: {
    color: color.textMuted,
    fontSize: font.sizeSm,
    fontVariantNumeric: 'tabular-nums',
    minWidth: '44px',
    textAlign: 'center',
  },
  separator: {
    backgroundColor: color.border,
    height: '16px',
    marginInline: space.xs,
    width: '1px',
  },
  stage: {
    backgroundColor: color.background,
    cursor: 'default',
    display: 'flex',
    flexGrow: 1,
    minHeight: 0,
    overflow: 'auto',
    padding: space.lg,
    position: 'relative',
    userSelect: 'none',
  },
  grab: { cursor: 'grab' },
  grabbing: { cursor: 'grabbing' },
  // Auto margins center an image smaller than the stage and collapse to zero for a larger one,
  // which keeps every edge reachable by scrolling. Centering by alignment would clip the top-left.
  image: { display: 'block', flexShrink: 0, margin: 'auto', maxWidth: 'none' },
  pending: { height: 0, visibility: 'hidden', width: 0 },
  failed: { color: color.warning, fontSize: font.sizeSm, margin: 'auto' },
  sized: (width: string, height: string) => ({ height, width }),
});

/** Opens on mount and starts in fit mode, so each open is fresh. */
export function ImageViewer({
  src,
  title,
  onClose,
}: {
  readonly src: string;
  readonly title: string;
  readonly onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const center = useRef<Point | null>(null);
  const pressedBackdrop = useRef(false);
  const [zoom, setZoom] = useState<Zoom>(fitZoom);
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [stageSize, setStageSize] = useState<Size>({ width: 0, height: 0 });
  const [drag, setDrag] = useState<Drag | null>(null);

  const natural = load.kind === 'ready' ? load.natural : null;
  const scale = scaleOf(zoom, natural === null ? 1 : fitScale(natural, stageSize));
  const shown =
    natural === null
      ? null
      : {
          width: Math.max(1, Math.floor(natural.width * scale)),
          height: Math.max(1, Math.floor(natural.height * scale)),
        };
  const overflows =
    shown !== null && (shown.width > stageSize.width || shown.height > stageSize.height);

  useEffect(() => {
    if (!dialog.current?.open) dialog.current?.showModal();
    stage.current?.focus();
  }, []);

  useEffect(() => {
    const element = stage.current;
    if (element === null) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry === undefined) return;
      setStageSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Restores the image point that sat at the stage center before the zoom changed.
  useLayoutEffect(() => {
    const point = center.current;
    const element = stage.current;
    const img = image.current;
    center.current = null;
    if (point === null || element === null || img === null) return;
    element.scrollLeft = point.x * img.offsetWidth + img.offsetLeft - element.clientWidth / 2;
    element.scrollTop = point.y * img.offsetHeight + img.offsetTop - element.clientHeight / 2;
  });

  function changeZoom(next: Zoom) {
    const unchanged =
      next.kind === 'fit'
        ? zoom.kind === 'fit'
        : zoom.kind === 'scale' && zoom.scale === next.scale;
    // An unchanged zoom does not re-render, so a recorded center would wait and hijack a later one.
    if (natural === null || unchanged) return;
    const element = stage.current;
    const img = image.current;
    if (element !== null && img !== null && img.offsetWidth > 0 && img.offsetHeight > 0) {
      center.current = {
        x: (element.scrollLeft + element.clientWidth / 2 - img.offsetLeft) / img.offsetWidth,
        y: (element.scrollTop + element.clientHeight / 2 - img.offsetTop) / img.offsetHeight,
      };
    }
    setZoom(next);
  }

  const stepIn = () => {
    if (canZoomIn(scale)) changeZoom({ kind: 'scale', scale: zoomIn(scale) });
  };
  const stepOut = () => {
    if (canZoomOut(scale)) changeZoom({ kind: 'scale', scale: zoomOut(scale) });
  };
  const shortcuts: Readonly<Record<string, () => void>> = {
    '+': stepIn,
    '=': stepIn,
    '-': stepOut,
    '0': () => changeZoom(fitZoom),
    '1': () => changeZoom(actualSize),
  };

  function close() {
    dialog.current?.close();
    onClose();
  }

  return (
    <dialog
      ref={dialog}
      {...stylex.props(styles.dialog)}
      aria-label={`Preview of ${title}`}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onPointerDown={(event) => {
        pressedBackdrop.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && pressedBackdrop.current) close();
      }}
      onKeyDown={(event) => {
        if (event.metaKey || event.ctrlKey || event.altKey) return;
        const action = shortcuts[event.key];
        if (action === undefined) return;
        event.preventDefault();
        action();
      }}
    >
      <div {...stylex.props(styles.panel)}>
        <div {...stylex.props(styles.header)}>
          <h2 {...stylex.props(styles.title)}>
            <Truncate text={title} />
          </h2>
          <div {...stylex.props(styles.toolbar)}>
            <Button
              icon={<MinusIcon />}
              aria-label="Zoom out"
              aria-keyshortcuts="-"
              disabled={natural === null || !canZoomOut(scale)}
              onClick={stepOut}
            />
            <output aria-live="polite" {...stylex.props(styles.readout)}>
              {natural === null ? '' : `${Math.round(scale * 100)}%`}
            </output>
            <Button
              icon={<PlusIcon />}
              aria-label="Zoom in"
              aria-keyshortcuts="="
              disabled={natural === null || !canZoomIn(scale)}
              onClick={stepIn}
            />
            <Button
              aria-pressed={zoom.kind === 'fit'}
              aria-keyshortcuts="0"
              onClick={() => changeZoom(fitZoom)}
            >
              Fit
            </Button>
            <Button
              aria-pressed={zoom.kind === 'scale' && zoom.scale === 1}
              aria-keyshortcuts="1"
              onClick={() => changeZoom(actualSize)}
            >
              100%
            </Button>
            <div {...stylex.props(styles.separator)} aria-hidden="true" />
            <Button
              icon={<CloseIcon />}
              aria-label="Close"
              aria-keyshortcuts="Escape"
              onClick={close}
            />
          </div>
        </div>
        <div
          ref={stage}
          role="group"
          aria-label="Image, scroll to pan"
          tabIndex={0}
          {...stylex.props(
            styles.stage,
            overflows && (drag === null ? styles.grab : styles.grabbing),
            shared.focusRing,
          )}
          onPointerDown={(event) => {
            const element = event.currentTarget;
            const box = element.getBoundingClientRect();
            // A press on a scrollbar belongs to the scrollbar.
            const onScrollbar =
              event.clientX - box.left - element.clientLeft >= element.clientWidth ||
              event.clientY - box.top - element.clientTop >= element.clientHeight;
            if (event.button !== 0 || !overflows || onScrollbar) return;
            element.setPointerCapture(event.pointerId);
            setDrag({
              pointerId: event.pointerId,
              x: event.clientX,
              y: event.clientY,
              left: element.scrollLeft,
              top: element.scrollTop,
            });
          }}
          onPointerMove={(event) => {
            if (drag?.pointerId !== event.pointerId) return;
            event.currentTarget.scrollLeft = drag.left - (event.clientX - drag.x);
            event.currentTarget.scrollTop = drag.top - (event.clientY - drag.y);
          }}
          onPointerUp={() => setDrag(null)}
          onPointerCancel={() => setDrag(null)}
        >
          <UntrustedImage
            ref={image}
            src={src}
            alt={`Preview of ${title}`}
            style={[
              styles.image,
              shared.checkerboard,
              shown === null
                ? styles.pending
                : styles.sized(`${shown.width}px`, `${shown.height}px`),
            ]}
            onLoad={(event) =>
              setLoad({
                kind: 'ready',
                natural: {
                  width: event.currentTarget.naturalWidth,
                  height: event.currentTarget.naturalHeight,
                },
              })
            }
            onError={() => setLoad({ kind: 'failed' })}
          />
          {load.kind === 'failed' && (
            <p {...stylex.props(styles.failed)}>Preview could not be loaded</p>
          )}
        </div>
      </div>
    </dialog>
  );
}
