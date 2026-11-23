// The planner's wordmark: the header, the load screen and the sign-in screen all draw it from here. An original
// mark: a route that climbs in steps (one turn after another) ending in a node, on a rounded tile in the accent fill; the same
// drawing is the favicon (web/public/favicon.svg). The name is "Plat Kaizo" with "Planner" lighter. The tile and route take
// their colours from the tokens (see `.wordmark-*` in styles.css).

export function Wordmark({ size = 'md' }: {
  /** `md` in the header, `lg` above the load and sign-in cards. */
  size?: 'md' | 'lg';
}) {
  return (
    <span className={`wordmark wordmark-${size}`}>
      <svg className="wordmark-icon" viewBox="0 0 64 64" aria-hidden="true" focusable="false">
        <rect className="wordmark-tile" width="64" height="64" rx="14" />
        <path className="wordmark-route" d="M14 46H28V32H40V18H48" />
        <circle className="wordmark-node" cx="14" cy="46" r="5" />
        <circle className="wordmark-node" cx="50" cy="18" r="5" />
      </svg>
      Plat Kaizo <span className="wordmark-light">Planner</span>
    </span>
  );
}
