import masafAvatar from '@brand/logo/masaf/masaf-avatar.svg';
import masafWordmarkOnDark from '@brand/logo/masaf/masaf-wordmark-on-dark.svg';
import masafWordmark from '@brand/logo/masaf/masaf-wordmark.svg';
import pointLockupOnDark from '@brand/logo/point/point-lockup-horizontal-rtl-on-dark.svg';
import pointLockup from '@brand/logo/point/point-lockup-horizontal-rtl.svg';
import pointStackedOnDark from '@brand/logo/point/point-logo-stacked-on-dark.svg';
import pointStacked from '@brand/logo/point/point-logo-stacked.svg';
import pointMarkWhite from '@brand/logo/point/point-mark-white.svg';
import pointMark from '@brand/logo/point/point-mark.svg';
import { cx } from '@/lib/cx';

/**
 * The brand SVG files exactly as shipped in brand/logo/ (03 §3.17, BRAND §2): imported as assets, never
 * redrawn or recoloured. `theme="auto"` renders the light and the dark file and lets CSS show the one
 * matching the nearest data-theme.
 */
const FILES = {
  point: {
    mark: [pointMark, pointMark],
    'mark-white': [pointMarkWhite, pointMarkWhite],
    'lockup-rtl': [pointLockup, pointLockupOnDark],
    stacked: [pointStacked, pointStackedOnDark],
  },
  masaf: {
    wordmark: [masafWordmark, masafWordmarkOnDark],
    avatar: [masafAvatar, masafAvatar],
  },
} as const;

type PointVariant = keyof (typeof FILES)['point'];
type MasafVariant = keyof (typeof FILES)['masaf'];

export type LogoProps = (
  { brand?: 'point'; variant?: PointVariant } | { brand: 'masaf'; variant?: MasafVariant }
) & {
  theme?: 'light' | 'dark' | 'auto';
  height?: number;
  /** Accessible name; pass '' when the brand name is written next to the logo. */
  alt: string;
  className?: string;
};

export function Logo(props: LogoProps) {
  const { theme = 'auto', height, alt, className } = props;
  const pair: readonly [string, string] =
    props.brand === 'masaf' ? FILES.masaf[props.variant ?? 'wordmark'] : FILES.point[props.variant ?? 'mark'];
  const style = height ? { blockSize: height, inlineSize: 'auto' } : undefined;
  const img = (src: string, extra?: string) => (
    <img src={src} alt={alt} className={cx('pt-logo', extra, className)} style={style} draggable={false} />
  );
  if (theme === 'light' || pair[0] === pair[1]) return img(pair[0]);
  if (theme === 'dark') return img(pair[1]);
  return (
    <>
      {img(pair[0], 'pt-only-light')}
      {img(pair[1], 'pt-only-dark')}
    </>
  );
}
