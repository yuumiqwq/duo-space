"use client";

import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { FolderUp, Check, File, Loader2, SquareCheckBig, Trash2, Upload, X } from "lucide-react";
import { FolderArtwork } from "./FolderArtwork";
import { clipboardFiles, cloudDropPath, cloudFileSize, cloudFileUrl, cloudRequest, deleteCloudItems, nextFolderName, uploadCloudFiles, type CloudItem, type CloudStatus } from "./cloud-drive-actions";
import "./cloud-drive.css";

export function CloudDrive({ onClose, onImage }: {
  onClose: () => void;
  onImage: (image: { url: string; name: string }) => void;
}) {
  const [path, setPath] = useState("");
  const [items, setItems] = useState<CloudItem[]>([]);
  const [status, setStatus] = useState<CloudStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [deleteMode, setDeleteMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [draftName, setDraftName] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const dialog = useRef<HTMLElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const draft = useRef<string | null>(null);
  const locked = useRef(false);
  const loadingRef = useRef(true);
  const sequence = useRef(0);
  const dragDepth = useRef(0);
  const naming = draftName !== null;

  const load = useCallback(async (nextPath: string) => {
    const id = ++sequence.current;
    loadingRef.current = true; setLoading(true);
    try {
      const result = await cloudRequest(`/api/cloud?path=${encodeURIComponent(nextPath)}`, { cache: "no-store" });
      if (!Array.isArray(result?.items) || !result.status) throw new Error("云盘加载失败");
      if (id !== sequence.current) return;
      setPath(result.path); setItems(result.items); setStatus(result.status);
      const visible = new Set((result.items as CloudItem[]).map(item => item.path));
      setSelected(current => new Set([...current].filter(itemPath => visible.has(itemPath))));
    } catch (cause) { if (id === sequence.current) setError(cause instanceof Error ? cause.message : "云盘加载失败"); }
    finally { if (id === sequence.current) { loadingRef.current = false; setLoading(false); } }
  }, []);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    const timer = setTimeout(() => void load(""), 0);
    const invalidate = () => { sequence.current++; };
    return () => { clearTimeout(timer); invalidate(); previous?.focus({ preventScroll: true }); };
  }, [load]);
  useEffect(() => {
    if (naming && !busy) { nameInput.current?.focus(); nameInput.current?.select(); }
    // Focus only when the naming field appears or a failed request makes it editable again.
  }, [naming, busy]);

  const navigate = (next: string) => {
    if (locked.current || loadingRef.current || draft.current !== null || deleteMode) return;
    setError(""); setNotice(""); setSelected(new Set()); void load(next);
  };
  const close = () => { if (!locked.current) onClose(); };
  const toggleSelection = (itemPath: string) => {
    if (locked.current || loadingRef.current) return;
    setSelected(current => { const next = new Set(current); if (next.has(itemPath)) next.delete(itemPath); else next.add(itemPath); return next; });
  };
  const cancelDeletion = () => { if (!locked.current) { setDeleteMode(false); setSelected(new Set()); setNotice(""); } };
  async function deleteSelection() {
    if (locked.current || loadingRef.current || draft.current !== null) return;
    setError(""); setNotice("");
    if (!deleteMode) { setDeleteMode(true); setSelected(new Set()); return; }
    const targets = items.filter(item => selected.has(item.path));
    if (!targets.length) { cancelDeletion(); return; }
    locked.current = true; setBusy(true);
    try {
      const result = await deleteCloudItems(targets, (done, total) => setNotice(`正在删除 ${done} / ${total} 项`));
      const removed = new Set(result.succeeded.map(item => item.path));
      setItems(current => current.filter(item => !removed.has(item.path)));
      setSelected(new Set(result.failed.map(failure => failure.item.path)));
      setDeleteMode(result.failed.length > 0);
      setNotice(`已删除 ${result.succeeded.length} 项`);
      setError(result.failed.map(failure => `${failure.item.name}：${failure.message}`).join("；"));
      await load(path);
    } finally { locked.current = false; setBusy(false); }
  }

  function startFolder() {
    if (locked.current || loadingRef.current || deleteMode) return;
    setError(""); setNotice("");
    draft.current = nextFolderName(items); setDraftName(draft.current);
  }
  async function saveFolder() {
    if (draft.current === null || locked.current) return;
    const name = draft.current.trim();
    if (!name || /^[.]+$/.test(name) || /[\\/:*?"<>|\u0000-\u001f]/.test(name) || name.startsWith(".") || name.length > 180) {
      setError("请输入有效名称，不能以点开头或包含斜杠等特殊字符，最多 180 个字符");
      nameInput.current?.focus(); return;
    }
    locked.current = true; setBusy(true); setError("");
    try {
      await cloudRequest("/api/cloud/folders", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, name }) });
      draft.current = null; setDraftName(null); setNotice(`已创建文件夹“${name}”`); await load(path);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "创建失败"); }
    finally { locked.current = false; setBusy(false); }
  }

  async function upload(files: File[], destination: string) {
    if (!files.length) return;
    if (locked.current || loadingRef.current || deleteMode || draft.current !== null) {
      setError("请先完成当前操作，再上传文件"); return;
    }
    if (status?.warning) { setError("容量不足，请清理空间后再上传"); return; }
    locked.current = true; setBusy(true); setError(""); setNotice(`正在上传到 /${destination}`);
    try {
      const result = await uploadCloudFiles(files, destination, (done, total) => setNotice(`正在上传 ${done} / ${total} 个文件 → /${destination}`));
      setNotice(`已上传 ${result.succeeded.length} / ${files.length} 个文件到 /${destination}`);
      setError(result.failed.map(failure => `${failure.item.name}：${failure.message}`).join("；"));
      await load(path);
    } finally { locked.current = false; setBusy(false); }
  }
  const destinationAt = (event: DragEvent<HTMLElement>) => cloudDropPath(path, (event.target as Element).closest<HTMLElement>("[data-cloud-folder]")?.dataset.cloudFolder, items);
  function drop(event: DragEvent<HTMLElement>, destination: string) {
    event.preventDefault(); event.stopPropagation(); setDropTarget(null); dragDepth.current = 0;
    if (Array.from(event.dataTransfer.items).some(item => item.webkitGetAsEntry?.()?.isDirectory)) { setError("请拖入文件；暂不支持上传整个本地文件夹"); return; }
    void upload(clipboardFiles(event.dataTransfer), destination);
  }
  const disabled = loading || busy;
  const noUpload = disabled || deleteMode || draftName !== null || !!status?.warning;
  const allSelected = items.length > 0 && items.every(item => selected.has(item.path));
  const folders = items.filter(item => item.kind === "folder"), files = items.filter(item => item.kind === "file");
  const deleteLabel = !deleteMode ? "进入删除模式" : selected.size ? `删除所选 ${selected.size} 项` : "退出删除模式";

  function renderItem(item: CloudItem) {
    const isImage = /\.(?:png|jpe?g|gif|webp|avif|svg|bmp)$/i.test(item.name);
    const contents = <>{item.kind === "folder" ? <FolderArtwork /> : isImage ? <img className="drive-image" src={cloudFileUrl(item.path)} alt="" loading="lazy" /> : <File className="drive-file-art" size={64} aria-hidden="true" />}<strong >{item.name}</strong>{item.kind === "file" && <small>{cloudFileSize(item.size)}</small>}</>;
    return <article className={`drive-entry ${item.kind}${selected.has(item.path) ? " selected" : ""}${dropTarget === item.path ? " drop-target" : ""}`} key={item.path} data-cloud-folder={item.kind === "folder" ? item.path : undefined}>
      {deleteMode ? <button className="drive-entry-main" type="button" aria-pressed={selected.has(item.path)} aria-label={`选择${item.kind === "folder" ? "文件夹" : "文件"} ${item.name}`} disabled={disabled} onClick={() => toggleSelection(item.path)}><span className="drive-check" aria-hidden="true">{selected.has(item.path) && <Check size={14} />}</span>{contents}</button>
        : item.kind === "folder" ? <button className="drive-entry-main" type="button" disabled={disabled || draftName !== null} onClick={() => navigate(item.path)} aria-label={`打开文件夹 ${item.name}`}>{contents}</button>
          : <><button className="drive-entry-main" type="button" disabled={disabled} onClick={() => isImage ? onImage({ url: cloudFileUrl(item.path), name: item.name }) : window.open(cloudFileUrl(item.path), "_blank", "noopener,noreferrer")} aria-label={`查看 ${item.name}`}>{contents}</button><div className="drive-file-links"><a href={cloudFileUrl(item.path)} target="_blank" rel="noreferrer">查看</a><a href={cloudFileUrl(item.path)} download={item.name}>下载</a></div></>}
      {dropTarget === item.path && <span className="drive-drop-label">上传到此文件夹</span>}
    </article>;
  }

  return <div className="modal-backdrop" role="presentation" onMouseDown={close}>
    <section ref={dialog} tabIndex={-1} className="cloud-modal cloud-drive" role="dialog" aria-modal="true" aria-labelledby="cloud-title" onMouseDown={event => event.stopPropagation()}
      onKeyDown={event => {
        event.stopPropagation();
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
        if (event.key === "Escape") {
          event.preventDefault();
          if (locked.current) return;
          if (draft.current !== null) { draft.current = null; setDraftName(null); setError(""); }
          else if (deleteMode) cancelDeletion(); else close();
        }
        if (event.key === "Tab") {
          const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled)') || []).filter(element => element.getClientRects().length);
          const first = controls[0], last = controls.at(-1);
          if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
      }}
      onPaste={event => { const pasted = clipboardFiles(event.clipboardData); if (pasted.length) { event.preventDefault(); void upload(pasted, path); } }}
      onDragOver={event => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); event.dataTransfer.dropEffect = noUpload ? "none" : "copy"; } }}
      onDrop={event => { if (event.dataTransfer.types.includes("Files")) drop(event, path); }}>
      <button className="modal-close" type="button" disabled={busy} onClick={close} aria-label="关闭云盘" ><X size={18} aria-hidden="true" /></button>
      <div className="cloud-heading"><div><span className="eyebrow">ROOM DRIVE</span><h2 id="cloud-title">云盘</h2></div><div className={status?.warning ? "cloud-meter warning" : "cloud-meter"}><span><i style={{ width: `${status?.percent || 0}%` }} /></span><small>{status ? `${cloudFileSize(status.usedBytes)} / ${cloudFileSize(status.limitBytes)}` : "正在读取容量…"}</small></div></div>
      {status?.warning && <p className="cloud-capacity-warning">容量已达到上限的 90%，请清理空间后继续上传。</p>}
      <div className="cloud-toolbar">
        <button className="drive-icon-button" type="button"  aria-label="返回上一级文件夹" disabled={!path || disabled || deleteMode || draftName !== null} onClick={() => navigate(path.split("/").slice(0, -1).join("/"))}><FolderUp size={20} aria-hidden="true" /></button>
        <strong >/{path}</strong>
        {deleteMode && <button className="drive-icon-button" type="button"  aria-label="取消删除模式" disabled={busy} onClick={cancelDeletion}><X size={18} aria-hidden="true" /></button>}
        <button className={`drive-icon-button drive-delete-mode${deleteMode ? " active" : ""}`} type="button"  aria-label={deleteLabel} aria-pressed={deleteMode} disabled={disabled || draftName !== null} onClick={() => void deleteSelection()}>{busy && deleteMode ? <Loader2 className="drive-spinner" size={20} /> : <Trash2 size={20} aria-hidden="true" />}{deleteMode && selected.size > 0 && <span className="drive-selection-count">{selected.size}</span>}</button>
        <button type="button" onClick={() => fileInput.current?.click()} disabled={noUpload}><Upload size={18} aria-hidden="true" /><span>上传文件</span></button>
        <input ref={fileInput} type="file" multiple hidden onChange={event => { const chosen = Array.from(event.currentTarget.files || []); event.currentTarget.value = ""; void upload(chosen, path); }} />
      </div>
      <div className={`cloud-dropzone${dropTarget === path ? " drive-drop-current" : ""}${busy ? " uploading" : ""}`} aria-busy={disabled}
        onDragEnter={event => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); dragDepth.current++; } }}
        onDragOver={event => { if (!event.dataTransfer.types.includes("Files")) return; event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = noUpload ? "none" : "copy"; if (!noUpload) setDropTarget(destinationAt(event)); }}
        onDragLeave={() => { dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDropTarget(null); }}
        onDrop={event => drop(event, destinationAt(event))}>
        {loading ? <div className="cloud-empty">正在加载…</div> : <>
          {folders.map(renderItem)}
          {!deleteMode && <div className="drive-entry folder drive-new-folder">{draftName !== null ? <div className="drive-entry-main"><FolderArtwork /><input ref={nameInput} aria-label="新文件夹名称" value={draftName} disabled={busy} maxLength={180} onChange={event => { draft.current = event.target.value; setDraftName(event.target.value); }} onBlur={() => void saveFolder()} onKeyDown={event => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); void saveFolder(); } }} /><small>Enter 保存 · Esc 取消</small></div> : <button className="drive-entry-main" type="button" disabled={disabled} onClick={startFolder}  aria-label="新建文件夹"><FolderArtwork draft /><strong>新建文件夹</strong></button>}</div>}
          {files.map(renderItem)}
          {deleteMode && !items.length && <div className="cloud-empty">当前文件夹没有可删除的项目</div>}
        </>}
      </div>
      <footer className="drive-footer"><div role="status"><span>{notice || (deleteMode ? `已选 ${selected.size} / ${items.length} 项，再次点按垃圾桶删除` : dropTarget !== null ? `松开上传到 /${dropTarget}` : "可粘贴或拖入文件，拖到文件夹上可直接存入")}</span>{deleteMode && <small>选中文件夹会一并删除其中的内容</small>}{error && <p className="drive-error">{error}</p>}</div>{deleteMode && <button className="drive-select-all" type="button"  aria-label={allSelected ? "取消全选" : "全选"} aria-pressed={allSelected} disabled={disabled || !items.length} onClick={() => setSelected(allSelected ? new Set() : new Set(items.map(item => item.path)))}><SquareCheckBig size={21} aria-hidden="true" /></button>}</footer>
    </section>
  </div>;
}
