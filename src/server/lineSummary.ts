// The line builder's log formatter (docs/line-builder.md, "Server"): a step's `Outcome.log` (the engine's omniscient
// Showdown protocol lines) as short readable events in order, and the HP the two active Pokémon end the step on. Pure:
// it reads the lines and a seed (the HP each Pokémon had before the step, who was out, how to name them).
//
// Read: |move|, |cant|, |-damage| and |-heal| (as a percent of max HP, with what dealt or gave it), |-crit|, |-miss|,
// |-supereffective|, |-resisted|, |-immune|, |-status|, |-curestatus|, |-boost|, |-unboost|, |-item|, |-enditem|,
// |-ability|, |-activate|, |faint|, |switch|, |drag|, |-weather| (an [upkeep] line says nothing new), |-fieldstart|,
// |-sidestart|, and |-start| and |-end| (a volatile effect on one Pokémon: confusion, infatuation, Leech Seed, Substitute…;
// a [silent] or [upkeep] one says nothing new). |-sethp| and |replace| only keep the HP and the active Pokémon right. Any
// other line is skipped.
// `|cant|` is not in the doc's list; a Pokémon that could not move (fully paralysed, asleep) is a thing a line depends on.
// Nor are `|-start|` and `|-end|`: a hit that confuses and the same hit that does not are two
// stories, and without a line for it the tree screen grouped them as one.
// A |move| line tagged `[notarget]` ends "(no target)": its target fainted before it (a Selfdestruct, say), so
// nothing happened. The cartridge still spends the PP (battle_controller_player.c:3181, before the check at :3190); the
// `|-notarget|` line after it says nothing new. Without the words the move read as a hit.

import type { LineEndHpJson } from '../contracts/api.js';
import type { Side } from '../contracts/engine.js';

/** What a step starts from. `hp` is keyed `<side>|<battle name>`; `active` the battle names out at the start. */
export interface SummarySeed {
  hp: ReadonlyMap<string, { hp: number; maxHp: number }>;
  active: { p1: string | null; p2: string | null };
  /** The page's name for a Pokémon, given its side and its battle name. */
  name(side: Side, ident: string): string;
}

export interface StepSummary {
  lines: string[];
  endHp: { p1: LineEndHpJson | null; p2: LineEndHpJson | null };
}

const PIXELS = 48;

/** The cartridge's HP bar (engine/observe.ts `barPixels`): floor(HP × 48 / max HP), at least 1 with HP left. */
function barPercent(hp: number, maxHp: number): number {
  if (hp <= 0) return 0;
  return ((Math.max(1, Math.floor((hp * PIXELS) / maxHp)) * 100) / PIXELS);
}

const round1 = (x: number): number => Math.round(x * 10) / 10;

/** A percent for a sentence, to one decimal and without a trailing .0 ("62.5", "80"). */
function pct(x: number): string {
  return String(round1(x));
}

const STATUS_NOUN: Record<string, string> = { brn: 'burned', par: 'paralysed', psn: 'poisoned', tox: 'badly poisoned', slp: 'asleep', frz: 'frozen' };
const STATUS_NAME: Record<string, string> = { brn: 'burn', par: 'paralysis', psn: 'poison', tox: 'poison', slp: 'sleep', frz: 'freeze' };
const STAT_NAME: Record<string, string> = {
  atk: 'Attack', def: 'Defense', spa: 'Sp. Atk', spd: 'Sp. Def', spe: 'Speed', accuracy: 'Accuracy', evasion: 'Evasion',
};
const WEATHER_NAME: Record<string, string> = { raindance: 'Rain', sunnyday: 'Sun', sandstorm: 'Sandstorm', hail: 'Hail' };
const CANT_REASON: Record<string, string> = { par: 'paralysis', slp: 'sleep', frz: 'freeze', flinch: 'flinch', recharge: 'recharging', attract: 'love', taunt: 'Taunt' };

/** "35/44 par" or "0 fnt": the HP and, when the string has one, the max HP. */
function parseHp(text: string | undefined): { hp: number; maxHp: number | null } | null {
  const m = /^(\d+)(?:\/(\d+))?/.exec(text ?? '');
  return m === null ? null : { hp: Number(m[1]), maxHp: m[2] === undefined ? null : Number(m[2]) };
}

/** "p1a: Name" or "p2: Name" as the side and the battle name; null for anything else. */
function parseIdent(text: string | undefined): { side: Side; ident: string } | null {
  const m = /^(p[12])[a-z]?: (.+)$/.exec(text ?? '');
  return m === null ? null : { side: m[1] as Side, ident: m[2]! };
}

/** What a `[from] …` argument names ("item: Life Orb" is "Life Orb"; "brn" is "burn"), or null without one. */
function sourceOf(args: readonly string[]): string | null {
  const from = args.find((arg) => arg.startsWith('[from]'));
  if (from === undefined) return null;
  const text = from.slice('[from]'.length).trim().replace(/^(item|ability|move): ?/i, '');
  return STATUS_NAME[text] ?? text;
}

const sourceText = (args: readonly string[]) => {
  const source = sourceOf(args);
  return source === null ? '' : ` (${source})`;
};

/** "move: Spikes" or "Gravity" as the name. */
const afterColon = (text: string): string => text.replace(/^[a-z]+: ?/i, '');

/**
 * A `|-start|` or `|-end|` line as words: `name` is the Pokémon's page name, `effect` the line's effect ("confusion",
 * "move: Leech Seed", "perish3"), `detail` what it holds after that when it is not a tag (Disable's move, typechange's type).
 * Null for a line that says nothing new: a [silent] one (its cause is another line) or an [upkeep] one.
 */
function volatileText(cmd: '-start' | '-end', name: string, effect: string, detail: string | undefined, args: readonly string[]): string | null {
  if (args.includes('[silent]') || args.includes('[upkeep]')) return null;
  const what = afterColon(effect);
  const source = sourceText(args);
  const id = what.toLowerCase();
  if (id === 'confusion') return cmd === '-start' ? `${name} is confused${source}` : `${name} snaps out of confusion${source}`;
  if (id === 'attract') return cmd === '-start' ? `${name} fell in love${source}` : `${name} is no longer in love${source}`;
  const counted = /^(perish|stockpile)(\d)$/.exec(id);
  if (cmd === '-start' && counted !== null) return counted[1] === 'perish' ? `${name}'s perish count is ${counted[2]}${source}` : `${name} has stockpiled ${counted[2]}${source}`;
  const held = detail === undefined || detail.startsWith('[') ? '' : detail;
  if (cmd === '-start' && id === 'typechange' && held !== '') return `${name}'s type is now ${held}${source}`;
  return `${what} ${cmd === '-start' ? 'starts' : 'ends'} on ${name}${held === '' ? '' : ` (${held})`}${source}`;
}

export function summarizeLog(log: readonly string[], seed: SummarySeed): StepSummary {
  const hp = new Map(seed.hp);
  const active: { p1: string | null; p2: string | null } = { ...seed.active };
  const lines: string[] = [];
  const parsed = log.map((line) => line.split('|').slice(1));

  const moved = new Set<Side>();
  for (const args of parsed) {
    if (args[0] !== 'move' || args.some((arg) => arg.startsWith('[from]'))) continue;
    const who = parseIdent(args[1]);
    if (who !== null) moved.add(who.side);
  }
  let firstMove = moved.size > 1;

  const nameOf = (text: string | undefined): string => {
    const who = parseIdent(text);
    return who === null ? (text ?? '') : seed.name(who.side, who.ident);
  };

  /** Records `text` (an HP field) for the Pokémon `ident` names, and returns its HP before and after. */
  function setHp(identText: string | undefined, text: string | undefined): { before: number | null; now: number; maxHp: number } | null {
    const who = parseIdent(identText);
    const next = parseHp(text);
    if (who === null || next === null) return null;
    const key = `${who.side}|${who.ident}`;
    const known = hp.get(key);
    const maxHp = next.maxHp ?? known?.maxHp;
    if (maxHp === undefined) return null;
    hp.set(key, { hp: next.hp, maxHp });
    return { before: known?.hp ?? null, now: next.hp, maxHp };
  }

  for (const args of parsed) {
    const [cmd, subject, a2, a3] = args;
    const name = nameOf(subject);
    switch (cmd) {
      case 'move': {
        const from = args.find((arg) => arg.startsWith('[from]'));
        let text: string;
        if (from !== undefined) {
          text = `${name} uses ${a2} via ${sourceOf(args)}`;
        } else if (firstMove) {
          firstMove = false;
          text = `${name} moves first (${a2})`;
        } else {
          text = `${name} uses ${a2}`;
        }
        lines.push(args.includes('[notarget]') ? `${text} (no target)` : text);
        break;
      }
      case 'cant':
        lines.push(`${name} can't move (${CANT_REASON[a2 ?? ''] ?? a2})`);
        break;
      case '-crit':
        lines.push(`Critical hit on ${name}`);
        break;
      case '-miss':
        lines.push(`${name} misses`);
        break;
      case '-supereffective':
        lines.push('Super effective');
        break;
      case '-resisted':
        lines.push('Not very effective');
        break;
      case '-immune':
        lines.push(`${name} is immune${sourceText(args)}`);
        break;
      case '-damage':
      case '-heal': {
        const change = setHp(subject, a2);
        if (change === null || args.includes('[silent]')) break;
        const left = pct((change.now * 100) / change.maxHp);
        if (change.before === null) {
          lines.push(`${name} at ${left}%${sourceText(args)}`);
        } else {
          const size = pct((Math.abs(change.before - change.now) * 100) / change.maxHp);
          lines.push(`${name} ${cmd === '-damage' ? 'loses' : 'heals'} ${size}% (${left}% left)${sourceText(args)}`);
        }
        break;
      }
      case '-sethp':
        setHp(subject, a2);
        break;
      case '-status':
        lines.push(`${name} is ${STATUS_NOUN[a2 ?? ''] ?? a2}`);
        break;
      case '-curestatus':
        lines.push(`${name} is cured of ${STATUS_NAME[a2 ?? ''] ?? a2}`);
        break;
      case '-boost':
      case '-unboost':
        lines.push(`${name}'s ${STAT_NAME[a2 ?? ''] ?? a2} ${cmd === '-boost' ? '+' : '-'}${a3}${sourceText(args)}`);
        break;
      case '-item':
        lines.push(`${name} holds ${a2}`);
        break;
      case '-enditem':
        lines.push(`${name}'s ${a2} is used up`);
        break;
      case '-ability':
        lines.push(`${name}'s ${a2} shows`);
        break;
      case '-activate':
        lines.push(`${name}'s ${afterColon(a2 ?? '')} activates`);
        break;
      case 'faint': {
        const who = parseIdent(subject);
        if (who !== null) {
          const known = hp.get(`${who.side}|${who.ident}`);
          if (known !== undefined) hp.set(`${who.side}|${who.ident}`, { hp: 0, maxHp: known.maxHp });
        }
        lines.push(`${name} fainted`);
        break;
      }
      case 'switch':
      case 'drag':
      case 'replace': {
        const who = parseIdent(subject);
        if (who === null) break;
        active[who.side] = who.ident;
        setHp(subject, args[3]);
        if (cmd === 'switch') lines.push(who.side === 'p1' ? `You send out ${name}` : `The trainer sends out ${name}`);
        else if (cmd === 'drag') lines.push(`${name} is dragged out`);
        break;
      }
      case '-weather':
        if (subject === 'none') lines.push('The weather clears');
        else if (!args.includes('[upkeep]')) lines.push(`Weather: ${WEATHER_NAME[(subject ?? '').toLowerCase()] ?? subject}`);
        break;
      case '-fieldstart':
        lines.push(`${afterColon(subject ?? '')} starts`);
        break;
      case '-sidestart': {
        const who = parseIdent(subject);
        lines.push(`${afterColon(a2 ?? '')} set on ${who?.side === 'p1' ? 'your' : "the trainer's"} side`);
        break;
      }
      case '-start':
      case '-end': {
        const text = volatileText(cmd, name, a2 ?? '', a3, args);
        if (text !== null) lines.push(text);
        break;
      }
      default:
        break;
    }
  }

  const endOf = (side: Side): LineEndHpJson | null => {
    const ident = active[side];
    const entry = ident === null ? undefined : hp.get(`${side}|${ident}`);
    if (ident === null || entry === undefined) return null;
    const percent = side === 'p2' ? barPercent(entry.hp, entry.maxHp) : (entry.hp * 100) / entry.maxHp;
    return { name: seed.name(side, ident), hp: entry.hp, maxHp: entry.maxHp, percent: round1(percent) };
  };
  return { lines, endHp: { p1: endOf('p1'), p2: endOf('p2') } };
}
