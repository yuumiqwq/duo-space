// Desktop occlusion can change focus without a useful hidden interval. Wait for
// the compositor to resume and coalesce focus/visibility/pageshow into one repair.
export function onMediaForeground(doc: Document, win: Window, recover: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => { clearTimeout(timer); timer = undefined; };
  const schedule = () => {
    cancel();
    if (doc.visibilityState !== 'visible') return;
    timer = setTimeout(() => {
      timer = undefined;
      if (doc.visibilityState === 'visible') recover();
    }, 250);
  };
  doc.addEventListener('visibilitychange', schedule);
  doc.addEventListener('resume', schedule);
  win.addEventListener('focus', schedule);
  win.addEventListener('pageshow', schedule);
  return () => {
    cancel();
    doc.removeEventListener('visibilitychange', schedule);
    doc.removeEventListener('resume', schedule);
    win.removeEventListener('focus', schedule);
    win.removeEventListener('pageshow', schedule);
  };
}
