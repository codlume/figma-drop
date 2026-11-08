import * as stylex from '@stylexjs/stylex';
import { type ReactEventHandler, type Ref, useState } from 'react';
import type { Revision } from './bridge.ts';
import { DocumentIcon, WarningIcon } from './Icons.tsx';
import { color, font, radius, space } from './tokens.stylex.ts';
import { shared } from './ui.tsx';

type Size = 'large' | 'card' | 'row';
type NoticeKind = 'damaged' | 'none' | 'failed';

const notices: Record<Size, Record<NoticeKind, string | null>> = {
  large: {
    damaged:
      "This revision's receipt can't be read. Its files have been left alone, and the bundle can't be copied to a folder.",
    none: 'No preview in this export',
    failed: 'Preview could not be loaded',
  },
  card: { damaged: 'Damaged', none: 'No preview', failed: 'Preview failed' },
  row: { damaged: null, none: null, failed: null },
};

const styles = stylex.create({
  frame: {
    alignItems: 'center',
    backgroundColor: color.background,
    borderRadius: radius.sm,
    color: color.textMuted,
    display: 'flex',
    flexShrink: 0,
    justifyContent: 'center',
    overflow: 'hidden',
    width: '100%',
  },
  panel: {
    backgroundColor: color.surface,
    borderColor: color.border,
    borderStyle: 'solid',
    borderWidth: '1px',
    boxSizing: 'border-box',
  },
  large: { aspectRatio: '4 / 3', maxHeight: '240px' },
  card: { aspectRatio: '4 / 5', flexDirection: 'column' },
  row: { aspectRatio: '1' },
  smallCheckerboard: { backgroundSize: '8px 8px' },
  // Auto block margins center a frame shorter than the card and collapse to zero for a taller
  // one, which then overflows only at the bottom, so tall mobile frames show their top.
  cardFill: { justifyContent: 'flex-start' },
  image: { display: 'block', height: '100%', objectFit: 'contain', width: '100%' },
  cardImage: {
    display: 'block',
    flexShrink: 0,
    height: 'auto',
    marginBlock: 'auto',
    width: '100%',
  },
  notice: {
    alignItems: 'center',
    display: 'flex',
    flexDirection: 'column',
    fontSize: font.sizeSm,
    rowGap: '6px',
    textAlign: 'center',
  },
  noticeLarge: { padding: space.lg },
  noticeCard: { padding: space.xs },
  warning: { color: color.warning },
  opener: {
    backgroundColor: 'transparent',
    borderRadius: radius.sm,
    borderStyle: 'none',
    cursor: 'zoom-in',
    display: 'block',
    padding: 0,
    width: '100%',
  },
});

function Notice({ size, kind }: { readonly size: Size; readonly kind: NoticeKind }) {
  const iconSize = size === 'large' ? 20 : 16;
  return (
    <div
      {...stylex.props(
        styles.notice,
        size === 'large' && styles.noticeLarge,
        size === 'card' && styles.noticeCard,
        kind !== 'none' && styles.warning,
      )}
    >
      {kind === 'none' ? <DocumentIcon size={iconSize} /> : <WarningIcon size={iconSize} />}
      {notices[size][kind]}
    </div>
  );
}

/** Every received image renders through here, so none sends a referrer or can be dragged out. */
export function UntrustedImage({
  ref,
  src,
  alt,
  style,
  onLoad,
  onError,
}: {
  readonly ref?: Ref<HTMLImageElement>;
  readonly src: string;
  readonly alt: string;
  readonly style: stylex.StyleXStyles;
  readonly onLoad?: ReactEventHandler<HTMLImageElement>;
  readonly onError?: ReactEventHandler<HTMLImageElement>;
}) {
  return (
    <img
      ref={ref}
      {...stylex.props(style)}
      src={src}
      alt={alt}
      referrerPolicy="no-referrer"
      draggable={false}
      decoding="async"
      onLoad={onLoad}
      onError={onError}
    />
  );
}

export function PreviewImage({
  revision,
  alt,
  size,
  onOpen,
  openerRef,
}: {
  readonly revision: Revision;
  readonly alt: string;
  readonly size: Size;
  /** Makes a loaded preview a button. Damaged, missing, and failed previews stay inert. */
  readonly onOpen?: () => void;
  readonly openerRef?: Ref<HTMLButtonElement>;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const url = revision.preview?.url ?? null;
  const frame = stylex.props(styles.frame, styles[size], size === 'large' && styles.panel);

  if (revision.state === 'damaged') {
    return (
      <div {...frame}>
        <Notice size={size} kind="damaged" />
      </div>
    );
  }
  if (url === null || url === failedUrl) {
    return (
      <div {...frame}>
        <Notice size={size} kind={url === null ? 'none' : 'failed'} />
      </div>
    );
  }
  const image = (
    <div
      {...stylex.props(
        styles.frame,
        styles[size],
        shared.checkerboard,
        size === 'row' && styles.smallCheckerboard,
        size === 'card' && styles.cardFill,
      )}
    >
      <UntrustedImage
        style={size === 'card' ? styles.cardImage : styles.image}
        src={url}
        alt={alt}
        onError={() => setFailedUrl(url)}
      />
    </div>
  );
  if (onOpen === undefined) return image;
  return (
    <button
      ref={openerRef}
      type="button"
      aria-haspopup="dialog"
      aria-label="Open image viewer"
      onClick={onOpen}
      {...stylex.props(styles.opener, shared.focusRing)}
    >
      {image}
    </button>
  );
}
