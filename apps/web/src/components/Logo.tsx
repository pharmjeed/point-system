import pointAppIcon from '@brand/app-icons/favicon.svg';
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
 *
 * `brand="customer"` is the customer brand on the staff surfaces that show it (D-07, S-03, S-13; canon §1).
 * Since V2-D01 (DEC-470) the customer brand is POINT, so it maps to the POINT files that exist in brand/: the
 * horizontal lockup for the wordmark and the small-size app icon as the WhatsApp-style avatar (the MASAF files
 * belong to an operator now). No customer avatar or profile picture is drawn here: a dedicated POINT WhatsApp
 * profile image is an owner asset request (DEC-472).
 */
const FILES = {
  point: {
    mark: [pointMark, pointMark],
    'mark-white': [pointMarkWhite, pointMarkWhite],
    'lockup-rtl': [pointLockup, pointLockupOnDark],
    stacked: [pointStacked, pointStackedOnDark],
  },
  customer: {
    wordmark: [pointLockup, pointLockupOnDark],
    avatar: [pointAppIcon, pointAppIcon],
  },
} as const;

type PointVariant = keyof (typeof FILES)['point'];
type CustomerVariant = keyof (typeof FILES)['customer'];

export type LogoProps = (
  { brand?: 'point'; variant?: PointVariant } | { brand: 'customer'; variant?: CustomerVariant }
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
    props.brand === 'customer'
      ? FILES.customer[props.variant ?? 'wordmark']
      : FILES.point[props.variant ?? 'mark'];
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
