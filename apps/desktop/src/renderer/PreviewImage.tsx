import * as stylex from '@stylexjs/stylex';
import { useState } from 'react';
import type { Revision } from './bridge.ts';
import { DocumentIcon, WarningIcon } from './Icons.tsx';
import { color, font, radius, space } from './tokens.stylex.ts';

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
  checkerboard: {
    backgroundColor: color.surfaceRaised,
    backgroundImage: `repeating-conic-gradient(color-mix(in srgb, ${color.text} 6%, transparent) 0 25%, transparent 0 50%)`,
    backgroundSize: '16px 16px',
  },
  large: { aspectRatio: '4 / 3', maxHeight: '240px' },
  card: { aspectRatio: '4 / 3' },
  row: { aspectRatio: '1' },
  smallCheckerboard: { backgroundSize: '8px 8px' },
  image: { display: 'block', height: '100%', objectFit: 'contain', width: '100%' },
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

export function PreviewImage({
  revision,
  alt,
  size,
}: {
  readonly revision: Revision;
  readonly alt: string;
  readonly size: Size;
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
  return (
    <div
      {...stylex.props(
        styles.frame,
        styles[size],
        styles.checkerboard,
        size === 'row' && styles.smallCheckerboard,
      )}
    >
      <img
        {...stylex.props(styles.image)}
        src={url}
        alt={alt}
        referrerPolicy="no-referrer"
        draggable={false}
        decoding="async"
        onError={() => setFailedUrl(url)}
      />
    </div>
  );
}
