"use client";
import { useEffect, useState } from 'react';
import { Paperclip, Mic, Send, ChevronLeft, ChevronRight } from 'lucide-react';
import { BlackboardSurface, ClassroomFullscreenIcon, ClassroomProp, EmergencyExit, IdleChalkboard, ProjectorControl, useClassroomDate, useProjectionCurtain } from '../ClassroomScene';
import { ActivityInput, DeviceCard, ClassroomSettings } from '../ClassroomDevices';
import { applyClassroomAction, CLASSROOM_DEVICE_FONT, fixedClassroomSeats, type ClassroomSettingsDraft, type ClassroomProfile } from '../classroom-members';
import { useClassroomBoards } from '../use-classroom-boards';
import { adjacentBoardId, orderClassroomBoards } from '../classroom-boards';
import { ClassroomTodoCard, useClassroomTodoClock } from '../ClassroomTodo';
import { classroomTodoTasks, classroomTodoWindow } from '../classroom-todo';
import { ProjectionSample } from './ProjectionSample';
import { usePreviewMedia } from './use-preview-media';
import { RoomCollaboration } from '../RoomCollaboration';
import { CloudDrive } from '../CloudDrive';
import { ChatImageViewer, type ViewedChatImage } from '../ChatImageViewer';
import { RoomBell } from '../RoomBell';
import { createTaskboardPreviewSnapshot } from './taskboard/sample';
import { Whiteboard, type RoomBoard } from '../Whiteboard';
import { INITIAL_BOARD_EPOCH, normalizeBoard } from '../board-state';
import { useMainFullscreen } from '../use-main-fullscreen';
import { BoardTonePicker } from './BoardTonePicker';
import { boardToneStyle, getBoardTone, type BoardTone } from './board-tones';
import '../main-fullscreen.css';
import '../classroom.css';

const previewTasks = [{id:'one',title:'整理今天的课堂笔记'}, {id:'two',title:'完成数据结构练习'}, {id:'three',title:'一起复习本周的内容'}];
const additionalTasks = ['补充实验报告', '整理错题', '完成阅读记录', '准备下次讨论', '核对本周作业', '复习上节课的例题', '整理学习资料'].map((title, index) => ({id:'extra-'+index, title}));
const longTitleTasks = [previewTasks[0], {id:'long-title',title:'整理今天的课堂笔记，并补充数据结构练习中没有完成的推导过程'}, previewTasks[1], {id:'last-long',title:'一起复习本周的内容，核对课堂例题并整理下一次讨论需要用到的资料'}, ...additionalTasks];
export function ClassroomPreview({ initialBoardTone = 'deep' }: { initialBoardTone?: string }) {
  const [boardToneId, setBoardToneId] = useState(() => getBoardTone(initialBoardTone).id);
  const boardTone = getBoardTone(boardToneId);
  const changeBoardTone = (tone: BoardTone) => {
    setBoardToneId(tone.id);
    const url = new URL(window.location.href);
    if (tone.id === 'deep') url.searchParams.delete('board');
    else url.searchParams.set('board', tone.id);
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  };
  useEffect(() => {
    const syncTone = () => setBoardToneId(getBoardTone(new URL(window.location.href).searchParams.get('board')).id);
    window.addEventListener('popstate', syncTone);
    return () => window.removeEventListener('popstate', syncTone);
  }, []);
  const date = useClassroomDate();
  const [side, setSide] = useState('chat');
  const [selfOnline,setSelfOnline] = useState(true);
  const [moreTasks, setMoreTasks] = useState(false), [longTitles, setLongTitles] = useState(false);

  const [peerScreen, setPeerScreen] = useState(false), [peerCamera, setPeerCamera] = useState(false), [peerOnline, setPeerOnline] = useState(true);
  const [multiDevice, setMultiDevice] = useState(false), [badge, setBadge] = useState(6);
  const [profile, setProfile] = useState<ClassroomProfile>({members:[{id:'self',name:'11',activity:'复习数据结构'},{id:'peer',name:'11scat',activity:'整理课堂笔记'}],seats:['self','peer'],font:CLASSROOM_DEVICE_FONT});
  const [settingsIdentity, setSettingsIdentity] = useState('self');
  const saveSettings = (draft: ClassroomSettingsDraft) => {
    if (!draft.seat) throw new Error('请选择座位');
    setProfile(applyClassroomAction(profile, settingsIdentity, { action: 'save-settings', seat: draft.seat }));
  };
  const [activity,setActivity] = useState('复习数据结构');
  const {boards,setBoards,activeBoardId,setActiveBoardId,createAndSelect} = useClassroomBoards();
  const todoNow = useClassroomTodoClock();
  const [completed,setCompleted] = useState<Record<string,string>>({});
  const [notes,setNotes] = useState<Record<string,string>>({});
  const todoWindow = classroomTodoWindow(todoNow ?? 0);
  const todoItems = (longTitles ? longTitleTasks : moreTasks ? [...previewTasks,...additionalTasks] : previewTasks).map(task => ({...task,dueDate:new Date(todoWindow.end - 3_600_000).toISOString(),done:completed[task.id]===todoWindow.day,completedDay:completed[task.id]}));
  const [activeMediaId,setActiveMediaId] = useState('');
  const [notice,setNotice] = useState('');
  const localMedia = usePreviewMedia(setNotice);
  const selfScreen = !!localMedia.streams.screen, selfCamera = !!localMedia.streams.camera, microphone = !!localMedia.streams.microphone;
  const [cloudOpen, setCloudOpen] = useState(false);
  const [viewedImage, setViewedImage] = useState<ViewedChatImage | null>(null);
  const [bellHost, setBellHost] = useState<HTMLDivElement | null>(null);
  const [taskboardSnapshot] = useState(createTaskboardPreviewSnapshot);
  const media = [{id:'self-screen',label:'11 · 投屏',on:selfScreen},{id:'self-camera',label:'11 · 摄像头',on:selfCamera},{id:'peer-screen',label:'11scat · 投屏',on:peerOnline && peerScreen},{id:'peer-camera',label:'11scat · 摄像头',on:peerOnline && peerCamera}].filter(item=>item.on);
  const activeMedia = media.find(item=>item.id===activeMediaId) || media[0];
  const board = boards.find(item=>item.id===activeBoardId);
  const boardIndex = board ? orderClassroomBoards(boards).findIndex(item=>item.id===board.id)+1 : 0;
  const projection = useProjectionCurtain(activeMedia);
  const {stageRef,fullscreen,toggleFullscreen}=useMainFullscreen();
  const createBoard = () => {
    if(boards.length>=12) {setNotice('最多保留 12 张画板');return;}
    const next:RoomBoard={id:crypto.randomUUID(),name:'画板 '+(boards.length+1),strokes:[],texts:[],deletedStrokeIds:[],deletedTextIds:[],epoch:INITIAL_BOARD_EPOCH,createdAt:Date.now()};
    createAndSelect(next);projection.fold();
  };
  const updateBoard=(change:(current:RoomBoard)=>RoomBoard)=>setBoards(items=>items.map(item=>item.id===activeBoardId?change(item):item));
  const stepBoard=(direction:-1|1)=>{setActiveBoardId(adjacentBoardId(boards,activeBoardId,direction));projection.fold();};
  const toggleSelf=async (kind:'screen'|'camera'|'microphone')=>{if(!selfOnline)return;if(await localMedia.toggle(kind) && kind!=='microphone'){setActiveMediaId('self-'+kind);projection.reveal();}};
  const view=(id:string)=>{setActiveMediaId(id);projection.reveal();};
  const stepMedia=(direction:number)=>{const current=media.findIndex(item=>item.id===activeMedia?.id);setActiveMediaId(media[(current+direction+media.length)%media.length].id);};
  return <main className="app-shell classroom-scene" data-device-font={profile.font} style={boardToneStyle(boardTone)} aria-label="本地教室外观预览">
    <section className="workspace"><section className="focus-stage panel"><div className="share-canvas" ref={stageRef}><div className="stage-content">
      <ProjectorControl open={projection.open} hasSource={!!activeMedia} onClick={projection.toggle} />
      {!projection.open && <BlackboardSurface index={boardIndex} count={boards.length+1} onStep={stepBoard} drawing={!!board}>
      {!board && !projection.open && <IdleChalkboard date={date} tasks={longTitles?longTitleTasks:moreTasks?[...previewTasks,...additionalTasks]:previewTasks}/>}
      {board && <Whiteboard key={board.id} board={board} onDelete={()=>{setBoards(items=>items.filter(item=>item.id!==board.id));projection.fold();}} fullscreen={fullscreen} onToggleFullscreen={toggleFullscreen}
        onAddStroke={(stroke,epoch)=>updateBoard(current=>current.epoch===epoch?{...current,strokes:[...current.strokes.filter(item=>item.id!==stroke.id),stroke]}:current)}
        onDeleteStroke={id=>updateBoard(current=>({...current,strokes:current.strokes.filter(item=>item.id!==id),deletedStrokeIds:[...current.deletedStrokeIds,id]}))}
        onClear={()=>updateBoard(current=>({...current,strokes:[],texts:[],epoch:Date.now()+':clear'}))}
        onUpsertText={text=>updateBoard(current=>({...current,texts:[...current.texts.filter(item=>item.id!==text.id),text]}))}
        onDeleteText={id=>updateBoard(current=>({...current,texts:current.texts.filter(item=>item.id!==id),deletedTextIds:[...current.deletedTextIds,id]}))}
        onSaved={message=>setNotice(message)} onExport={async blob=>{const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download='classroom-board.png';link.click();setTimeout(()=>URL.revokeObjectURL(url),30000);}} />}
      {!board && <button className={'main-fullscreen-button'+(projection.open?'':' is-chalk')} aria-label={fullscreen?'退出主窗口全屏':'主窗口全屏'} onClick={()=>void toggleFullscreen()}><ClassroomFullscreenIcon fullscreen={fullscreen} chalk={!projection.open}/></button>}
      </BlackboardSurface>}
      <div className={projection.open?'projection-sheet is-open':'projection-sheet'} aria-hidden={!projection.open}>{projection.open && activeMedia && <><ProjectionSample key={activeMedia.id} source={activeMedia.id} stream={activeMedia.id==='self-screen'?localMedia.streams.screen:activeMedia.id==='self-camera'?localMedia.streams.camera:null}/>{media.length>1 && <><button className="media-nav media-prev" aria-label="查看上一个画面" onClick={()=>stepMedia(-1)}><ChevronLeft/></button><button className="media-nav media-next" aria-label="查看下一个画面" onClick={()=>stepMedia(1)}><ChevronRight/></button></>}<div className="media-caption">{activeMedia.label}<span>{media.indexOf(activeMedia)+1} / {media.length}</span></div></>}</div>
      {projection.open && <button className="main-fullscreen-button" aria-label={fullscreen?'退出主窗口全屏':'主窗口全屏'} onClick={()=>void toggleFullscreen()}><ClassroomFullscreenIcon fullscreen={fullscreen} chalk={false}/></button>}
    </div></div></section>
      <aside className="side-panel panel"><div className="side-tabs"><button className={side==='chat'?'active':''} onClick={()=>setSide('chat')}>传纸条</button><button className={side==='tasks'?'active':''} onClick={()=>setSide('tasks')}>今日任务</button><div className="chat-bell-host" ref={setBellHost} /></div>
      {side==='chat'? <div className="chat-view"><div className="message-list"><div className="message"><span>11 · 10:24</span><p>今天先把作业做完，再一起看看昨天的笔记。</p></div><div className="message own"><span>11scat · 10:24</span><p>好，做完了在任务板提交。</p></div></div><form className="chat-form" onSubmit={e=>e.preventDefault()}><div className="chat-input-row"><button className="chat-attach-button" aria-label="添加附件"><Paperclip /></button><button className="voice-record-button" aria-label="录音"><Mic /></button><textarea aria-label="输入房间消息" rows={2}/><button className="primary-button chat-send-button" aria-label="发送"><Send size={16}/></button></div></form></div>:
      <div className="task-view"><div className="task-scroll">{['11','11scat'].map((name,i)=><ClassroomTodoCard key={name} name={name} tasks={classroomTodoTasks(todoItems.slice(i),todoNow ?? 0)} note={notes[name] || ''} onNoteSave={value=>setNotes(items=>({...items,[name]:value}))} onComplete={task=>setCompleted(items=>({...items,[task.id]:todoWindow.day}))}/>)}</div></div>}</aside>
    </section>
    <div className="scene-desks">{fixedClassroomSeats(profile).map((member,index)=><div className="classroom-desk" key={index}><DeviceCard font={profile.font} kind={index===0?'tablet':'laptop'} name={member.name} online={member.id==='self'?selfOnline:peerOnline} self={member.id==='self'} screen={member.id==='self'?selfScreen:peerScreen} camera={member.id==='self'?selfCamera:peerCamera} microphone={member.id==='self' && microphone} onMicrophone={member.id==='self'?()=>void toggleSelf('microphone'):undefined}
      onScreen={member.id==='self'?()=>toggleSelf('screen'):peerScreen?()=>view('peer-screen'):undefined} onCamera={member.id==='self'?()=>toggleSelf('camera'):peerCamera?()=>view('peer-camera'):undefined}>
      {member.id==='self'?<form className="activity-box" onSubmit={event=>event.preventDefault()}><ActivityInput value={activity} onChange={setActivity}/></form>:<p>{member.activity}</p>}
    </DeviceCard></div>)}
    <div className="classroom-desk desk-media"><button className="object-button" aria-label="画板" onClick={createBoard}><ClassroomProp name="chalk-cup"/></button><button className="object-button calendar-entry-button" aria-label="双人日历"><ClassroomProp name="calendar-entry"/></button><RoomCollaboration identityId="self" previewSnapshot={taskboardSnapshot} previewAutoOpen={false} onChanged={async()=>true} triggerContent={<><ClassroomProp name="taskboard"/>{badge>0&&<i aria-hidden="true">{badge}</i>}</>}/></div>
    <div className="classroom-desk desk-room"><button className="object-button cloud-entry-button" aria-label="云盘" onClick={()=>setCloudOpen(true)}><ClassroomProp name="folder"/></button><ClassroomSettings key={settingsIdentity} profile={profile} identityId={settingsIdentity} onSave={saveSettings} triggerContent={<ClassroomProp name="settings"/>} /></div></div>
    <EmergencyExit onClick={()=>{localMedia.stopAll();window.location.assign('/access');}}/>
    <RoomBell triggerHost={bellHost} onShowChat={()=>setSide('chat')}/>
    {cloudOpen && <CloudDrive onClose={()=>setCloudOpen(false)} onImage={setViewedImage}/>}
    {viewedImage && <ChatImageViewer image={viewedImage} onClose={()=>setViewedImage(null)}/>}
    <div className="classroom-preview-toolbar" aria-label="本地预览工具"><span>本地预览</span><BoardTonePicker selected={boardTone} onChange={changeBoardTone}/><button onClick={()=>{setActiveBoardId('');projection.fold();}}>待机</button><button onClick={projection.reveal}>投影</button><button onClick={createBoard}>画板</button><button onClick={()=>setMoreTasks(value=>!value)} aria-pressed={moreTasks}>更多任务</button><button onClick={()=>setLongTitles(value=>!value)} aria-pressed={longTitles}>长标题</button><button onClick={()=>toggleSelf('screen')} aria-pressed={selfScreen}>我的投屏</button><button onClick={()=>setPeerScreen(value=>!value)} aria-pressed={peerScreen}>同桌投屏</button><button onClick={()=>setPeerCamera(value=>!value)} aria-pressed={peerCamera}>同桌摄像头</button><button onClick={()=>{setSelfOnline(value=>!value);localMedia.stopAll();}} aria-pressed={!selfOnline}>本人离开</button><button onClick={()=>setPeerOnline(value=>!value)} aria-pressed={!peerOnline}>同桌离开</button><button onClick={()=>setMultiDevice(value=>!value)} aria-pressed={multiDevice}>同账号多端</button>{multiDevice&&<span>同桌 2 台设备</span>}<button onClick={()=>setBadge(value=>value?0:6)}>任务板角标</button><button onClick={()=>{setSettingsIdentity(value=>value==='self'?'peer':'self');}}>设置视角 · {settingsIdentity==='self'?'11':'11scat'}</button><a href="/classroom-preview/chalk-art">粉笔图案样例</a>{board&&<><button onClick={()=>{const next=normalizeBoard(JSON.parse(JSON.stringify(board)));if(next)updateBoard(()=>next);}}>重新载入笔迹</button><span>{board.strokes.length} 笔 · {board.strokes.at(-1)?.points.length || 0} 点</span></>}{notice&&<span role="status">{notice}</span>}</div>
  </main>;
}
