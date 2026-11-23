// Real-data check: the hack's item records and item ID mapping, its type chart (against vanilla's), its Pokédex weights
// (against Showdown's and vanilla's), the trainer-ai.json cache, and the items the switch-in step acts on (against
// vanilla's, which the engine models: switchIn.ts).

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import PS from 'pokemon-showdown';
import { beforeAll, describe, expect, it } from 'vitest';
import { aiScriptOf, extractAiData, loadAiData, writeAiData } from '../../src/ai/rom/aiData.js';
import { type AiItemRecord, decodeItems, itemDataIndices, readArm9 } from '../../src/ai/rom/items.js';
import { extractAiScript } from '../../src/ai/rom/script.js';
import { extractTypeChart, type TypeChart } from '../../src/ai/rom/typeChart.js';
import { decodeWeights } from '../../src/rom/weights.js';
import { scriptId } from '../../src/ai/script/disasm.js';
import { ENTRY_HOLD_EFFECTS, HACK_PINCH_ZERO_ITEMS, VANILLA_ENTRY_ITEMS } from '../../src/ai/switchIn.js';
import { readNdsFiles } from '../../src/nds/ndsFs.js';
import { needFiles, PK_ROM, PK_VANILLA_ROM } from './env.js';


// generated/items.txt (line = ID + 1) and generated/item_hold_effects.txt:70.
const ITEM_LEFTOVERS = 234;
const ITEM_SILK_SCARF = 251;
const ITEM_SECRET_KEY = 467;
const HOLD_EFFECT_HP_RESTORE_GRADUAL = 69;
// generated/pokemon_types.txt.
const TYPE_NORMAL = 0;
const TYPE_GHOST = 7;
const FORESIGHT_SEPARATOR = 0xfe;
// generated/species.txt (line = ID + 1).
const SPECIES_ONIX = 95;
const SPECIES_GARCHOMP = 445;
const SPECIES_GIRATINA = 487;
const LAST_SPECIES = 493;

const suite = needFiles("the hack's AI ROM data", { PK_ROM });

describe.skipIf(suite.skip)(suite.title, () => {
  let rom: Uint8Array;
  let arm9: Uint8Array;
  let items: (AiItemRecord | null)[];
  let chart: TypeChart;

  beforeAll(() => {
    rom = readFileSync(PK_ROM);
    arm9 = readArm9(rom);
    items = decodeItems(readNdsFiles(rom), arm9);
    chart = extractTypeChart(rom);
  });

  it('item 234 (Leftovers) has the Leftovers hold effect', () => {
    expect(items[ITEM_LEFTOVERS]?.id).toBe(ITEM_LEFTOVERS);
    expect(items[ITEM_LEFTOVERS]?.holdEffect).toBe(HOLD_EFFECT_HP_RESTORE_GRADUAL);
  });

  it('Silk Scarf (251) maps to data index 229', () => {
    expect(itemDataIndices(arm9)[ITEM_SILK_SCARF]).toBe(229);
  });

  it('only the Secret Key (467), whose record lies past the battle item table, is null', () => {
    expect(items.flatMap((item, id) => (item === null ? [id] : []))).toEqual([ITEM_SECRET_KEY]);
  });

  it("the hack's type chart has a Normal-vs-Ghost entry after the separator", () => {
    const separator = chart.findIndex(([attacking]) => attacking === FORESIGHT_SEPARATOR);
    expect(separator).toBeGreaterThan(0);
    expect(chart.slice(separator + 1).some(([attacking, defending]) => attacking === TYPE_NORMAL && defending === TYPE_GHOST)).toBe(true);
  });

  it("the hack's Pokédex weights: Onix and Garchomp, and Giratina's two forms", () => {
    const files = readNdsFiles(rom);
    const weights = decodeWeights(files);
    const formWeights = decodeWeights(files, 1);
    // One entry per species ID 0–493.
    expect(weights).toHaveLength(LAST_SPECIES + 1);
    expect(formWeights).toHaveLength(LAST_SPECIES + 1);
    // Gen 4's Pokédex: Onix 210.0 kg, Garchomp 95.0 kg.
    expect(weights[SPECIES_ONIX]).toBe(2100);
    expect(weights[SPECIES_GARCHOMP]).toBe(950);
    // Form 0 reads zukan_data_gira.narc, any other form zukan_data.narc (pokedex_data_index.c:14–25): Giratina's
    // Altered 750.0 kg against its Origin 650.0 kg, the tables' one difference.
    expect(weights[SPECIES_GIRATINA]).toBe(7500);
    expect(formWeights[SPECIES_GIRATINA]).toBe(6500);
    expect(weights.flatMap((weight, species) => (weight === formWeights[species] ? [] : [species]))).toEqual([SPECIES_GIRATINA]);
  });

  it("prints where the hack's Pokédex weights differ from Showdown's Gen 4 weightkg × 10", () => {
    const files = readNdsFiles(rom);
    const tables = { form0: decodeWeights(files), otherForms: decodeWeights(files, 1) };
    const differences: string[] = [];
    let compared = 0;
    for (const species of PS.Dex.mod('gen4').species.all()) {
      if (species.num < 1 || species.num > LAST_SPECIES || species.gen > 4) continue;
      // A base species is form 0; a forme is a form other than 0 (its battle weight is still the species' entry).
      const table = species.forme === '' ? tables.form0 : tables.otherForms;
      const showdown = Math.round(species.weightkg * 10);
      compared++;
      if (table[species.num] !== showdown) differences.push(`${species.name} (${species.num}): ROM ${table[species.num]}, Showdown ${showdown}`);
    }
    console.log(differences.length === 0
      ? `The hack's Pokédex weights equal Showdown's for all ${compared} Gen 4 species and formes.`
      : `The hack's Pokédex weights differ from Showdown's for ${differences.length} of ${compared} species and formes (hectograms): ${differences.join('; ')}.`);
    expect(compared).toBeGreaterThan(LAST_SPECIES);
  });

  it('trainer-ai.json round-trips, and aiScriptOf gives back the script', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-rom-'));
    try {
      writeAiData(rom, dir);
      const loaded = loadAiData(dir);
      expect(loaded).toEqual(extractAiData(rom));
      const script = aiScriptOf(loaded);
      const extracted = extractAiScript(rom);
      expect(script.words).toEqual(extracted.words);
      expect(script.flagEntries).toEqual(extracted.flagEntries);
      expect(script.sha256).toBe(extracted.sha256);
      expect(scriptId(script)).toBe(script.sha256);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

const vanillaSuite = needFiles("the hack's type chart, Pokédex weights and switch-in items against vanilla's", { PK_ROM, PK_VANILLA_ROM });

describe.skipIf(vanillaSuite.skip)(vanillaSuite.title, () => {
  it('prints whether the chart equals vanilla', () => {
    const hack = extractTypeChart(readFileSync(PK_ROM));
    const vanilla = extractTypeChart(readFileSync(PK_VANILLA_ROM));
    const key = (triple: readonly number[]) => triple.join(',');
    // The order matters: the C applies each matching entry in turn, truncating each time (battle_lib.c:2612).
    if (hack.map(key).join(' ') === vanilla.map(key).join(' ')) {
      console.log(`The hack's type chart equals vanilla's (${hack.length} triples, separator included).`);
    } else {
      const added = hack.flatMap((triple, i) => (vanilla.some((other) => key(other) === key(triple)) ? [] : [`#${i} [${key(triple)}]`]));
      const removed = vanilla.flatMap((triple, i) => (hack.some((other) => key(other) === key(triple)) ? [] : [`#${i} [${key(triple)}]`]));
      console.log(
        `The hack's type chart differs from vanilla's (${hack.length} vs ${vanilla.length} triples).` +
          ` Only in the hack: ${added.join(' ') || 'none'}. Only in vanilla: ${removed.join(' ') || 'none (same entries, other order)'}.`,
      );
    }
    expect(hack.length).toBeGreaterThan(0);
  });

  it("switchIn.ts's VANILLA_ENTRY_ITEMS is every vanilla item the switch-in item step acts on; prints the hack's changes", () => {
    // BattleSystem_TriggerHeldItemOnStatus acts on ENTRY_HOLD_EFFECTS (battle_lib.c:4974–5297); the engine's items are
    // Showdown's Gen 4 ones, which are vanilla's.
    const decode = (path: string) => {
      const rom = readFileSync(path);
      return decodeItems(readNdsFiles(rom), readArm9(rom));
    };
    const entries = (items: (AiItemRecord | null)[]) => items.flatMap((item, id) => (
      item !== null && ENTRY_HOLD_EFFECTS.has(item.holdEffect) ? [[id, { effect: item.holdEffect, param: item.holdParam }] as const] : []));
    expect(entries(decode(PK_VANILLA_ROM))).toEqual([...VANILLA_ENTRY_ITEMS]);
    const hack = new Map(entries(decode(PK_ROM)));
    const ids = [...new Set([...hack.keys(), ...VANILLA_ENTRY_ITEMS.keys()])].sort((a, b) => a - b);
    const show = (record: { effect: number; param: number } | undefined) => (record === undefined ? 'none' : `${record.effect}/${record.param}`);
    const changed = ids.filter((id) => show(hack.get(id)) !== show(VANILLA_ENTRY_ITEMS.get(id)))
      .map((id) => `${id}: ${show(VANILLA_ENTRY_ITEMS.get(id))} → ${show(hack.get(id))}`);
    console.log(`Switch-in items (hold effect/parameter, vanilla → hack) the hack changes: ${changed.join(', ') || 'none'}.`);
    // Read 2026-11-08: Lava Cookie and Old Gateau heal any status, Shoal Salt and Shoal Shell became pinch and HP items,
    // and Ganlon and Apicot Berry have parameter 0.
    expect(changed).toEqual(['42: none → 12/0', '54: none → 12/0', '70: none → 36/0', '71: none → 1/100', '202: 37/4 → 37/0', '205: 40/4 → 40/0']);
    // The pinch items the engine models are the hack's own records: switchIn.ts's HACK_PINCH_ZERO_ITEMS.
    expect([...HACK_PINCH_ZERO_ITEMS].map(([id]) => [id, hack.get(id)])).toEqual([...HACK_PINCH_ZERO_ITEMS]);
  });

  it("prints whether the hack's Pokédex weights equal vanilla's", () => {
    for (const form of [0, 1]) {
      const hack = decodeWeights(readNdsFiles(readFileSync(PK_ROM)), form);
      const vanilla = decodeWeights(readNdsFiles(readFileSync(PK_VANILLA_ROM)), form);
      const changed = hack.flatMap((weight, species) => (weight === vanilla[species] ? [] : [`${species}: ${vanilla[species]} → ${weight}`]));
      console.log(`Form ${form} weights: ${changed.length === 0 ? "the hack's equal vanilla's" : `the hack changes ${changed.join(', ')}`}.`);
      expect(hack).toHaveLength(vanilla.length);
    }
  });
});
