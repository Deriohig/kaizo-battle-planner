// The "Load your save" screen and the window file-drop hook.

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LoadSave, type LoadSaveProps } from '../../../web/src/components/LoadSave';
import { pickSaveFile, useFileDrop } from '../../../web/src/hosted/useFileDrop';

const file = (name: string) => new File(['x'], name);
function setup(over: Partial<LoadSaveProps> = {}) {
  const props: LoadSaveProps = { canConnect: true, uploading: false, error: null, reason: null, onFile: vi.fn(), onConnect: vi.fn(), ...over };
  return { props, ...render(<LoadSave {...props} />) };
}
const button = (name: string) => screen.getByRole('button', { name });

describe('LoadSave', () => {
  it('with Connect: the heading, drop area, Connect primary with its hint, and the privacy line; Connect calls onConnect', () => {
    const { props } = setup();
    expect(screen.getByRole('heading', { name: 'Load your save' })).toBeTruthy();
    for (const text of ['Drop your save file here', ".dsv or .sav, from DeSmuME's Battery folder", 'The planner reads the file again each time you save in game. Keep this tab open.', 'Read in your browser; nothing is stored on the server.']) {
      expect(screen.getByText(text)).toBeTruthy();
    }
    expect(button('Connect save file').className).toContain('button-primary');
    expect(button('Upload a save').className).not.toContain('button-primary');
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    fireEvent.click(button('Connect save file'));
    expect(props.onConnect).toHaveBeenCalledOnce();
  });

  it('without Connect: Upload a save is primary with the other hint; the reason, an error alert and Cancel show when given', () => {
    const onCancel = vi.fn();
    setup({ canConnect: false, reason: 'Load your save again.', error: 'That is not a save.', onCancel });
    expect(screen.queryByRole('button', { name: 'Connect save file' })).toBeNull();
    expect(button('Upload a save').className).toContain('button-primary');
    expect(screen.getByText("This browser can't watch a file. Upload the save again after you save in game.")).toBeTruthy();
    expect(screen.queryByText(/reads the file again/)).toBeNull();
    expect(screen.getByText('Load your save again.')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe('That is not a save.');
    fireEvent.click(button('Cancel'));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('a file chosen in the picker goes to onFile as an upload, .dsv and .sav; a drop on the area as a drop, the save picked, not reaching the window', () => {
    const onWindow = vi.fn();
    window.addEventListener('drop', onWindow);
    const { props } = setup();
    const input = screen.getByTestId('load-save-input') as HTMLInputElement;
    expect(input.accept).toBe('.dsv,.sav');
    fireEvent.change(input, { target: { files: [file('a.dsv')] } });
    expect(props.onFile).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'a.dsv' }), 'upload');
    const files = [file('a.txt'), file('b.sav'), file('c.dsv')];
    const area = screen.getByText('Drop your save file here').parentElement!;
    fireEvent.dragEnter(area, { dataTransfer: { types: ['Files'], files } });
    expect(area.className).toContain('is-over');
    fireEvent.drop(area, { dataTransfer: { types: ['Files'], files } });
    expect(props.onFile).toHaveBeenLastCalledWith(files[1], 'drop');
    expect(props.onFile).toHaveBeenCalledTimes(2);
    expect(area.className).not.toContain('is-over');
    expect(onWindow).not.toHaveBeenCalled();
    window.removeEventListener('drop', onWindow);
  });

  it('while uploading it says so in a status and marks the buttons busy', () => {
    const { props } = setup({ uploading: true });
    expect(screen.getByRole('status').textContent).toBe('Reading the save…');
    for (const name of ['Connect save file', 'Upload a save']) expect(button(name)).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(button('Connect save file'));
    expect(props.onConnect).not.toHaveBeenCalled();
  });
});

it('pickSaveFile takes the first .dsv or .sav, any case, else the first file, else null', () => {
  const files = [file('a.txt'), file('b.SAV'), file('c.dsv')];
  expect(pickSaveFile(files)).toBe(files[1]);
  expect(pickSaveFile(files.slice(0, 1))).toBe(files[0]);
  expect(pickSaveFile([])).toBeNull();
});

describe('useFileDrop', () => {
  function Probe({ onFile, enabled }: { onFile(f: File): void; enabled?: boolean }) {
    return <p>{useFileDrop(onFile, enabled) ? 'over' : 'not over'}</p>;
  }
  const over = () => screen.getByText(/over/).textContent;

  it('a Files drag is over until its last leave, and a drop calls onFile, prevented', () => {
    const onFile = vi.fn();
    render(<Probe onFile={onFile} />);
    const files = [file('x.dsv')];
    const data = { dataTransfer: { types: ['Files'], files } };
    fireEvent.dragEnter(window, data);
    expect(over()).toBe('over');
    fireEvent.dragEnter(window, data);
    fireEvent.dragLeave(window, data);
    expect(over()).toBe('over');
    fireEvent.dragLeave(window, data);
    expect(over()).toBe('not over');
    fireEvent.dragEnter(window, data);
    expect(fireEvent.drop(window, data)).toBe(false);
    expect(onFile).toHaveBeenCalledWith(files[0]);
    expect(over()).toBe('not over');
  });

  it('a text/plain drag (the Pokémon drag) does not count and is not prevented; disabled, nothing counts', () => {
    const onFile = vi.fn();
    const { unmount } = render(<Probe onFile={onFile} />);
    const data = { dataTransfer: { types: ['text/plain'], files: [] } };
    fireEvent.dragEnter(window, data);
    expect(over()).toBe('not over');
    expect(fireEvent.dragOver(window, data)).toBe(true);
    expect(fireEvent.drop(window, data)).toBe(true);
    unmount();
    render(<Probe onFile={onFile} enabled={false} />);
    fireEvent.dragEnter(window, { dataTransfer: { types: ['Files'], files: [file('x.dsv')] } });
    expect(over()).toBe('not over');
    expect(onFile).not.toHaveBeenCalled();
  });
});
