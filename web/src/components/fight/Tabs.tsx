// A row of tabs for the fight workspace (the page's `.tabs` look). The panels are the caller's: each one a
// `role="tabpanel"` with `ids.panel(id)` and `aria-labelledby={ids.tab(id)}`, hidden while its tab is not selected.

export interface TabIds { tab(id: string): string; panel(id: string): string }

/** Tab and panel IDs from one `useId()` base. */
export function tabIds(base: string): TabIds {
  return { tab: (id) => `${base}tab-${id}`, panel: (id) => `${base}panel-${id}` };
}

export function Tabs<T extends string>({ label, tabs, value, onChange, ids }: {
  label: string; tabs: readonly [T, string][]; value: T; onChange(next: T): void; ids: TabIds;
}) {
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {tabs.map(([id, text]) => (
        <button
          key={id} type="button" role="tab" id={ids.tab(id)} aria-controls={ids.panel(id)} aria-selected={value === id}
          className={`tab${value === id ? ' is-active' : ''}`} onClick={() => onChange(id)}
        >
          {text}
        </button>
      ))}
    </div>
  );
}
