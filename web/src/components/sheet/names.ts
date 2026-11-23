import type { SheetMonJson } from '../../../../src/server/apiTypes';

/** "Blaze (Monferno)" for a nickname, else the species. */
export function monName(mon: SheetMonJson): string {
  // The game's default nickname is the species in capitals ("RAICHU"), which is no nickname.
  const nicknamed = mon.nickname !== null && mon.nickname !== '' && mon.nickname.toLowerCase() !== mon.name.toLowerCase();
  return nicknamed ? `${mon.nickname} (${mon.name})` : mon.name;
}

/** One label per party index; the second of a species reads "Koffing 2", the third "Koffing 3". */
export function enemyLabels(enemies: readonly SheetMonJson[]): string[] {
  const seen = new Map<string, number>();
  return enemies.map((enemy) => {
    const count = (seen.get(enemy.name) ?? 0) + 1;
    seen.set(enemy.name, count);
    return count === 1 ? enemy.name : `${enemy.name} ${count}`;
  });
}
