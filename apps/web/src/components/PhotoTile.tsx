import { Camera, CircleCheck, Image, Plus, RefreshCw, TriangleAlert, Upload } from 'lucide-react';
import { components } from '@/i18n/ar';
import { fmt } from '@/i18n/fmt';
import { cx } from '@/lib/cx';
import { Icon } from './Icon';

export type PhotoTileState = 'empty' | 'uploading' | 'uploaded' | 'failed';

export interface PhotoTileProps {
  /** Angle label from the dictionary (`mediaKind`). */
  angle: string;
  state?: PhotoTileState;
  /** 0–100 while uploading. */
  progress?: number;
  /** Object URL of the local thumbnail (never persisted as a URL; 02 §1.11). */
  src?: string;
  extra?: boolean;
  disabled?: boolean;
  onFile?: (file: File) => void;
}

/**
 * One mandatory angle (D-06): empty, uploading, uploaded, failed. Tapping opens the camera directly
 * (`capture="environment"`). Compression and the IndexedDB queue live in the intake feature (PNT-027/071).
 */
export function PhotoTile({
  angle,
  state = 'empty',
  progress = 0,
  src,
  extra,
  disabled,
  onFile,
}: PhotoTileProps) {
  let inner;
  if (state === 'uploading') {
    inner = (
      <>
        <Icon icon={Upload} />
        <span className="pt-photo__label">{angle}</span>
        <span
          className="pt-progress"
          role="progressbar"
          aria-valuenow={progress}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={components.photo.uploading}
        >
          <span style={{ inlineSize: `${progress}%` }} />
        </span>
      </>
    );
  } else if (state === 'uploaded') {
    inner = (
      <>
        {src ? (
          <img src={src} alt={fmt(components.photo.photoOf, { angle })} className="pt-photo__img" />
        ) : (
          <span className="pt-photo__ph">
            <Icon icon={Image} size={28} />
          </span>
        )}
        <span className="pt-photo__ok">
          <Icon icon={CircleCheck} size={16} />
          <span>{angle}</span>
        </span>
      </>
    );
  } else if (state === 'failed') {
    inner = (
      <>
        <Icon icon={TriangleAlert} />
        <span className="pt-photo__label">{angle}</span>
        <span className="pt-photo__retry">
          <Icon icon={RefreshCw} size={16} />
          {components.photo.retry}
        </span>
      </>
    );
  } else {
    inner = (
      <>
        <Icon icon={extra ? Plus : Camera} size={28} />
        <span className="pt-photo__label">{angle}</span>
      </>
    );
  }
  return (
    <label className={cx('pt-photo', `pt-photo--${state}`, disabled && 'is-disabled')}>
      <input
        type="file"
        accept="image/*"
        capture="environment"
        className="pt-sr"
        disabled={disabled || state === 'uploading'}
        aria-label={fmt(state === 'failed' ? components.photo.recapture : components.photo.capture, {
          angle,
        })}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onFile?.(file);
          e.target.value = '';
        }}
      />
      {inner}
    </label>
  );
}

export interface PhotoGridProps {
  tiles: PhotoTileProps[];
  allowExtra?: boolean;
  onExtra?: (file: File) => void;
}

/** The four mandatory angles + «صورة إضافية» (03 §3.12). */
export function PhotoGrid({ tiles, allowExtra = true, onExtra }: PhotoGridProps) {
  return (
    <div className="pt-photogrid">
      {tiles.map((tile) => (
        <PhotoTile key={tile.angle} {...tile} />
      ))}
      {allowExtra ? <PhotoTile angle={components.photo.extra} extra onFile={onExtra} /> : null}
    </div>
  );
}
