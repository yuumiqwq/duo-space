"use client";
import { useRef, type ReactNode } from 'react';
import { Mic, MonitorUp, Video } from 'lucide-react';
import { classroomSettingsDraft, type ClassroomProfile, type ClassroomSettingsDraft } from './classroom-members';
import { useDeviceFont } from './use-device-font';
import { RoomSettings } from './RoomSettings';
import { SlidersHorizontal } from 'lucide-react';

export function ActivityInput({ value, onChange, readOnly = false }: { value: string; onChange: (value: string) => void; readOnly?: boolean }) {
  const composing = useRef(false);
  const beforeComposition = useRef(value);
  const fits = (element: HTMLTextAreaElement) => element.scrollHeight <= element.clientHeight + 1;
  return <textarea aria-label="我正在" value={value} placeholder="正在…" rows={3} maxLength={80} readOnly={readOnly}
    onCompositionStart={() => { composing.current = true; beforeComposition.current = value; }}
    onCompositionEnd={event => {
      composing.current = false;
      const element = event.currentTarget;
      const next = fits(element) ? element.value : beforeComposition.current;
      element.value = next;
      onChange(next);
    }}
    onChange={event => {
      const element = event.currentTarget;
      if (composing.current || fits(element) || element.value.length < value.length) onChange(element.value);
      else element.value = value;
    }}
    onKeyDown={event => {
      if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      const input = event.currentTarget;
      input.form?.requestSubmit();
      input.blur();
    }} />;
}

export function DeviceIdentity({ name }: { name: string }) {
  return <div className="device-identity"><strong className="device-name" >{name}</strong></div>;
}

export function DeviceMediaControls({ screen, camera, microphone = false, self, onScreen, onCamera, onMicrophone }: {
  screen: boolean; camera: boolean; microphone?: boolean; self: boolean; onScreen?: () => void; onCamera?: () => void; onMicrophone?: () => void;
}) {
  return <div className="device-media-status" role="group" aria-label="投屏、视频与麦克风">
    <button type="button" className={screen ? 'is-live' : ''} onClick={onScreen} disabled={!onScreen}  aria-label={screen ? '投屏中' : '开启投屏'} aria-pressed={screen}>{screen ? <span>投屏中</span> : <MonitorUp aria-hidden="true" />}</button>
    <button type="button" className={camera ? 'is-live' : ''} onClick={onCamera} disabled={!onCamera}  aria-label={camera ? '视频中' : '开启视频'} aria-pressed={camera}>{camera ? <span>视频中</span> : <Video aria-hidden="true" />}</button>
    <button type="button" className={microphone ? 'is-live' : ''} onClick={onMicrophone} disabled={!self || !onMicrophone}  aria-label={microphone ? '关闭麦克风' : '打开麦克风'} aria-pressed={microphone}>{microphone ? <span>语音中</span> : <Mic aria-hidden="true" />}</button>
  </div>;
}

export function DeviceCard({ kind, name, online, screen, camera, microphone, self, onScreen, onCamera, onMicrophone, children, font = 'resource-rounded' }: {
  kind: 'tablet' | 'laptop'; name: string; online: boolean; screen: boolean; camera: boolean; microphone?: boolean; self: boolean;
  onScreen?: () => void; onCamera?: () => void; onMicrophone?: () => void; children: ReactNode; font?: string;
}) {
  const deviceFont = useDeviceFont(font, online);
  return <section className={`device-card device-${kind}${online ? ' is-online' : ' is-offline'}`} aria-label={`${name}的${kind === 'tablet' ? '平板电脑' : '笔记本电脑'}${online ? '' : '，未入会'}`}>
    <span className="device-shell" aria-hidden="true" />
    {online && <div className="device-screen" data-font-status={deviceFont.status} aria-busy={deviceFont.status === 'loading'}>
      <DeviceIdentity name={name} />
      <DeviceMediaControls screen={screen} camera={camera} microphone={microphone} self={self} onScreen={onScreen} onCamera={onCamera} onMicrophone={onMicrophone} />
      <div className="device-activity">{children}</div>
      {deviceFont.status === 'loading' && <span className="device-font-loading" role="status" aria-label="字体加载中" />}
      {deviceFont.status === 'error' && <button type="button" className="device-font-retry" onClick={deviceFont.retry}>字体加载失败 · 重试</button>}
    </div>}
  </section>;
}

export function ClassroomGeneralSettings({ draft, onChange, disabled }: { draft: ClassroomSettingsDraft; onChange: (draft: ClassroomSettingsDraft) => void; disabled?: boolean }) {
  return <div className="classroom-general-settings">
    <fieldset className="settings-seat-row" disabled={disabled}>
      <legend>座位</legend>
      <div className="settings-seat-choices">
        <label><input type="radio" name="classroom-seat" value="tablet" checked={draft.seat === 'tablet'} onChange={() => onChange({ ...draft, seat: 'tablet' })} /><span>平板电脑</span></label>
        <label><input type="radio" name="classroom-seat" value="laptop" checked={draft.seat === 'laptop'} onChange={() => onChange({ ...draft, seat: 'laptop' })} /><span>笔记本电脑</span></label>
      </div>
    </fieldset>
  </div>;
}

export function ClassroomSettings({ profile, identityId, onSave, error, triggerContent, notifications }: { profile: ClassroomProfile; identityId: string; onSave: (draft: ClassroomSettingsDraft) => Promise<void> | void; error?: string; triggerContent: ReactNode; notifications?: ReactNode }) {
  const value = classroomSettingsDraft(profile, identityId);
  const canSave = value.seat !== null && profile.seats.length === 2;
  return <RoomSettings value={value} onSave={onSave} canSave={canSave} error={error} triggerContent={triggerContent} sections={[
    { id: 'general', label: '通用', icon: <SlidersHorizontal size={18} />, content: (draft, onChange, saving) => <ClassroomGeneralSettings draft={draft} onChange={onChange} disabled={saving || !canSave} /> },
    ...(notifications ? [{ id: 'notifications', label: '消息提醒', icon: null, content: () => notifications }] : []),
  ]} />;
}
