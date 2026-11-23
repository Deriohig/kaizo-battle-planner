// The colour band of an HP bar: above 50% ok, above 20% up to 50% warn, 20% or less danger (the fill's `is-*` class).

export type HpBand = 'ok' | 'warn' | 'danger';

export function hpBand(percent: number): HpBand {
  if (percent > 50) return 'ok';
  if (percent > 20) return 'warn';
  return 'danger';
}
