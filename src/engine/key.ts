// The exact state key: equal keys mean identical futures. It hashes Showdown's whole battle JSON (`battle.toJSON()`)
// minus the fields below, so anything the battle keeps, and every field added later, is in the key by
// construction. That includes the turn number (Fake Out, Slow Start, Truant, the AI's first-turn rules and the
// solver's turn cap read it) and `formatData`: the trainer's bag, the field spec, the unmodelled notes and the
// enemy's revealed moves, ability and item (observe.ts), so states that differ in what the player has seen differ in key.

import { createHash } from 'node:crypto';

/**
 * The battle JSON's top-level fields that no future of the battle reads, each with why. Showdown 0.11.11 serialises
 * no request ids (the server, not the simulator, numbers requests), and no send hook (`send` is a function, which
 * `toJSON` leaves out).
 */
const NON_SEMANTIC: readonly string[] = [
  'log', // protocol text, with wall-clock |t:| lines; the simulation only appends to it (and edits its last move line)
  'inputLog', // the replay record of inputs; nothing in the simulation reads it
  'messageLog', // chat messages; never read, always empty here
  'sentLogPos', // how much of the log the no-op `send` was given
  'sentEnd', // whether the end-of-battle summary was sent
  'sentRequests', // whether the requests were sent; it only decides whether `sendUpdates` sends them
  'lastMoveLine', // the log index `attrLastMove` edits; text only
  'prngSeed', // the starting seed, read only by `resetRNG` and the end-of-battle summary
  'prng', // the stock generator's seed: the chance driver decides every draw (chance.ts), so it never advances
  'hints', // which once-only |-hint| lines were printed
];

/** The state key of `battle`: SHA-256 (hex) of its canonical JSON without `NON_SEMANTIC`. */
export function stateKey(battle: Battle): string {
  return serializedKey(battle.toJSON());
}

/** The state key of a battle's `toJSON()` output, which this changes (it deletes `NON_SEMANTIC` from it). */
export function serializedKey(serialized: Record<string, unknown>): string {
  for (const field of NON_SEMANTIC) delete serialized[field];
  return createHash('sha256').update(canonicalJson(serialized)).digest('hex');
}

// One serialisation per leaf. A snapshot needs the battle's JSON text (`JSON.stringify` of its
// `toJSON()`, insertion order, which `restore` needs) and its key (SHA-256 of the canonical JSON, keys sorted). The
// Pokémon are most of both (twelve in a 6v6, about 3 KB each), and between a step's leaves the benched ones don't
// change. So each Pokémon is stringified once: the snapshot's JSON is put together from those texts, byte for byte
// what `JSON.stringify` gives, and each Pokémon's canonical JSON is looked up by its text (`canonicalByText`), computed
// only for a text not seen before. Equal texts are equal JSON values, so their canonical JSON is equal: the key is
// byte for byte `serializedKey`'s (test/unit/engine/serialise.test.ts checks both on every leaf of a corpus).

type Json = Record<string, unknown>;

/** `JSON.stringify` of a plain object, with `override(key, value)` standing in for a value's text when it gives one. */
function objectText(record: Json, override: (key: string, value: unknown) => string | undefined): string {
  let text = '{';
  for (const key of Object.keys(record)) {
    const value = record[key];
    const entry = override(key, value) ?? JSON.stringify(value);
    if (entry === undefined) continue; // undefined, a function or a symbol, as JSON.stringify leaves out
    text += `${text.length === 1 ? '' : ','}${JSON.stringify(key)}:${entry}`;
  }
  return `${text}}`;
}

/** `canonicalJson` of a plain object, with `override(key, value)` standing in for a value's canonical text. */
function canonicalObject(record: Json, override: (key: string, value: unknown) => string | undefined): string {
  let text = '{';
  for (const key of Object.keys(record).sort()) {
    const value = record[key];
    if (value === undefined || typeof value === 'function') continue;
    text += `${text.length === 1 ? '' : ','}${JSON.stringify(key)}:${override(key, value) ?? canonicalJson(value)}`;
  }
  return `${text}}`;
}

/** Canonical JSON of Pokémon by their JSON text; cleared when it holds `CANONICAL_CACHE_SIZE` (about 6 KB each). */
const canonicalByText = new Map<string, string>();
const CANONICAL_CACHE_SIZE = 4096;

function cachedCanonical(text: string, value: unknown): string {
  let canonical = canonicalByText.get(text);
  if (canonical === undefined) {
    canonical = canonicalJson(value);
    if (canonicalByText.size >= CANONICAL_CACHE_SIZE) canonicalByText.clear();
    canonicalByText.set(text, canonical);
  }
  return canonical;
}

/**
 * A battle's `toJSON()` output as the snapshot keeps it: its JSON text (byte for byte `JSON.stringify(serialized)`)
 * and its state key (byte for byte `serializedKey(serialized)`), from one `JSON.stringify` of each Pokémon. Like
 * `serializedKey`, it deletes `NON_SEMANTIC` from `serialized`, after the text is made; `key` is computed when called.
 */
export function serializedState(serialized: Json): { json: string; key: () => string } {
  const sides = serialized['sides'];
  if (!Array.isArray(sides) || !sides.every((side) => Array.isArray((side as Json)['pokemon']))) {
    const json = JSON.stringify(serialized);
    return { json, key: () => serializedKey(serialized) };
  }
  const teams = (sides as Json[]).map((side) => side['pokemon'] as unknown[]);
  const texts = teams.map((team) => team.map((pokemon) => JSON.stringify(pokemon) ?? 'null'));
  const json = objectText(serialized, (key) => (key !== 'sides' ? undefined : `[${(sides as Json[]).map((side, i) =>
    objectText(side, (field) => (field === 'pokemon' ? `[${texts[i]!.join(',')}]` : undefined))).join(',')}]`));
  return {
    json,
    key: () => {
      for (const field of NON_SEMANTIC) delete serialized[field];
      const canonical = canonicalObject(serialized, (key) => (key !== 'sides' ? undefined : `[${(sides as Json[]).map((side, i) =>
        canonicalObject(side, (field) => (field !== 'pokemon' ? undefined
          : `[${teams[i]!.map((pokemon, j) => cachedCanonical(texts[i]![j]!, pokemon)).join(',')}]`))).join(',')}]`));
      return createHash('sha256').update(canonical).digest('hex');
    },
  };
}

/**
 * JSON with every object's keys sorted (by UTF-16 code units), so equal values give equal text whatever order their
 * keys were added in. As in `JSON.stringify`, an object property that is undefined or a function is left out, and an
 * array entry that is becomes null. Every leaf restores and keys a battle, so this is a plain loop.
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined || typeof value === 'function') return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    let text = '[';
    for (let i = 0; i < value.length; i++) text += (i === 0 ? '' : ',') + canonicalJson(value[i]);
    return `${text}]`;
  }
  const record = value as Record<string, unknown>;
  let text = '{';
  for (const key of Object.keys(record).sort()) {
    const entry = record[key];
    if (entry === undefined || typeof entry === 'function') continue;
    text += `${text.length === 1 ? '' : ','}${JSON.stringify(key)}:${canonicalJson(entry)}`;
  }
  return `${text}}`;
}
