// The one bar between the matchup bar and the first section: "Show" one of yours (or All), a filter, and "Go
// to" one of his Pokémon, the navigation, in two groups of one row that wraps. The whole bar sticks under the app header.
// A group with only one choice is left out, and nothing renders when neither shows.

import type { ReactElement } from 'react';

interface Choice { key: string; label: string }

export function MatchupsNav({ enemies, players, only, onJump, onOnly }: {
  enemies: Choice[]; players: Choice[]; only: string | null; onJump(enemyKey: string): void; onOnly(playerKey: string | null): void;
}): ReactElement | null {
  const jumps = enemies.length >= 2;
  const shows = players.length >= 2;
  if (!jumps && !shows) return null;
  return (
    <nav className="matchups-nav" aria-label="Matchups navigation">
      {shows && (
        <div className="matchup-nav-group" role="group" aria-label="Show">
          <span className="matchup-label">Show</span>
          <button type="button" className="chip" aria-pressed={only === null} onClick={() => onOnly(null)}>All</button>
          {players.map((player) => (
            <button key={player.key} type="button" className="chip" aria-pressed={only === player.key} onClick={() => onOnly(player.key)}>
              {player.label}
            </button>
          ))}
        </div>
      )}
      {jumps && (
        <div className="matchup-nav-group" role="group" aria-label="Go to">
          <span className="matchup-label">Go to</span>
          {enemies.map((enemy) => (
            <button key={enemy.key} type="button" className="chip" onClick={() => onJump(enemy.key)}>{enemy.label}</button>
          ))}
        </div>
      )}
    </nav>
  );
}
