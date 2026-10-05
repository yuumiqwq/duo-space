import { loadClassroomImage } from './classroom-loading.ts';

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function imageUrls(value: string) {
  return [...value.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)/g)]
    .map(match => (match[1] ?? match[2] ?? match[3]).trim()).filter(url => url && !url.startsWith('#'));
}

function frame(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => { cancelAnimationFrame(id); reject(signal.reason); };
    const id = requestAnimationFrame(() => { signal.removeEventListener('abort', abort); resolve(); });
    signal.addEventListener('abort', abort, { once: true });
  });
}

// Inspect the mounted scene, including CSS backgrounds, masks and pseudo-elements.
// FontFace.load() before mounting alone does not wait for CSS-selected faces,
// glyph fallbacks, layout effects or content supplied by child components.
export async function prepareRenderedClassroom(root: HTMLElement, signal: AbortSignal, timeout = 90_000) {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(timeout)]);
  let revision = 0;
  const observer = new MutationObserver(() => { revision++; });
  observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true });
  try {
    let previous: number;
    do {
      previous = revision;
      const urls = new Set<string>();
      const fonts = new Map<string, Set<string>>();
      const pending: Promise<unknown>[] = [];
      for (const element of [root, ...root.querySelectorAll<HTMLElement>('*')]) {
        // Closed dialogs and display:none panels are outside the initial scene.
        if (!element.getClientRects().length) continue;
        for (const pseudo of [null, '::before', '::after', '::-webkit-scrollbar-thumb']) {
          const style = getComputedStyle(element, pseudo);
          for (const value of [style.backgroundImage, style.maskImage, style.borderImageSource, style.listStyleImage, style.content]) {
            for (const url of imageUrls(value || '')) urls.add(url);
          }
          const text = pseudo ? (style.content?.match(/^["'](.*)["']$/)?.[1] || '')
            : Array.from(element.childNodes).filter(node => node.nodeType === 3).map(node => node.textContent || '').join('')
              + (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.value || element.placeholder : '');
          if (text.trim()) {
            const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
            const characters = fonts.get(font) || new Set<string>();
            for (const character of text) characters.add(character);
            fonts.set(font, characters);
          }
        }
        if (element instanceof HTMLImageElement && (element.currentSrc || element.src)) {
          // The initial chat page also contains lazy images; do not wait for a
          // scroll gesture that is unavailable while the entry screen is up.
          if (element.loading === 'lazy') element.loading = 'eager';
          pending.push(element.decode());
        }
      }
      pending.push(...[...urls].map(loadClassroomImage));
      for (const [font, text] of fonts) pending.push(document.fonts.load(font, [...text].join('')));
      await abortable(Promise.all(pending), deadline);
      await abortable(document.fonts.ready, deadline);
      // Let font-dependent measurements and the following paint run before
      // revealing the scene. Rescan if React changed its resources meanwhile.
      await frame(deadline);
      await frame(deadline);
    } while (revision !== previous);
  } finally { observer.disconnect(); }
}
