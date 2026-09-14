// Coalesce simultaneous reads, but a refresh requested after a mutation must
// run once more if the in-flight request may contain the pre-mutation state.
export function taskRefresh<T>(read: () => Promise<T>) {
  let pending: Promise<T> | undefined, again = false;
  return (fresh = false): Promise<T> => {
    if (pending) { again ||= fresh; return pending; }
    const run = (async () => {
      let result: T;
      do { again = false; result = await read(); } while (again);
      return result;
    })();
    pending = run;
    void run.finally(() => { if (pending === run) pending = undefined; }).catch(() => undefined);
    return run;
  };
}
