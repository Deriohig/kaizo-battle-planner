// Type support for the pokemon-showdown package, whose declaration files tsc checks along with ours. They use the
// types the package declares as globals in dist/sim/global-types.d.ts (ID, AnyObject, Battle, Pokemon and more)
// without importing them, and its SQLite wrapper's types (dist/lib/sql.d.ts, which the engine never uses) name types
// from better-sqlite3, which ships none of its own.
/// <reference path="../../node_modules/pokemon-showdown/dist/sim/global-types.d.ts" />

declare module 'better-sqlite3' {
  export type Database = unknown;
  export type Options = unknown;
  export type RunResult = unknown;
  export type Statement = unknown;
  export type Transaction = unknown;
}
