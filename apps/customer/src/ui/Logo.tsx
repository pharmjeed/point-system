/**
 * `Logo` of 03 §3.17: the brand files as they are (PNG copies of brand/logo/point/png, never redrawn or recoloured).
 */
import { Image, StyleSheet } from 'react-native';
import mark from '../../assets/brand/point-mark-512.png';
import markWhite from '../../assets/brand/point-mark-white-512.png';
import stacked from '../../assets/brand/point-logo-stacked-1024.png';

const sources = {
  stacked: { file: stacked, ratio: 1024 / 1271 },
  mark: { file: mark, ratio: 512 / 544 },
  // the white mark of brand/logo for the blue C-06 hero (V2-UX option B, DEC-580)
  markWhite: { file: markWhite, ratio: 512 / 544 },
} as const;

export function Logo({
  variant,
  height,
  label,
}: {
  variant: keyof typeof sources;
  height: number;
  label: string;
}) {
  const s = sources[variant];
  return (
    <Image
      source={s.file}
      accessibilityRole="image"
      accessibilityLabel={label}
      style={[styles.img, { height, width: height * s.ratio }]}
      resizeMode="contain"
    />
  );
}

const styles = StyleSheet.create({ img: { alignSelf: 'center' } });
