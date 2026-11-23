// `npx tsx src/ai/diff/cli.ts`: diffs the hack's trainer AI (its script and the rest of overlay 14), overlay 16 (by
// halfword alignment, and function by function: handlerSection.ts), the other binaries around the battle code and the
// move data the AI reads against vanilla US Platinum, and rewrites the generated blocks of docs/ai-changes.md. The paths
// come from PK_ROM, PK_VANILLA_ROM and POKEPLATINUM (the pret/pokeplatinum clone, with `src` in its sparse checkout),
// with the same defaults as the real-data checks; the docs' move names come from the docs tabs `npm run extract` saved
// in DATA_DIR/docs (default `data/docs`).

import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadDocs } from '../../data/load.js';
import { buildNameIndex, type NameIndex } from '../../names/nameIndex.js';
import { normaliseName } from '../../names/normalise.js';
import { readNarc } from '../../nds/narc.js';
import { readNdsFiles } from '../../nds/ndsFs.js';
import { readOverlay, readOverlayTable } from '../../nds/overlay.js';
import { decodeMove } from '../../rom/moves.js';
import type { MoveRecord } from '../../rom/types.js';
import { type AiScript, extractAiScript } from '../rom/script.js';
import { reachable } from '../script/disasm.js';
import { OPCODES } from '../script/opcodes.js';
import { labelsFromSource } from './labels.js';
import { generateHandlerBlock, HANDLER_BLOCK } from './handlerSection.js';
import { ALT_POWER_EFFECTS, NO_DAMAGE_CALC_EFFECTS } from '../lib/damage.js';
import {
  damageScoringNote, diffMoveEffects, diffMoveFields, MOVE_FIELDS, type MoveField, type MoveFieldChange,
} from './moveDiff.js';
import {
  aiFunctionNames, type AlignedRegion, alignHalfwords, type CodeImage, diffOverlay, explainRegion, findCommandTable,
  type Relocation,
} from './overlayDiff.js';
import { type ConstantKind, type ConstantNames, diffScripts, FLAG_NAMES, type ScriptChange } from './scriptDiff.js';

export const AI_CHANGES_DOC = join('docs', 'ai-changes.md');
/** In the pret/pokeplatinum clone. */
export const SCRIPT_S = join('src', 'battle', 'trainer_ai', 'script.s');
const TRAINER_AI_C = join('src', 'battle', 'trainer_ai', 'trainer_ai.c');
/**
 * The decompilation's enum lists. Their headers are generated at build time (metang, generated/meson.build), so the
 * values come from the lists: each constant's value is its 0-based line number.
 */
const ENUM_LISTS: Record<ConstantKind, string> = {
  move: 'generated/moves.txt',
  effect: 'generated/move_battle_effects.txt',
  ability: 'generated/abilities.txt',
  item: 'generated/items.txt',
  type: 'generated/pokemon_types.txt',
};

/** The move-data block's name: it sits between `<!-- generated:moves -->` and `<!-- /generated:moves -->`. */
export const MOVE_BLOCK = 'moves';
/** Each move field's column heading. In a sentence it is lower-cased, unless it is an acronym (PP). */
const FIELD_HEADINGS: Record<MoveField, string> = { power: 'Power', type: 'Type', class: 'Class', accuracy: 'Accuracy', pp: 'PP', priority: 'Priority' };
const fieldWord = (field: MoveField) => (/^[A-Z]+$/.test(FIELD_HEADINGS[field]) ? FIELD_HEADINGS[field] : FIELD_HEADINGS[field].toLowerCase());
const AI_OVERLAY = 14;
const BATTLE_OVERLAY = 16;
const MOVES_NARC = 'poketool/waza/pl_waza_tbl.narc';
/** The flags with routines; bits 11–28 are unused (script.s:30–47). */
const USED_BITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 29, 30, 31];
const UNUSED_BITS = { first: 11, last: 28 };

/** The moves the docs' AI Changes tab names, by ROM ID, with the docs' names (the Moves tab, 2026-11-08). */
const TAB_MOVES = new Map<number, string>([
  [36, 'Take Down'], [63, 'Hyper Beam'], [87, 'Thunder'], [140, 'Hurricane'], [149, 'Triple Axel'], [167, 'Triple Kick'],
  [210, 'Fury Cutter'], [370, 'Close Combat'], [413, 'Brave Bird'], [416, 'Giga Impact'], [434, 'Draco Meteor'],
  [439, 'Rock Wrecker'], [457, 'Head Smash'],
]);

/** What each known script change means, keyed by meaningKey. A change without one says so in the doc. */
const MEANINGS = new Map<string, string>([
  [
    meaningKey('Basic_CheckForImmunity', ['IfLoadedEqualTo ABILITY_LEVITATE, Basic_CheckWaterAbsorption2'], ['IfLoadedEqualTo ABILITY_DRY_SKIN, Basic_CheckWaterAbsorption2']),
    'The Dry Skin fix. Vanilla tests Levitate twice (script.s:78), so this branch never runs. In the hack, a Water-type move '
      + 'that the AI damage-scores gets −12 when the AI takes the target\'s ability to be Dry Skin, as with Water Absorb. '
      + 'A Mold Breaker attacker skips the check.',
  ],
]);

function meaningKey(vanillaLabel: string | null, vanilla: string[], hack: string[]): string {
  return [vanillaLabel ?? '', ...vanilla, '→', ...hack].join('\n');
}

export interface DiffInputs { hackRom: Uint8Array; vanillaRom: Uint8Array; decompDir: string }

/** The generated block of docs/ai-changes.md, without its markers. */
export function generateBlock({ hackRom, vanillaRom, decompDir }: DiffInputs): string {
  const vanillaScript = extractAiScript(vanillaRom);
  const hackScript = extractAiScript(hackRom);
  const vanilla14 = overlayImage(vanillaRom, AI_OVERLAY);
  const hack14 = overlayImage(hackRom, AI_OVERLAY);
  const vanilla16 = overlayImage(vanillaRom, BATTLE_OVERLAY);
  const hack16 = overlayImage(hackRom, BATTLE_OVERLAY);
  const scriptOffset = scriptOffsetIn(vanilla14.bytes, vanillaScript);
  if (scriptOffsetIn(hack14.bytes, hackScript) !== scriptOffset) throw new Error('the two scripts start at different overlay 14 offsets');

  const names = constantNames(decompDir);
  const labels = labelsFromSource(readFileSync(join(decompDir, SCRIPT_S), 'utf8'), vanillaScript);
  const changes = diffScripts(vanillaScript, hackScript, labels, names);

  const alignment = alignHalfwords(vanilla16.bytes, hack16.bytes);
  const toHack = (address: number) => {
    const offset = address - vanilla16.base;
    if (offset < 0 || offset >= vanilla16.bytes.length) return address;
    const mapped = alignment.toHack(offset);
    return mapped === null ? null : hack16.base + mapped;
  };

  return [
    '_Written by `npx tsx src/ai/diff/cli.ts` from the two ROMs and the decompilation. Do not edit by hand._',
    '',
    ...scriptSection(vanillaScript, hackScript, scriptOffset, changes),
    ...effectsSection(vanillaRom, hackRom, names),
    ...overlay14Section(vanilla14, hack14, vanilla16, scriptOffset, readFileSync(join(decompDir, TRAINER_AI_C), 'utf8'), toHack),
    ...overlay16Section(vanilla16, hack16, alignment.regions, toHack),
  ].join('\n');
}

/** Everything the move-data block needs: the inputs above, plus the docs' Moves tab names. */
export interface MoveBlockInputs extends DiffInputs { names: Pick<NameIndex, 'move'> }

/**
 * The move-data block of docs/ai-changes.md, without its markers: every move whose effect ID differs, with the hack
 * script's routines for each side's effect, then every move whose power, type, class, accuracy, PP or priority differs.
 * Moves are named by the docs' Moves tab.
 */
export function generateMoveBlock({ hackRom, vanillaRom, decompDir, names }: MoveBlockInputs): string {
  const vanillaScript = extractAiScript(vanillaRom);
  const hackScript = extractAiScript(hackRom);
  // script.s lines up with vanilla's words. Its labels name the hack's routines only where the hack's code sits at
  // the same words, as it does: the hack changes one argument word (generateBlock's script diff).
  if (!sameLayout(vanillaScript, hackScript)) throw new Error('the hack\'s AI script has moved code, so script.s\'s labels cannot name its routines');
  const labels = labelsFromSource(readFileSync(join(decompDir, SCRIPT_S), 'utf8'), vanillaScript);
  const constants = constantNames(decompDir);
  const vanillaMoves = moveTable(vanillaRom);
  const hackMoves = moveTable(hackRom);
  // Move 0 is no move: the Moves tab writes its row as "-", and the name index leaves it out.
  const docsNames: ConstantNames = { ...constants, move: hackMoves.map((_, id) => (id === 0 ? '-' : names.move(id))) };
  checkDamageCalcLists(vanillaRom, hackRom);
  const effects = diffMoveEffects(vanillaMoves, hackMoves, hackScript, labels, docsNames);
  const fields = diffMoveFields(vanillaMoves, hackMoves, docsNames);
  const moveCell = (id: number, name: string) => withVanillaName(name, constants.move?.[id]);
  const routineCell = (routines: string[]) => (routines.length === 0 ? 'none' : routines.map((routine) => `\`${routine}\``).join('<br>'));

  const byMove = new Map<number, MoveFieldChange[]>();
  for (const change of fields) byMove.set(change.move, [...(byMove.get(change.move) ?? []), change]);
  const fieldCount = (field: MoveField) => fields.filter((change) => change.field === field).length;

  return [
    '_Written by `npx tsx src/ai/diff/cli.ts` from the two ROMs, the decompilation and the docs\' Moves tab. Do not edit by hand._',
    '',
    '### Effects',
    '',
    `${effects.length} of the ${hackMoves.length} move records have a different effect ID in the hack. Each AI routine is a test `
      + 'of that effect in the hack\'s script: `Label → Target` where a move with the effect jumps to Target, and `Label` where '
      + 'it carries on past the test. Label is the nearest script.s label before the test. "none" means no routine tests the effect.',
    '',
    '| ID | Move | Vanilla effect | Its AI routines | Hack effect | Its AI routines | Damage scoring |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...effects.map((change) => `| ${change.move} | ${moveCell(change.move, change.name)} `
      + `| ${change.vanillaEffectName} (${change.vanillaEffect}) | ${routineCell(change.vanillaRoutines)} `
      + `| ${change.hackEffectName} (${change.hackEffect}) | ${routineCell(change.hackRoutines)} | ${change.damageScoring ?? ''} |`),
    '',
    '### Power, type, class, accuracy, PP and priority',
    '',
    `${byMove.size} moves differ in at least one of these fields: `
      + `${MOVE_FIELDS.map((field) => `${fieldWord(field)} ${fieldCount(field)}`).join(', ')}. `
      + 'A blank cell is unchanged.',
    '',
    `| ID | Move | ${MOVE_FIELDS.map((field) => FIELD_HEADINGS[field]).join(' | ')} | Damage scoring |`,
    `| --- | --- | ${MOVE_FIELDS.map(() => '---').join(' | ')} | --- |`,
    ...[...byMove].map(([id, changes]) => {
      const cells = MOVE_FIELDS.map((field) => {
        const change = changes.find((candidate) => candidate.field === field);
        return change === undefined ? '' : `${change.vanilla} → ${change.hack}`;
      });
      const note = damageScoringNote(vanillaMoves[id]!, hackMoves[id]!) ?? '';
      return `| ${id} | ${moveCell(id, changes[0]!.name)} | ${cells.join(' | ')} | ${note} |`;
    }),
    '',
  ].join('\n');
}

/**
 * Checks that both ROMs hold the AI port's damage-estimate effect lists (NO_DAMAGE_CALC_EFFECTS and ALT_POWER_EFFECTS,
 * src/ai/lib/damage.ts), which isDamageEstimated and so the damage-scoring notes read: each list, ended by 0xFFFF
 * (trainer_ai.c:31–61), at one u16-aligned offset of overlay 14, the same offset in both. AiRomData doesn't carry
 * these lists.
 */
function checkDamageCalcLists(vanillaRom: Uint8Array, hackRom: Uint8Array): void {
  const lists: [string, readonly number[]][] = [['sNoDamageCalcMoveEffects', NO_DAMAGE_CALC_EFFECTS], ['sAltPowerMoveEffects', ALT_POWER_EFFECTS]];
  for (const [name, effects] of lists) {
    const vanilla = u16RunOffsets(readOverlay(vanillaRom, AI_OVERLAY), [...effects, 0xffff]);
    const hack = u16RunOffsets(readOverlay(hackRom, AI_OVERLAY), [...effects, 0xffff]);
    if (vanilla.length !== 1 || hack.length !== 1 || vanilla[0] !== hack[0]) {
      throw new Error(`overlay 14 doesn't hold the AI port's ${name} list once at one offset in both ROMs `
        + `(vanilla at ${vanilla.join(', ') || 'none'}, hack at ${hack.join(', ') || 'none'})`);
    }
  }
}

/** The u16-aligned offsets of `bytes` where the little-endian u16s `values` start. */
function u16RunOffsets(bytes: Uint8Array, values: number[]): number[] {
  const hits: number[] = [];
  for (let at = 0; at + values.length * 2 <= bytes.length; at += 2) {
    if (values.every((value, k) => (bytes[at + 2 * k]! | (bytes[at + 2 * k + 1]! << 8)) === value)) hits.push(at);
  }
  return hits;
}

/**
 * The docs' name of a move, followed by vanilla's name where the hack gave the ID to another move ("Hurricane (vanilla
 * Barrage)"). `constant` is the decompilation's MOVE_* name for the ID; IDs past vanilla's last move have none.
 */
function withVanillaName(name: string, constant: string | undefined): string {
  if (constant === undefined || !constant.startsWith('MOVE_') || constant === 'MOVE_NONE') return name;
  const words = constant.slice('MOVE_'.length).toLowerCase().split('_');
  const vanilla = words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
  return normaliseName(vanilla) === normaliseName(name) ? name : `${name} (vanilla ${vanilla})`;
}

/**
 * Whether the two scripts reach the same instructions at the same words from every flag, with the same opcodes and the
 * same jump and table targets, so that a label at a vanilla word names the same routine in the hack.
 */
function sameLayout(vanilla: AiScript, hack: AiScript): boolean {
  const bits = FLAG_NAMES.map((_, bit) => bit);
  const vanillaCode = reachable(vanilla, bits);
  const hackCode = reachable(hack, bits);
  if (vanillaCode.size !== hackCode.size || vanilla.flagEntries.some((entry, bit) => entry !== hack.flagEntries[bit])) return false;
  return [...vanillaCode].every(([at, instr]) => {
    const other = hackCode.get(at);
    return other !== undefined && other.op.code === instr.op.code && other.targets.every((target, k) => target === instr.targets[k]);
  });
}

/** The text between the generated markers of `doc`: `<!-- generated -->`, or `<!-- generated:<name> -->` for a named block. */
export function readGenerated(doc: string, name?: string): string {
  const { start, end } = markers(doc, name);
  return doc.slice(start, end);
}

/** `doc` with the text between its generated markers (as for readGenerated) replaced by `block`. */
export function writeGenerated(doc: string, block: string, name?: string): string {
  const { start, end } = markers(doc, name);
  return doc.slice(0, start) + block + doc.slice(end);
}

function markers(doc: string, name?: string): { start: number; end: number } {
  const suffix = name === undefined ? '' : `:${name}`;
  const open = `<!-- generated${suffix} -->`;
  const close = `<!-- /generated${suffix} -->`;
  const at = doc.indexOf(open);
  const end = doc.indexOf(close);
  if (at < 0 || end < at) throw new Error(`expected ${open} … ${close} in ${AI_CHANGES_DOC}`);
  return { start: at + open.length + 1, end };
}

function scriptSection(vanilla: AiScript, hack: AiScript, scriptOffset: number, changes: ScriptChange[]): string[] {
  const lines = [
    '### Script changes by flag',
    '',
    `Both scripts start at overlay 14 offset 0x${hex(scriptOffset, 4)}. From flags 0–10 and 29–31, vanilla reaches `
      + `${reachable(vanilla, USED_BITS).size} instructions and the hack ${reachable(hack, USED_BITS).size}.`,
    '',
  ];
  const section = (bit: number) => {
    const own = changes.filter((change) => change.flag === FLAG_NAMES[bit]);
    lines.push(`#### ${FLAG_NAMES[bit]} (bit ${bit})`, '');
    if (own.length === 0) {
      lines.push('No change.', '');
      return;
    }
    lines.push('| Vanilla label | Vanilla | Hack | Meaning |', '| --- | --- | --- | --- |');
    for (const change of own) {
      const meaning = MEANINGS.get(meaningKey(change.vanillaLabel, change.vanilla, change.hack))
        ?? 'Not explained yet: add a line to MEANINGS in src/ai/diff/cli.ts.';
      lines.push(`| ${change.vanillaLabel === null ? '(none)' : `\`${change.vanillaLabel}\``} | ${cell(change.vanilla)} | ${cell(change.hack)} | ${meaning} |`);
    }
    lines.push('');
  };
  for (const bit of USED_BITS.filter((bit) => bit < UNUSED_BITS.first)) section(bit);
  const unused = Array.from({ length: UNUSED_BITS.last - UNUSED_BITS.first + 1 }, (_, i) => UNUSED_BITS.first + i);
  const changedUnused = unused.filter((bit) => changes.some((change) => change.flag === FLAG_NAMES[bit]));
  if (changedUnused.length === 0) lines.push(`Bits ${UNUSED_BITS.first}–${UNUSED_BITS.last} (unused): no change.`, '');
  for (const bit of changedUnused) section(bit);
  for (const bit of USED_BITS.filter((bit) => bit > UNUSED_BITS.last)) section(bit);
  return lines;
}

/** Rendered instructions for a table cell. */
function cell(instrs: string[]): string {
  return instrs.length === 0 ? '(none)' : instrs.map((instr) => `\`${instr}\``).join('<br>');
}

/** The move effects the AI Changes tab's items rest on: every move that has, in the hack, the effect of a move the tab names. */
function effectsSection(vanillaRom: Uint8Array, hackRom: Uint8Array, names: ConstantNames): string[] {
  const vanillaMoves = moveTable(vanillaRom);
  const hackMoves = moveTable(hackRom);
  const effects = new Set([...TAB_MOVES.keys()].map((id) => hackMoves[id]!.effect));
  const rows = hackMoves.filter((move) => effects.has(move.effect)).sort((a, b) => a.effect - b.effect || a.id - b.id);
  const effect = (value: number) => `${names.effect?.[value] ?? '?'} (${value})`;
  return [
    '### Move effects behind the AI Changes tab',
    '',
    'Every move that has, in the hack, the effect of a move the tab names. The script picks routines by effect.',
    '',
    '| ID | Vanilla move | Name in the tab | Vanilla effect | Hack effect |',
    '| --- | --- | --- | --- | --- |',
    ...rows.map((move) => {
      const before = vanillaMoves[move.id]!.effect;
      const after = before === move.effect ? 'same' : effect(move.effect);
      return `| ${move.id} | ${names.move?.[move.id] ?? '?'} | ${TAB_MOVES.get(move.id) ?? ''} | ${effect(before)} | ${after} |`;
    }),
    '',
  ];
}

function overlay14Section(
  vanilla: CodeImage, hack: CodeImage, vanilla16: CodeImage, scriptOffset: number, trainerAiC: string,
  toHack: (address: number) => number | null,
): string[] {
  const table = findCommandTable(vanilla.bytes, vanilla.base);
  const tableSize = 4 * OPCODES.length;
  if (!sameBytes(vanilla.bytes.subarray(table, table + tableSize), hack.bytes.subarray(table, table + tableSize))) {
    throw new Error('the hack\'s sAICommandTable differs from vanilla\'s');
  }
  const names = aiFunctionNames(vanilla.bytes, vanilla.base, trainerAiC, scriptOffset);
  const regions = diffOverlay(vanilla.bytes, hack.bytes, names);
  const outside = regions.filter((region) => !region.inScript);
  const byFunction = new Map<string, { offsets: number[]; relocations: Relocation[]; other: string[] }>();
  for (const region of outside) {
    const entry = byFunction.get(region.fn ?? '(none)') ?? { offsets: [], relocations: [], other: [] };
    byFunction.set(region.fn ?? '(none)', entry);
    entry.offsets.push(region.start);
    const even = { vanillaStart: region.start & ~1, vanillaEnd: (region.end + 1) & ~1, hackStart: region.start & ~1, hackEnd: (region.end + 1) & ~1 };
    const relocations = explainRegion(vanilla, hack, even, toHack);
    if (relocations === null) entry.other.push(`${bytesHex(vanilla.bytes, even.vanillaStart, even.vanillaEnd)} → ${bytesHex(hack.bytes, even.hackStart, even.hackEnd)}`);
    else entry.relocations.push(...relocations);
  }
  const unexplained = [...byFunction.values()].reduce((sum, entry) => sum + entry.other.length, 0);
  return [
    '### Overlay 14 outside the script',
    '',
    `Overlay 14 is ${vanilla.bytes.length.toLocaleString('en-US')} bytes in both ROMs, loaded at 0x${hex(vanilla.base, 8)}. `
      + `sAICommandTable is at offset 0x${hex(table, 4)} in both, with the same 109 handler pointers. `
      + `Outside the script, ${outside.length} regions differ, in ${byFunction.size} functions; `
      + `${unexplained === 0 ? 'every one is a relocation' : `${outside.length - unexplained} are relocations`}. `
      + `${regions.length - outside.length} more ${regions.length - outside.length === 1 ? 'region is' : 'regions are'} inside the script.`,
    '',
    '| Function | Offsets | What changed |',
    '| --- | --- | --- |',
    ...[...byFunction].map(([fn, entry]) => {
      const what = [...describeRelocations(entry.relocations, vanilla16), ...entry.other.map((change) => `not a relocation: ${change}`)];
      return `| \`${fn}\` | ${entry.offsets.map((offset) => `0x${hex(offset, 4)}`).join(', ')} | ${what.join('; ')} |`;
    }),
    '',
  ];
}

function overlay16Section(vanilla: CodeImage, hack: CodeImage, regions: AlignedRegion[], toHack: (address: number) => number | null): string[] {
  const counts = { bl: 0, branch: 0, literal: 0, pointer: 0 };
  const other: AlignedRegion[] = [];
  for (const region of regions) {
    const relocations = explainRegion(vanilla, hack, region, toHack);
    if (relocations === null) other.push(region);
    else relocations.forEach((relocation) => counts[relocation.kind]++);
  }
  const size = (start: number, end: number) => String(end - start);
  return [
    '### Overlay 16',
    '',
    `Overlay 16 is ${vanilla.bytes.length.toLocaleString('en-US')} bytes in vanilla and ${hack.bytes.length.toLocaleString('en-US')} `
      + `in the hack, loaded at 0x${hex(vanilla.base, 8)} in both. The halfword alignment finds ${regions.length} changed regions. `
      + `${regions.length - other.length} of them are relocations: an instruction or word that still refers to the same code or `
      + `data, which moved (${counts.bl} BLs, ${counts.branch} branches, ${counts.literal} PC-relative loads, ${counts.pointer} pointers). `
      + `The other ${other.length}:`,
    '',
    '| Vanilla offset | Vanilla bytes | Hack offset | Hack bytes |',
    '| --- | --- | --- | --- |',
    ...other.map((region) => `| 0x${hex(region.vanillaStart, 5)} | ${size(region.vanillaStart, region.vanillaEnd)} `
      + `| 0x${hex(region.hackStart, 5)} | ${size(region.hackStart, region.hackEnd)} |`),
    '',
  ];
}

/** Relocations grouped by kind, where the target lies and how far it moved, such as "BL into overlay 16, +8 (×2)". */
function describeRelocations(relocations: Relocation[], overlay16: CodeImage): string[] {
  const groups = new Map<string, number>();
  for (const relocation of relocations) {
    const into16 = relocation.vanillaTarget >= overlay16.base && relocation.vanillaTarget < overlay16.base + overlay16.bytes.length;
    const where = into16 ? 'into overlay 16' : `to 0x${hex(relocation.vanillaTarget, 8)}`;
    const delta = relocation.hackTarget - relocation.vanillaTarget;
    const key = `${relocation.kind === 'bl' ? 'BL' : relocation.kind} ${where}, ${delta >= 0 ? '+' : ''}${delta}`;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  return [...groups].map(([key, count]) => `${key} (×${count})`);
}

function overlayImage(rom: Uint8Array, id: number): CodeImage {
  const entry = readOverlayTable(rom).find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`the ROM has no overlay ${id}`);
  return { bytes: readOverlay(rom, id), base: entry.ramAddress };
}

/** Where the script's flag table sits in its overlay: the one offset holding its first 32 words. */
function scriptOffsetIn(overlay: Uint8Array, script: AiScript): number {
  const view = new DataView(overlay.buffer, overlay.byteOffset, overlay.byteLength);
  const hits: number[] = [];
  for (let offset = 0; offset + 128 <= overlay.length; offset += 4) {
    let k = 0;
    while (k < 32 && view.getInt32(offset + k * 4, true) === script.words[k]) k++;
    if (k === 32) hits.push(offset);
  }
  if (hits.length !== 1) throw new Error(`expected the AI flag table once in overlay ${AI_OVERLAY}, found it ${hits.length} times`);
  return hits[0]!;
}

function constantNames(decompDir: string): ConstantNames {
  const names: ConstantNames = {};
  for (const [kind, file] of Object.entries(ENUM_LISTS) as [ConstantKind, string][]) {
    names[kind] = readFileSync(join(decompDir, file), 'utf8').split('\n').map((line) => line.trim()).filter((line) => line !== '');
  }
  return names;
}

/** The ROM's move records, decoded from poketool/waza/pl_waza_tbl.narc, indexed by move ID. */
export function moveTable(rom: Uint8Array): MoveRecord[] {
  const narc = readNdsFiles(rom).get(MOVES_NARC);
  if (narc === undefined) throw new Error(`the ROM has no ${MOVES_NARC}`);
  return readNarc(narc).map((record, id) => decodeMove(id, record));
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

function bytesHex(bytes: Uint8Array, start: number, end: number): string {
  return Array.from(bytes.subarray(start, end), (byte) => byte.toString(16).padStart(2, '0')).join(' ');
}

function hex(value: number, digits: number): string {
  return value.toString(16).toUpperCase().padStart(digits, '0');
}

function main(): void {
  const hackRom = readFileSync(process.env.PK_ROM || 'data/roms/plat-kaizo-nightmare-update-final.nds');
  const vanillaRom = readFileSync(process.env.PK_VANILLA_ROM
    || 'data/roms/pokemon-platinum-us.nds');
  const decompDir = process.env.POKEPLATINUM || join(homedir(), 'src', 'pokeplatinum');
  const names = buildNameIndex(loadDocs(join(process.env.DATA_DIR || 'data', 'docs')));
  const block = generateBlock({ hackRom, vanillaRom, decompDir });
  const moveBlock = generateMoveBlock({ hackRom, vanillaRom, decompDir, names });
  const handlerBlock = generateHandlerBlock({ hackRom, vanillaRom, decompDir });
  const doc = writeGenerated(
    writeGenerated(writeGenerated(readFileSync(AI_CHANGES_DOC, 'utf8'), block), moveBlock, MOVE_BLOCK), handlerBlock, HANDLER_BLOCK,
  );
  writeFileSync(AI_CHANGES_DOC, doc);
  console.log(`Rewrote the generated blocks of ${AI_CHANGES_DOC}.`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main();
