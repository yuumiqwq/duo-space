export function watchNoticeVisibility(element: Element, onRead: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined, visible = false, read = false;
  const cancel = () => { clearTimeout(timer); timer = undefined; };
  const schedule = () => {
    cancel();
    if (visible && !document.hidden && !read) timer = setTimeout(() => { read = true; onRead(); }, 1200);
  };
  const observer = new IntersectionObserver(entries => { visible = entries.some(entry => entry.isIntersecting && entry.intersectionRatio >= 1); schedule(); }, { threshold: 1 });
  observer.observe(element); document.addEventListener("visibilitychange", schedule);
  return () => { cancel(); observer.disconnect(); document.removeEventListener("visibilitychange", schedule); };
}

// Visiting a workflow acknowledges its records once the detail view is painted.
// Timeline markers can be clipped by the scroll container and are not a read target.
export function watchWorkflowVisit(onRead: () => void) {
  let frame: number | undefined, read = false;
  const cancel = () => { if (frame !== undefined) cancelAnimationFrame(frame); frame = undefined; };
  const schedule = () => {
    cancel();
    if (!document.hidden && !read) frame = requestAnimationFrame(() => { frame = undefined; if (!document.hidden) { read = true; onRead(); } });
  };
  document.addEventListener('visibilitychange', schedule); schedule();
  return () => { cancel(); document.removeEventListener('visibilitychange', schedule); };
}
