"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { BellRing, CircleStop, Check, Loader2, X } from "lucide-react";
import { createPortal } from "react-dom";
import type { Ring } from "./api/room/rings/store";
import "./room-bell.css";
import { ClassroomProp } from "./ClassroomScene";
import { placeBellPanel } from "./bell-position";

type Snapshot = { identityId: string; rings: Ring[]; members: { id: string; name: string }[]; serverNow: number };
export function RoomBell({ triggerHost, onShowChat }: { triggerHost: HTMLElement | null; onShowChat: () => void }) {
  const [data, setData] = useState<Snapshot | null>(null);
  const [openFor, setOpenFor] = useState<HTMLElement | null>(null);
  const open = !!triggerHost && openFor === triggerHost;
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [offline, setOffline] = useState(false);
  const [now, setNow] = useState(0);
  const root = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const locked = useRef(false);
  const sequence = useRef(0);
  const pending = useRef<Record<string, string>>({});
  const offset = useRef(0);
  const notificationLinkHandled = useRef(false);
  const close = useCallback((restoreFocus = false) => {
    setOpenFor(null);
    if (restoreFocus) root.current?.focus({ preventScroll: true });
  }, []);
  const refresh = useCallback(async () => {
    const id = ++sequence.current;
    try {
      const response = await fetch("/api/room/rings", { cache: "no-store", signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error("摇铃状态暂时无法更新");
      const next: Snapshot = await response.json();
      if (id !== sequence.current) return;
      offset.current = next.serverNow - Date.now();
      setNow(next.serverNow);
      setData(next);
      setOffline(false);
      // Close already-ended browser notifications on any connected device.
      if ("serviceWorker" in navigator) {
        const registration = await navigator.serviceWorker.getRegistration();
        const notifications = await registration?.getNotifications();
        const active = new Set(next.rings.filter(r => r.state === "active").map(r => r.id));
        notifications?.forEach(n => { if (n.data?.ringId && !active.has(n.data.ringId)) n.close(); });
      }
    } catch { if (id === sequence.current) setOffline(true); }
  }, []);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => { await refresh(); if (!stopped) timer = setTimeout(poll, document.hidden ? 15000 : 3000); };
    const resume = () => { if (!document.hidden) void refresh(); };
    const invalidatePending = () => { sequence.current++; };
    void poll();
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("online", resume);
    window.addEventListener("focus", resume);
    return () => { stopped = true; invalidatePending(); clearTimeout(timer); document.removeEventListener("visibilitychange", resume); window.removeEventListener("online", resume); window.removeEventListener("focus", resume); };
  }, [refresh]);
  useEffect(() => {
    const timer = setTimeout(() => {
      if (notificationLinkHandled.current || !new URLSearchParams(window.location.search).has("ring")) return;
      onShowChat();
      if (triggerHost) { notificationLinkHandled.current = true; setOpenFor(triggerHost); }
    }, 0);
    return () => clearTimeout(timer);
  }, [triggerHost, onShowChat]);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now() + offset.current), 1000); return () => clearInterval(timer); }, []);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node) && !panel.current?.contains(event.target as Node)) close(); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); close(true); } };
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [open, close]);
  useLayoutEffect(() => {
    if (!open || !root.current || !panel.current) return;
    const popup = panel.current, anchor = root.current;
    const position = () => {
      const viewport = window.visualViewport;
      const placement = placeBellPanel(anchor.getBoundingClientRect(), {
        left: viewport?.offsetLeft || 0, top: viewport?.offsetTop || 0,
        width: viewport?.width || window.innerWidth, height: viewport?.height || window.innerHeight,
      }, popup.scrollHeight + 2);
      for (const [key, value] of Object.entries(placement)) popup.style.setProperty(key === "maxHeight" ? "max-height" : key, `${value}px`);
      popup.style.visibility = "visible";
    };
    position();
    popup.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
    const observer = new ResizeObserver(position);
    observer.observe(anchor); observer.observe(popup);
    window.addEventListener("resize", position); window.addEventListener("scroll", position, true);
    window.visualViewport?.addEventListener("resize", position); window.visualViewport?.addEventListener("scroll", position);
    return () => {
      observer.disconnect(); window.removeEventListener("resize", position); window.removeEventListener("scroll", position, true);
      window.visualViewport?.removeEventListener("resize", position); window.visualViewport?.removeEventListener("scroll", position);
    };
  }, [open]);
  async function act(recipientId: string, ring?: Ring, action?: "acknowledge" | "cancel") {
    if (locked.current) return;
    locked.current = true; setBusy(ring?.id || recipientId); setError(""); sequence.current++;
    try {
      const id = ring?.id || (pending.current[recipientId] ||= crypto.randomUUID());
      const response = await fetch("/api/room/rings", { method: ring ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(ring ? { id, action } : { id, recipientId }), signal: AbortSignal.timeout(10000) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "操作失败，请重试");
      delete pending.current[recipientId];
      await refresh();
    } catch (cause) { setError(cause instanceof Error && cause.name !== "TimeoutError" ? cause.message : "结果尚未确认，请重试；不会重复摇铃"); }
    finally { locked.current = false; setBusy(""); }
  }
  const live = (r: Ring) => r.state === "active" && r.expiresAt > now;
  const incoming = data?.rings.filter(r => r.recipientId === data.identityId && live(r)) || [];
  const outgoing = data?.rings.filter(r => r.senderId === data.identityId && live(r)) || [];
  const triggerLabel = `打开摇铃面板${incoming.length ? `，${incoming.length}条待确认` : outgoing.length ? `，${outgoing.length}个提醒正在进行` : ""}`;
  const status = (r: Ring) => {
    if (r.state === "acknowledged") return "对方已确认";
    if (r.state === "cancelled") return "已取消";
    if (!live(r)) return "已超时";
    if (r.delivery === "unavailable") return "等待确认 · 对方未开启推送";
    if (r.delivery === "failed") return "等待确认 · 手机推送失败";
    return `${r.repeat ? "每3秒提醒" : "等待确认"} · ${Math.ceil((r.expiresAt - now) / 1000)}秒`;
  };
  return <>
    {triggerHost && createPortal(<button ref={root} className={`room-bell-trigger${incoming.length ? " has-incoming" : outgoing.length ? " is-ringing" : ""}`} type="button"  aria-label={triggerLabel} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? "room-bell-panel" : undefined} onClick={() => open ? close() : setOpenFor(triggerHost)}>
      <ClassroomProp name="bell" />{incoming.length > 0 ? <i aria-hidden="true">{incoming.length > 99 ? "99+" : incoming.length}</i> : outgoing.length > 0 && <span className="room-bell-active-dot" aria-hidden="true" />}
    </button>, triggerHost)}
    {open && createPortal(<section ref={panel} id="room-bell-panel" className="room-bell room-bell-panel" role="dialog" aria-modal="false" aria-labelledby="room-bell-title" style={{ visibility: "hidden" }}>
      <header><strong id="room-bell-title">摇铃</strong><button type="button" aria-label="关闭摇铃面板" onClick={() => close(true)}><X size={18} /></button></header>
      {!data && <p className="room-bell-empty">正在获取成员…</p>}
      {data && !data.members.length && <p className="room-bell-empty">暂无其他成员</p>}
      {data?.members.map(member => {
        const latest = data.rings.find(r => r.senderId === data.identityId && r.recipientId === member.id);
        const active = latest && live(latest);
        return <div className="room-bell-member" key={member.id}>
          <span className="room-bell-avatar" aria-hidden="true">{member.name.slice(0, 1)}</span>
          <div><strong>{member.name}</strong><small>{latest ? status(latest) : "发一个轻提醒"}</small></div>
          <button className="room-bell-send" type="button" disabled={!!busy}  aria-label={`${active ? "停止提醒" : "摇铃给"}${member.name}`} onClick={() => void act(member.id, active ? latest : undefined, active ? "cancel" : undefined)}>
            {busy === member.id || busy === latest?.id ? <Loader2 className="room-bell-spinner" size={18} /> : active ? <CircleStop size={18} /> : <BellRing size={18} />}<span>{active ? "停止" : "发送"}</span>
          </button>
        </div>;
      })}
      {error && <p className="room-bell-error" role="status">{error}</p>}
      {offline && <p className="room-bell-error" role="status">连接暂时中断，正在重新获取摇铃状态</p>}
    </section>, document.body)}
    {incoming.length > 0 && createPortal(<div className="room-bell room-bell-incoming" aria-label="收到的摇铃">
      {incoming.map(ring => <section className="room-bell-card" key={ring.id}>
        <span className="room-bell-card-icon" aria-hidden="true"><BellRing size={22} /></span>
        <div className="room-bell-card-copy" role="status"><strong>{ring.senderName} 摇了摇铃</strong><span>有空看一下自习室</span></div>
        <button type="button" className="room-bell-ack" disabled={!!busy} onClick={() => void act(ring.recipientId, ring, "acknowledge")}>
          {busy === ring.id ? <Loader2 className="room-bell-spinner" size={16} /> : <Check size={16} />}知道了
        </button>
      </section>)}
      {error && <p className="room-bell-error" role="status">{error}</p>}
    </div>, document.body)}
  </>;
}
