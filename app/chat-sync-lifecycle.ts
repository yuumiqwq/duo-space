type EventTargetLike = Pick<EventTarget, "addEventListener" | "removeEventListener">;

// Background timers are best-effort. Web Push handles suspended pages;
// polling still repairs a broken peer channel while a hidden tab can run.
export function startChatSyncLifecycle(options: {
  document: EventTargetLike & { visibilityState: string };
  window: EventTargetLike;
  worker?: EventTargetLike;
  sync: (restart?: boolean) => Promise<void>;
  cancel: () => void;
  setTimer: (callback: () => void, delay: number) => number;
  clearTimer: (id: number) => void;
}) {
  let stopped = false;
  let timer: number | undefined;
  const schedule = () => {
    if (timer !== undefined) options.clearTimer(timer);
    if (!stopped) timer = options.setTimer(poll, options.document.visibilityState === "visible" ? 1500 : 15_000);
  };
  const sync = (restart = false) => { void options.sync(restart).catch(() => undefined); };
  const poll = () => { if (!stopped) { sync(); schedule(); } };
  const recover = () => { if (!stopped) { sync(true); schedule(); } };
  const visibility = () => {
    if (options.document.visibilityState === "visible") recover();
    else schedule();
  };
  const freeze = () => { options.cancel(); if (timer !== undefined) options.clearTimer(timer); };
  const push: EventListener = event => { if ((event as MessageEvent).data?.type === "chat-updated") sync(); };
  const listeners: [EventTargetLike, string, EventListener][] = [
    [options.document, "visibilitychange", visibility],
    [options.document, "freeze", freeze],
    [options.document, "resume", recover],
    ...["focus", "online", "pageshow"].map(name => [options.window, name, recover] as [EventTargetLike, string, EventListener]),
    ...(options.worker ? [[options.worker, "message", push] as [EventTargetLike, string, EventListener]] : []),
  ];
  listeners.forEach(([target, name, listener]) => target.addEventListener(name, listener));
  sync(); schedule();
  return () => {
    stopped = true;
    if (timer !== undefined) options.clearTimer(timer);
    listeners.forEach(([target, name, listener]) => target.removeEventListener(name, listener));
    options.cancel();
  };
}
