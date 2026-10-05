"use client";

export function RoomLoadingScreen({ displayName, error, onRetry }: { displayName: string; error?: string; onRetry?: () => void }) {
  return <main className="access-shell">
    <section className="access-card room-loading-card" aria-busy={!error}>
      <div className="access-brand"><span className="brand-mark">11</span>{displayName && <strong>{displayName}</strong>}</div>
      {error ?
        <button className="primary-button access-submit" onClick={onRetry}>重新加载</button>
      : <div role="status" aria-live="polite" aria-label="加载中">
        <span className="room-entry-spinner" aria-hidden="true" />
      </div>}
    </section>
  </main>;
}
