// The solver's PlanLabeler with real names (docs/solver-integration.md section 6): the player's and the AI's moves, switches
// and bag items by name ("Use Ember", "Switch to Fernando", "Use Full Restore"), chance outcomes as conditions ("If
// Ember crits, leaves Zigzagoon at 40%", "If Whirlwind brings in Hawk"), and kill causes ("enemy crit Tackle on turn 3
// kills Fernando").
//
// Names. Moves are the hack's names, from their Showdown IDs ("Solar-Beam", whose Showdown name is "Solar-Beam (130)").
// The player's Pokémon are named as the resolver names them (resolver.ts `pageNames`, two of a name told apart by level or
// place): a battle name is traced to its set and the set to the save's Pokémon, by its party position when the caller
// gives the battle's party order (`order`), else by battleView.ts `matchPlayerSet`. The AI's keep Showdown's battle
// names ("Zubat 2" for a second Zubat).
//
// Who a chance happened to. A label names the Pokémon that was out on its side when it happened: the one the step
// started with for a speed tie or a Quick Claw, else the subject of the step's next line on that side, the step's log
// read in order alongside the labels.

import PS from 'pokemon-showdown';
import type { KaizoMove } from '../battle/moves.js';
import type { PlayerMon } from '../battle/playerMon.js';
import type { ChanceLabel, Choice, EngineState, Outcome, Side } from '../contracts/engine.js';
import type { MonRef } from '../contracts/solver.js';
import { BAG_ITEM_NAMES, bagItemId, moveId, restore } from '../engine/index.js';
import { buildNameIndex } from '../names/nameIndex.js';
import { buildLookups, type Lookups, matchPlayerSet, requestMoveId } from './battleView.js';
import type { PlanLabeler } from './fight.js';
import { monLabel, pageNames } from './resolver.js';

const { toID } = PS;

export interface LabelerOptions {
  /** The hack's moves (`buildMoves`, as installed with `installKaizoDex`): chance labels name moves by their Showdown ID. */
  moves: ReadonlyMap<number, KaizoMove>;
  /** The player's Pokémon that may be in the battle (the save's eligible ones), named as the resolver names them. */
  mons?: ReadonlyMap<MonRef, PlayerMon>;
  /**
   * The battle's party as refs of `mons`, in order (`BattleInput.player`). Given, a set of the battle is named by its party
   * position, which a level-up in the fight does not change; absent, by `matchPlayerSet`.
   */
  order?: readonly MonRef[];
  /**
   * A state as the reference engine's readers take it (the engine kit's `reference`, src/engines/select.ts,
   * which converts a native state). Absent: every state is a reference state already. Labels are still cached by the
   * state's own key.
   */
  reference?: (state: EngineState) => EngineState;
}

/** The most choice labels cached before the cache starts again. */
const CACHE_LIMIT = 50_000;
const BATTLE_CACHE = 4;

/** Item names by the ID a Choice uses (`bagItemId`): the engine's bag items (`BAG_ITEM_NAMES`: Gen 4 medicine and battle items, which the name index lacks), then the name index's Gen 4 held items. */
const ITEM_NAMES: ReadonlyMap<string, string> = (() => {
  const names = buildNameIndex({ species: [], moves: [] });
  const map = new Map<string, string>();
  for (let id = 1; id < 600; id++) {
    const name = BAG_ITEM_NAMES[id] ?? names.item(id);
    if (name.startsWith('(')) continue;
    const key = bagItemId(id);
    if (key !== '' && !map.has(key)) map.set(key, name);
  }
  return map;
})();

const STATUS_WORDS: Record<string, [string, string]> = {
  brn: ['burns', 'burn'], par: ['paralyses', 'paralysis'], psn: ['poisons', 'poison'], tox: ['badly poisons', 'bad poison'],
  frz: ['freezes', 'freeze'], slp: ['puts to sleep', 'sleep'], flinch: ['makes the target flinch', 'flinch'],
  confusion: ['confuses', 'confusion'],
};

const STAT_WORDS: Record<string, string> = { atk: 'Attack', def: 'Defense', spa: 'Sp. Atk', spd: 'Sp. Def', spe: 'Speed', accuracy: 'accuracy', evasion: 'evasion' };

const RESIDUAL_CAUSES: Record<string, string> = {
  psn: 'poison', tox: 'poison', brn: 'burn', confusion: 'confusion self-hit', recoil: 'recoil', sandstorm: 'sandstorm',
  hail: 'hail', stealthrock: 'Stealth Rock', spikes: 'Spikes', leechseed: 'Leech Seed', curse: 'Curse', nightmare: 'Nightmare',
  lifeorb: 'Life Orb', perishsong: 'Perish Song', baddreams: 'Bad Dreams', struggle: 'Struggle recoil',
};

/** A PlanLabeler over the installed Kaizo dex (see the top of the file). */
export function createLabeler(opts: LabelerOptions): PlanLabeler {
  const mons = opts.mons ?? new Map<MonRef, PlayerMon>();
  const pages = pageNames(mons);
  const refOf = new Map<PlayerMon, MonRef>([...mons].map(([ref, mon]) => [mon, ref]));
  const team = [...mons.values()];
  const byBattleName = new Map<string, PlayerMon[]>();
  for (const mon of team) {
    const key = mon.nickname || mon.name;
    byBattleName.set(key, [...(byBattleName.get(key) ?? []), mon]);
  }
  let lookups: Lookups | null = null;
  let moveNames: Map<string, string> | null = null;
  const cache = new Map<string, string>();
  const battles = new Map<string, Battle>();

  const pageOf = (mon: PlayerMon) => pages.get(refOf.get(mon)!) ?? monLabel(mon.nickname, mon.name);

  function battleOf(state: EngineState): Battle {
    let battle = battles.get(state.key);
    if (battle === undefined) {
      if (battles.size >= BATTLE_CACHE) battles.delete(battles.keys().next().value!);
      battle = restore(opts.reference?.(state) ?? state);
      battles.set(state.key, battle);
    }
    return battle;
  }

  /** The hack's name for a move's Showdown ID (the label sources), else the ID. */
  function moveName(id: string): string {
    if (moveNames === null) {
      moveNames = new Map();
      for (const move of opts.moves.values()) {
        try {
          moveNames.set(moveId(move), move.name);
        } catch {
          // a move the installed dex lacks
        }
      }
    }
    return moveNames.get(id) ?? moveNames.get(toID(id)) ?? id;
  }

  /** The player's Pokémon behind a set of the battle: its page name (by its party position with `order`). */
  function setName(set: PokemonSet, battle: Battle): string {
    if (opts.order !== undefined) {
      const ref = opts.order[battle.p1.team.indexOf(set)];
      const name = ref === undefined ? undefined : pages.get(ref);
      if (name !== undefined) return name;
    }
    const mon = matchPlayerSet(set, team, opts.moves, (lookups ??= buildLookups(opts.moves)));
    return mon !== null ? pageOf(mon) : monLabel(set.name.replace(/ \d+$/, ''), battle.dex.species.get(set.species).name);
  }

  /**
   * The player's Pokémon by its battle name (a repeated name gets " 2", " 3"… in battle order): its page name. A name that
   * several of the save's Pokémon share is traced through `state`'s battle to its set.
   */
  function playerName(name: string, state: EngineState | null): string {
    const base = byBattleName.has(name) ? name : name.replace(/ \d+$/, '');
    const candidates = byBattleName.get(base) ?? [];
    const names = new Set(candidates.map(pageOf));
    if (names.size === 1 && name === base) return [...names][0]!;
    if (state !== null) {
      const battle = battleOf(state);
      const pokemon = battle.p1.pokemon.find((p) => p.name === name);
      if (pokemon !== undefined) return setName(pokemon.set, battle);
    }
    return names.size === 1 ? [...names][0]! : name;
  }

  const nameOn = (side: Side, name: string, state: EngineState | null): string => (side === 'p1' ? playerName(name, state) : name);

  function choiceText(state: EngineState, side: Side, choice: Choice): string {
    if (choice.kind === 'item') return `Use ${ITEM_NAMES.get(choice.item) ?? choice.item}`;
    const battle = battleOf(state);
    if (choice.kind === 'switch') {
      const set = battle[side].team[choice.index];
      if (set === undefined) return `Switch to party member ${choice.index + 1}`;
      return `Switch to ${side === 'p2' ? set.name : setName(set, battle)}`;
    }
    const id = requestMoveId(battle, side, choice.slot);
    return `Use ${id === undefined ? `move ${choice.slot + 1}` : moveName(id)}`;
  }

  /** The Pokémon `index` of `side` in the battle at `state`, by name (for a switch target the log no longer shows). */
  function memberName(state: EngineState, side: Side, index: number): string | null {
    const battle = battleOf(state);
    const set = battle[side].team[index];
    if (set === undefined) return null;
    return side === 'p2' ? set.name : setName(set, battle);
  }

  return {
    choice(state, side, choice) {
      const key = `${state.key}|${side}|${JSON.stringify(choice)}`;
      let text = cache.get(key);
      if (text === undefined) {
        text = choiceText(state, side, choice);
        if (cache.size >= CACHE_LIMIT) cache.clear();
        cache.set(key, text);
      }
      return text;
    },

    outcome(outcome) {
      if (outcome.labels.length === 0) return '';
      const reader = new StepReader(outcome, moveName, (side, name) => nameOn(side, name, outcome.state), memberName);
      return `If ${outcome.labels.map((label) => reader.phrase(label)).join(', ')}`;
    },

    killCause(outcome, turn) {
      const log = outcome.log;
      const faintAt = log.findIndex((line) => line.startsWith('|faint|p1'));
      const victims = log.filter((line) => line.startsWith('|faint|p1')).map((line) => playerName(pokemonName(line.split('|')[2] ?? ''), outcome.state));
      const named = victims.length > 0 ? victims : outcome.fainted.p1.map((i) => `party member ${i + 1}`);
      const victimText = named.length > 0 ? named.join(' and ') : 'the active Pokémon';
      const { cause, enemy } = killer(log, faintAt < 0 ? log.length : faintAt, moveName);
      const crit = enemy && outcome.critBy.p2 ? 'enemy crit ' : '';
      return `${crit}${cause} on turn ${turn} kills ${victimText}`;
    },
  };
}

/** "p1a: Fernando" → "Fernando". */
function pokemonName(ident: string): string {
  const colon = ident.indexOf(': ');
  return colon < 0 ? ident : ident.slice(colon + 2);
}

const sideOfIdent = (ident: string): Side | null => (/^p1[a-z]?: /.test(ident) ? 'p1' : /^p2[a-z]?: /.test(ident) ? 'p2' : null);

const other = (side: Side): Side => (side === 'p1' ? 'p2' : 'p1');

/** One line of a step's log as the labeler reads it: its kind, and the side and Pokémon it is about (its first argument). */
interface Line { kind: string; side: Side | null; name: string | null; move: string | null }

/** A hit: the user's side, the move's Showdown ID, and the defender with its HP after. */
interface LoggedHit { side: Side; move: string; target: string; targetSide: Side; hp: number; maxHp: number }

/** Reads one outcome's chance labels in order against its log (see the top of the file). */
class StepReader {
  private readonly lines: Line[];
  private readonly hits: LoggedHit[] = [];
  private readonly drags: Record<Side, string[]> = { p1: [], p2: [] };
  private readonly start: Partial<Record<Side, string>> = {};
  private cursor = 0;
  private readonly rolls = new Map<string, number>();
  private readonly dragsSeen: Record<Side, number> = { p1: 0, p2: 0 };

  constructor(
    private readonly outcome: Outcome,
    private readonly moveName: (id: string) => string,
    private readonly nameOn: (side: Side, name: string) => string,
    private readonly memberName: (state: EngineState, side: Side, index: number) => string | null,
  ) {
    let move: { side: Side; id: string } | null = null;
    const left = new Set<Side>();
    this.lines = outcome.log.map((text) => {
      const parts = text.split('|');
      const kind = parts[1] ?? '';
      const side = sideOfIdent(parts[2] ?? '');
      const name = side === null ? null : pokemonName(parts[2]!);
      if (side !== null && name !== null && this.start[side] === undefined && !left.has(side) && kind !== 'drag' && kind !== 'switch') this.start[side] = name;
      if ((kind === 'switch' || kind === 'drag' || kind === 'replace') && side !== null) {
        left.add(side);
        if (kind === 'drag' && name !== null) this.drags[side].push(name);
        move = null;
      }
      if (kind === 'move' && side !== null) move = { side, id: toID(parts[3] ?? '') };
      if (kind === 'turn' || kind === 'upkeep') move = null;
      if (kind === '-damage' && move !== null && side !== null && !text.includes('[from]')) {
        const hp = /^(\d+)(?:\/(\d+))?/.exec(parts[3] ?? '');
        if (hp !== null) this.hits.push({ side: move.side, move: move.id, target: name!, targetSide: side, hp: Number(hp[1]), maxHp: Number(hp[2] ?? 0) });
      }
      return { kind, side, name, move: kind === 'move' ? toID(parts[3] ?? '') : null };
    });
  }

  /** The Pokémon on `side` when the next chance happened: the subject of the next line on that side, from the cursor. */
  private monAt(side: Side | null): string {
    if (side === null) return 'a Pokémon';
    for (let i = this.cursor; i < this.lines.length; i++) {
      const line = this.lines[i]!;
      if (line.side === side && line.name !== null && line.kind !== 'drag' && line.kind !== 'switch') {
        this.cursor = i;
        return this.nameOn(side, line.name);
      }
    }
    const fallback = this.start[side];
    return fallback === undefined ? (side === 'p2' ? 'the foe' : 'your Pokémon') : this.nameOn(side, fallback);
  }

  /** The Pokémon each side started the step with (a speed tie and Quick Claw happen before anything moves). */
  private startMon(side: Side): string {
    const name = this.start[side];
    return name === undefined ? (side === 'p2' ? 'the foe' : 'your Pokémon') : this.nameOn(side, name);
  }

  /** Moves the cursor to `side`'s use of move `id` (a move's own chances happen at its line or after). */
  private toMove(side: Side | null, id: string): void {
    for (let i = this.cursor; i < this.lines.length; i++) {
      const line = this.lines[i]!;
      if (line.kind === 'move' && line.side === side && line.move === id) {
        this.cursor = i;
        return;
      }
    }
  }

  /** One chance label in words (without the leading "If "). */
  phrase(label: ChanceLabel): string {
    const { kind, side, source, outcome } = label;
    const move = this.moveName(source);
    const moveKinds: ChanceLabel['kind'][] = ['crit', 'hit', 'roll', 'effect', 'multiHit', 'protect', 'switchTarget'];
    if (moveKinds.includes(kind)) this.toMove(side, toID(source));
    switch (kind) {
      case 'crit': return outcome === 'crit' ? `${move} crits` : `${move} doesn't crit`;
      case 'hit': return outcome === 'hit' ? `${move} hits` : outcome === 'miss' ? `${move} misses` : `${move} fails`;
      case 'roll': return this.roll(side, source, move, outcome);
      case 'effect':
      case 'itemProc': {
        const what = kind === 'itemProc' ? itemSource(source) : move;
        if (outcome === 'none') return `${what} has no added effect`;
        const status = STATUS_WORDS[outcome];
        if (status !== undefined) return `${what} ${status[0]}`;
        return `${what} ${statChanges(outcome)}`;
      }
      case 'speedTie': return `${outcome === 'p1First' ? this.startMon('p1') : this.startMon('p2')} moves first (speed tie)`;
      case 'quickClaw': {
        const who = side === null ? 'a Pokémon' : this.startMon(side);
        return outcome === 'activate' ? `${who}'s Quick Claw activates` : `${who}'s Quick Claw doesn't activate`;
      }
      case 'multiHit': return `${move} hits ${outcome} times`;
      case 'sleepWake': return outcome === 'wake' ? `${this.monAt(side)} wakes up` : `${this.monAt(side)} stays asleep`;
      case 'confusionSnap': return outcome === 'snap' ? `${this.monAt(side)} snaps out of confusion` : `${this.monAt(side)} stays confused`;
      case 'selfHit': return outcome === 'selfHit' ? `${this.monAt(side)} hurts itself in confusion` : `${this.monAt(side)} doesn't hurt itself in confusion`;
      case 'fullPara': return outcome === 'fullPara' ? `${this.monAt(side)} is fully paralysed` : `${this.monAt(side)} isn't fully paralysed`;
      case 'thaw': return outcome === 'thaw' ? `${this.monAt(side)} thaws out` : `${this.monAt(side)} stays frozen`;
      case 'infatuation': return outcome === 'immobilised' ? `${this.monAt(side)} is immobilised by love` : `${this.monAt(side)} isn't immobilised by love`;
      case 'durationEnd': return outcome === 'end' ? `${this.monAt(side)}'s ${durationName(source)} ends` : `${this.monAt(side)}'s ${durationName(source)} goes on`;
      case 'protect': return outcome === 'success' ? `${move} works` : `${move} fails`;
      case 'pick': return `${this.moveName(source)} picks ${this.moveName(outcome)}`;
      case 'abilityProc': {
        const who = this.monAt(side);
        return outcome === 'none' ? `${who}'s ${abilitySource(source)} doesn't activate` : `${who}'s ${abilitySource(source)} activates (${statusWord(outcome)})`;
      }
      case 'switchTarget': return `${move} brings in ${this.dragged(side, outcome)}`;
      case 'raw': return `a random draw ${source} gives ${outcome}`;
    }
  }

  /** The roll's hit: the next logged hit by `side` with move `source`, as the HP it leaves (else the roll's value). */
  private roll(side: Side | null, source: string, move: string, outcome: string): string {
    const key = `${side}|${toID(source)}`;
    const seen = this.rolls.get(key) ?? 0;
    this.rolls.set(key, seen + 1);
    const hit = this.hits.filter((h) => h.side === side && h.move === toID(source))[seen];
    // No hit in this step's log (a plan label after an enemy send-in): the label's own value. It is
    // the final damage for a collapsed pick, `≥hp` for the rolls that reach the HP, else the value before STAB.
    if (hit === undefined) return outcome === '≥hp' ? `${move} rolls at least the HP left` : `${move} rolls ${outcome}`;
    const target = this.nameOn(hit.targetSide, hit.target);
    if (hit.hp === 0) return `${move} KOs ${target}`;
    if (hit.targetSide === 'p2' || hit.maxHp === 0) return `${move} leaves ${target} at ${hit.maxHp === 0 ? hit.hp : Math.floor((hit.hp * 100) / hit.maxHp)}%`;
    return `${move} leaves ${target} at ${hit.hp}/${hit.maxHp} HP`;
  }

  /** The Pokémon a Roar or Whirlwind by `side` brought in: the step's next `|drag|` on the other side, else party member `outcome` of the state. */
  private dragged(side: Side | null, outcome: string): string {
    const draggedSide = side === null ? 'p1' : other(side);
    const seen = this.dragsSeen[draggedSide]++;
    const logged = this.drags[draggedSide][seen];
    if (logged !== undefined) return this.nameOn(draggedSide, logged);
    const index = Number(outcome);
    const name = Number.isInteger(index) ? this.memberName(this.outcome.state, draggedSide, index) : null;
    return name ?? `party member ${outcome}`;
  }
}

function statusWord(outcome: string): string {
  return STATUS_WORDS[outcome]?.[1] ?? outcome;
}

/** "atk-1,def-1" → "lowers Attack, Defense"; "self:spe+1" → "raises its Speed". */
function statChanges(outcome: string): string {
  const self = outcome.startsWith('self:');
  const changes = (self ? outcome.slice(5) : outcome).split(',').map((part) => /^([a-z]+)([+-]\d+)$/.exec(part)).filter((m) => m !== null);
  if (changes.length === 0) return `causes ${outcome}`;
  const up = changes.every((m) => Number(m[2]) > 0);
  const stats = changes.map((m) => STAT_WORDS[m[1]!] ?? m[1]!).join(', ');
  return `${up ? 'raises' : 'lowers'} ${self ? 'its ' : ''}${stats}`;
}

const DURATIONS: Record<string, string> = {
  disable: 'Disable', encore: 'Encore', taunt: 'Taunt', uproar: 'Uproar', lockedmove: 'rampage', partiallytrapped: 'binding',
};
const durationName = (source: string) => DURATIONS[source] ?? source;

/** An item source's name ("quickclaw" → "Quick Claw"), or the ID. */
function itemSource(source: string): string {
  return ITEM_NAMES.get(source) ?? source;
}

const ABILITY_NAMES: Record<string, string> = {
  static: 'Static', poisonpoint: 'Poison Point', flamebody: 'Flame Body', effectspore: 'Effect Spore', cutecharm: 'Cute Charm',
  shedskin: 'Shed Skin',
};
const abilitySource = (source: string) => ABILITY_NAMES[source] ?? source;

/** Moves that kill with no `[from]` damage line, by the line that announces them. */
const DELAYED_KILLS: readonly [RegExp, string, boolean][] = [
  [/^\|-end\|p1[a-z]?: [^|]*\|move: Future Sight/, 'Future Sight', true],
  [/^\|-end\|p1[a-z]?: [^|]*\|move: Doom Desire/, 'Doom Desire', true],
  [/^\|-activate\|p2[a-z]?: [^|]*\|move: Destiny Bond/, 'Destiny Bond', false],
  [/^\|-start\|p1[a-z]?: [^|]*\|perish0/, 'Perish Song', false],
];

/**
 * What killed the player's Pokémon whose faint is at line `faintAt`, scanning back from it: a Future Sight, Doom Desire,
 * Destiny Bond or Perish Song announcement; the residual named by a `[from]` damage line to p1; else the last move used
 * (an enemy's, or the player's own: "Selfdestruct (its own)"); else "damage".
 */
function killer(log: readonly string[], faintAt: number, moveName: (id: string) => string): { cause: string; enemy: boolean } {
  for (let i = faintAt - 1; i >= 0; i--) {
    const line = log[i]!;
    const delayed = DELAYED_KILLS.find(([re]) => re.test(line));
    if (delayed !== undefined) return { cause: delayed[1], enemy: delayed[2] };
    const parts = line.split('|');
    if (parts[1] === '-damage' && (parts[2] ?? '').startsWith('p1')) {
      const from = parts.find((p) => p.startsWith('[from]'));
      if (from !== undefined) {
        const id = toID(from.slice('[from]'.length).replace(/^ ?(item|ability|move): ?/i, ''));
        return { cause: RESIDUAL_CAUSES[id] ?? moveName(id), enemy: false };
      }
    }
    if (parts[1] === 'move') {
      const name = moveName(toID(parts[3] ?? 'a move'));
      return (parts[2] ?? '').startsWith('p2') ? { cause: name, enemy: true } : { cause: `${name} (its own)`, enemy: false };
    }
  }
  return { cause: 'damage', enemy: false };
}
