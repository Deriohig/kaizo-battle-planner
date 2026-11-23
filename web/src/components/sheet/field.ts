// The field as Matchups words it: the docs' note "PERMANENT RAIN" reads "Rain all fight", and a pair's own
// field ("Rain") is left out where it only repeats the one the bar shows. Both come from the sheet's own strings; a
// field the docs word differently is shown as written, only title-cased.

const PERMANENT = /^permanent\s+/i;

const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();

/** "PERMANENT RAIN" is "Rain all fight"; any other field note is the same text in sentence case ("HAIL" is "Hail"). */
export function fieldLabel(field: string): string {
  const trimmed = field.trim();
  return PERMANENT.test(trimmed) ? `${sentence(trimmed.replace(PERMANENT, ''))} all fight` : sentence(trimmed);
}

/** Whether a pair's own field is the one the bar already shows (the bar's note without its "PERMANENT"). */
export function sameField(barField: string | null, pairField: string | null): boolean {
  if (barField === null || pairField === null) return false;
  return barField.trim().replace(PERMANENT, '').toLowerCase() === pairField.trim().toLowerCase();
}
