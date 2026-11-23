# Command-line tools

The planner started as a set of command-line tools, and they still work. The web page (`npm run serve`) is the
main way to use it now; see the README.

## Prerequisites

- Node 22 (`>=22.12`), from nvm in WSL: `nvm install` reads `.nvmrc`.
- Chromium for Playwright, for the checks that run PKCalc's page (its import of your box, and its damage calc against
  ours) and for `npm run record:diffs`: `npx playwright install chromium`.

## Setup

```bash
npm install
npm run extract -- --rom <path to the .nds>
```

`extract` decodes the ROM (species, moves, trainers and item data) into `data/rom/romdata.json` and downloads the docs
tabs into `data/docs/`. Run it again to pick up a docs change, or when the planner says the ROM data is out of date
after an update; a docs download that fails or cannot be parsed leaves the earlier docs in place.

## Print your box

```bash
npm run box -- --save <path to the .dsv> [--cap N]
```

One line per Pokémon, party first. `--cap` flags Pokémon over that level cap.

## Print a matchup sheet

```bash
npm run sheet -- --save <path to the .dsv> --trainer <id or search text> [--cap N] [--variant N] [--hp full|save]
```

For each of the trainer's Pokémon against each of your eligible Pokémon (alive, outside the graveyard box): who moves
first, then every move both ways with its damage range, KO chance, critical range and hit chance, then notes.

| Flag | Meaning |
|---|---|
| `--save` | Your `.dsv` save. Required. |
| `--trainer` | A trainer ID (`roark-split/youngster-tristan/1`) or words from its name, split or location. Text that matches no trainer, or several, prints the closest ones. Required. |
| `--cap` | The level cap: Pokémon over it are left out. Without it there is no cap. |
| `--variant` | Which ROM copy of the trainer, when it has several: 0 (the default) is the copy the catalog picked, 1 and up the others. The sheet's header lists them. |
| `--hp` | Your team's starting HP: `full` (the default, as planning assumes) or `save`, the HP in your save. Status always comes from the save. |

"?  KO ?" marks a move whose damage the calc cannot bound (an effect it does not model, such as Counter): neither its
range nor its KO chance is known. An OHKO move reads "KO if it hits (N%)", N being its hit chance. A pair whose weather
is not settled (both Pokémon set a different weather, or the trainer Pokémon's disputed ability may set one) is worked
out in each case, and each move shows the worse case for you.

Known limitation: Natural Gift and Judgment use Smogon's item data (no trainer uses them; a player-side use could
overstate the player's damage).

The header's "Nature alternatives" line says what a docs-sourced nature is checked against: "PKCalc" when PKCalc's data
is saved in `data/pkcalc/` (by `npm run test:real` or `npm run record:diffs`), else "all (no PKCalc data)": every other
nature stays possible.

## Tests

- `npm test`: the unit tests. No network, and no ROM or save needed.
- `npm run typecheck`: TypeScript, strict.
- `npm run test:real`: checks against the real files, read only. It needs the network for the docs and PKCalc
  (refreshed once a day, into `<DATA_DIR>/docs` and `<DATA_DIR>/pkcalc`) and these, each overridable:

  | Variable | Default |
  |---|---|
  | `PK_ROM` | `data/roms/plat-kaizo-nightmare-update-final.nds` |
  | `PK_SAVE` | `data/saves/pk-run-2026-06-12.dsv` |
  | `DATA_DIR` | `data` |

  A suite whose file is missing, or whose cache is stale while the network is down, is skipped with the reason.

## When the docs or PKCalc change

`npm run test:real` fails on any new, vanished or changed difference. Then:

1. `npm run record:diffs` rewrites `test/real/accepted-diffs.json` and `docs/data-discrepancies.md`. A difference no
   group in `src/check/groups.ts` explains stops it; add or fix a group there.
2. Review the diff in git.
3. Commit both files.

## Hosting

The same planner can run on a rented server for anyone with the link, each player loading their own save in the
browser: `npm run bundle` packs the game data and sprites once on your PC, and the server runs from that with Docker
or plain Node. `docs/deploy.md` has the steps, the settings and the smoke test.

## Never committed

The ROM, saves (`*.nds`, `*.dsv`, `*.sav`) and the data caches (`data/rom/`, `data/docs/`, `data/pkcalc/`) stay out
of git; `.gitignore` covers them. So does the hosted data bundle (`dist/bundle/`, and `deploy/pkp-data/` on a server).
