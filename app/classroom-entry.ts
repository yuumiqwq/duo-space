import { classroomEntryImages, loadClassroomImage } from './classroom-loading.ts';
import type { PublicTaskPreview } from './classroom-view.ts';
import { withLoadingTimeout } from './loading-timeout.ts';

// Only website records are needed for the initial blackboard, not remote inboxes.
export async function loadClassroomPublicTasks(request: typeof fetch = fetch): Promise<PublicTaskPreview[]> {
  const response = await request('/api/room/tasks?local=1', { cache: 'no-store', signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error('Classroom public tasks could not be loaded');
  const data = await response.json() as { buffer?: unknown };
  if (!Array.isArray(data.buffer) || data.buffer.some(task => !task || typeof task.id !== 'string' || typeof task.title !== 'string')) {
    throw new Error('Classroom public tasks have an invalid response');
  }
  return data.buffer.map(({ id, title }) => ({ id, title }));
}

function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    pending.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}

function frame(signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => { cancelAnimationFrame(id); reject(signal.reason); };
    const id = requestAnimationFrame(() => { signal.removeEventListener('abort', abort); resolve(); });
    signal.addEventListener('abort', abort, { once: true });
  });
}

// The scene stays mounted and paintable behind an opaque loading screen.
// Do not scan arbitrary images, dialogs, chat attachments or the whole font set:
// those may fail independently, or keep changing while the room is connected.
export async function prepareClassroomFrame(root: HTMLElement, signal: AbortSignal) {
  const fonts = new Map<string, Set<string>>();
  for (const element of root.querySelectorAll<HTMLElement>('.chalk-date, .chalk-lettering, .device-name, .device-media-status button, .device-activity textarea, .device-activity p')) {
    const text = element instanceof HTMLTextAreaElement ? element.value || element.placeholder : element.textContent || '';
    if (!text.trim()) continue;
    const style = getComputedStyle(element);
    const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const characters = fonts.get(font) || new Set<string>();
    for (const character of text) characters.add(character);
    fonts.set(font, characters);
  }
  await abortable(withLoadingTimeout(Promise.all([
    ...classroomEntryImages.map(loadClassroomImage),
    ...Array.from(fonts, ([font, text]) => document.fonts.load(font, [...text].join(''))),
  ])), signal);
  // Font/layout effects (including the blackboard's measured line count) run
  // before the second frame. No quiet-DOM loop can be held open by live updates.
  await frame(signal);
  await frame(signal);
}
