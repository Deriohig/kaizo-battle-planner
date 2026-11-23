// The server's own words for something the page says in its own: one click away behind a
// native "Details" disclosure, never in the sentence and never in a live region. Used by a failed step's banner
// (LineView.tsx) and by "Their reply" where the trainer AI's behaviour is undefined (tree/TheirReply.tsx).

export function ServerWords({ text }: { text: string }) {
  return (
    <details className="server-words">
      <summary>Details</summary>
      <p>{text}</p>
    </details>
  );
}
