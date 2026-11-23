// Copying text for the page's copy buttons (`CopyButton`). The page is served from 127.0.0.1, a secure context, so the
// Clipboard API normally works; when it is missing or refuses (no permission, the page not focused), a hidden
// textarea and `execCommand('copy')` take over.

/** Copies `text` to the clipboard; true when it was copied. Never throws. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall back below.
  }
  return copyWithTextarea(text);
}

/** The old way: select the text in an off-screen textarea and run the copy command, then put the focus back. */
function copyWithTextarea(text: string): boolean {
  const previous = document.activeElement;
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.setAttribute('aria-hidden', 'true');
  Object.assign(area.style, { position: 'fixed', top: '0', left: '0', width: '1px', height: '1px', opacity: '0', pointerEvents: 'none' });
  document.body.appendChild(area);
  try {
    area.focus();
    area.select();
    return typeof document.execCommand === 'function' && document.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
    if (previous instanceof HTMLElement) previous.focus();
  }
}
