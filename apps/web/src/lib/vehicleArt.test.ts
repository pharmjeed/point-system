import { describe, expect, it } from 'vitest';
import * as shared from '../../../../packages/shared/src/vehicle-art';
import * as local from './vehicleArt';

describe('vehicle art (DEC-642, DEC-643)', () => {
  it('draws the same cars and paints as the customer app', () => {
    expect(local.CAR_VIEWBOX).toBe(shared.CAR_VIEWBOX);
    expect(local.CAR_ART).toEqual(shared.CAR_ART);
    expect(local.VEHICLE_COLOR_PAINT).toEqual(shared.VEHICLE_COLOR_PAINT);
    expect(local.CAR_PARTS).toEqual(shared.CAR_PARTS);
    expect(local.CAR_NEUTRAL_PAINT).toBe(shared.CAR_NEUTRAL_PAINT);
    for (const color of [...Object.keys(shared.VEHICLE_COLOR_PAINT), 'لون خاص', null]) {
      expect(local.carColors(color)).toEqual(shared.carColors(color));
    }
  });

  it('shades the paint: light on top, deeper at the sills, a soft tint for the card', () => {
    const red = local.carColors('red');
    expect(red.mid).toBe('#C8102E');
    expect(local.shade('#000000', 0.5)).toBe('#808080');
    expect(local.shade('#FFFFFF', -0.5)).toBe('#808080');
    expect(red.key).toBe('C8102E');
    // white keeps a visible body and card; no paint draws the neutral car
    expect(local.carColors('white').tint).not.toBe('#FFFFFF');
    expect(local.carColors(null).mid).toBe(local.CAR_NEUTRAL_PAINT);
  });

  it('picks the shape and the paint, with neutral fallbacks', () => {
    expect(local.carShape('suv')).toBe('suv');
    expect(local.carShape('other')).toBe('sedan');
    expect(local.carShape(null)).toBe('sedan');
    expect(local.carPaint('white')).toBe('#FFFFFF');
    expect(local.carPaint('لون خاص')).toBeNull();
    expect(local.paintIsDark('#141414')).toBe(true);
    expect(local.paintIsDark('#FFFFFF')).toBe(false);
  });
});
