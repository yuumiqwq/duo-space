// A suspended browser's timeout uses active time. Use wall time too, and
// invalidate old responses when a foreground recovery replaces the request.
export function createChatSyncRequest() {
  let active: { controller: AbortController; startedAt: number; timer: ReturnType<typeof setTimeout> } | null = null;
  const cancel = () => {
    if (active) { clearTimeout(active.timer); active.controller.abort(); active = null; }
  };
  return {
    begin(restart = false) {
      if (active && !restart && Date.now() - active.startedAt < 10_000) return null;
      cancel();
      const controller = new AbortController();
      const request = { controller, startedAt: Date.now(), timer: setTimeout(() => controller.abort(), 10_000) };
      active = request;
      return {
        signal: request.controller.signal,
        isLatest: () => active === request,
        isCurrent: () => active === request && !request.controller.signal.aborted,
        finish: () => { clearTimeout(request.timer); if (active === request) active = null; },
      };
    },
    cancel,
  };
}
