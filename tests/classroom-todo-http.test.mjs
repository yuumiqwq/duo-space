import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createHmac, randomUUID } from 'node:crypto';
import { encryptToken } from '../app/api/ticktick/crypto.ts';
import { classroomTodoWindow } from '../app/classroom-todo.ts';

test('todo routes preserve checked tasks for both devices and save only the authenticated member note', {timeout:40000}, async()=>{
  await mkdir('codex-generated/test-data',{recursive:true});
  const dir=await mkdtemp(path.resolve('codex-generated/test-data/todo-http-'));
  const secret=randomUUID(), original=process.env.TICKTICK_STORAGE_SECRET;
  process.env.TICKTICK_STORAGE_SECRET=secret;
  const users=Object.fromEntries(['alice','bob'].map(id=>[id,{nickname:id,ticktickToken:encryptToken('fixture-'+id)}]));
  if(original===undefined)delete process.env.TICKTICK_STORAGE_SECRET;else process.env.TICKTICK_STORAGE_SECRET=original;
  await writeFile(path.join(dir,'identities.json'),JSON.stringify({version:1,users}));
  const window=classroomTodoWindow(), date=new Date(window.end-3600000).toISOString();
  const t=(id,title,status=0)=>({id,title,projectId:'inbox-alice',dueDate:date,status});
  const oldDate=new Date(window.start-3600000).toISOString();
  const oldHistory=Object.fromEntries(Array.from({length:200},(_,i)=>[`old-${i}`,{...t(`old-${i}`,'窗口外的完成历史',2),dueDate:oldDate}]));
  const allDayDate = new Date(Date.parse(`${window.day}T00:00:00+0800`)).toISOString();
  const extra = {
    overduedone: { ...t('overduedone','今天完成的过期任务',2), dueDate: oldDate, completedTime: new Date().toISOString() },
    overduestart: { ...t('overduestart','只有开始日期的过期全天任务'), dueDate: undefined, startDate: new Date(Date.parse(allDayDate)-86400000).toISOString(), isAllDay: true },
    allday: { ...t('allday','当日全天'), dueDate: allDayDate, isAllDay: true },
    alldaydone: { ...t('alldaydone','已完成全天',2), dueDate: undefined, startDate: allDayDate, isAllDay: true },
    laterstart: { ...t('laterstart','按较晚开始时间'), dueDate: oldDate, startDate: date },
    laterend: { ...t('laterend','按较晚结束时间'), startDate: oldDate },
    startoutside: { ...t('startoutside','开始时间在窗口外'), startDate: new Date(window.end).toISOString() },
  };
  await writeFile(path.join(dir,'fake-dida.json'),JSON.stringify({alice:{...extra,overdue:{...t('overdue','窗口外逾期'),dueDate:oldDate},one:t('one','待勾选'),history:t('history','已在滴答完成',2),future:{...t('future','未来任务'),dueDate:new Date(window.next+86400000).toISOString()},...oldHistory},bob:{}}));
  const socket=createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
  const child=spawn(process.execPath,['--import','./tests/helpers/dida-fixture.mjs','node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port',String(port)],{env:{...process.env,DATA_DIR:dir,AUTH_SESSION_SECRET:secret,TICKTICK_STORAGE_SECRET:secret},stdio:'ignore',windowsHide:true});
  const origin=`http://127.0.0.1:${port}`;
  const cookie=id=>{const payload=`${id}.${Math.floor(Date.now()/1000)+600}`;return `ss_access=${payload}.${createHmac('sha256',secret).update(payload).digest('base64url')}`;};
  const call=(id,route,body,method='POST',headers={})=>fetch(origin+route,{method:body===undefined?'GET':method,redirect:'manual',headers:{Cookie:cookie(id),Origin:origin,'Content-Type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
  try{
    let ready=false;for(let i=0;i<80;i++){try{if((await call('alice','/api/room/classroom')).ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,200));}assert.ok(ready);
    const tasksUrl='/api/ticktick/tasks?view=today&classroom=1';
    let response=await call('alice',tasksUrl);assert.equal(response.status,200);let data=await response.json();
    assert.deepEqual(data.tasks.map(t=>t.id).sort(),['allday','alldaydone','history','laterend','laterstart','one','overdue','overduedone','overduestart']);assert.equal(data.tasks.find(t=>t.id==='history').done,true);
    assert.equal(data.tasks.find(t=>t.id==='overduedone').done,true);
    assert.equal(data.tasks.find(t=>t.id==='overduedone').completedDay,window.day);
    assert.equal(data.tasks.find(t=>t.id==='overdue').dueDate,oldDate,'including overdue tasks must preserve their original dates');
    assert.equal(data.tasks.find(t=>t.id==='alldaydone').done,true);
    assert.equal(data.tasks.find(t=>t.id==='laterstart').startDate,date,'the browser and peer must retain the later start time');
    assert.equal(data.inboxError,undefined,'historical record count must not warn or expand the current task window');
    assert.equal((await call('alice','/api/ticktick/complete',{projectId:'inbox-alice',taskId:'one',ownerId:'bob'})).status,403);
    assert.equal((await call('alice','/api/ticktick/complete',{projectId:'inbox-alice',taskId:'one'})).status,204);
    assert.equal((await call('alice','/api/ticktick/complete',{projectId:'inbox-alice',taskId:'overdue'})).status,204);
    // Remove the external history: a fresh device must still read our saved check.
    const external=JSON.parse(await readFile(path.join(dir,'fake-dida.json'),'utf8'));delete external.alice.one;delete external.alice.overdue;await writeFile(path.join(dir,'fake-dida.json'),JSON.stringify(external));
    data=await (await call('alice',tasksUrl)).json();assert.equal(data.tasks.find(t=>t.id==='one').done,true);assert.equal(data.tasks.find(t=>t.id==='one').completedDay,window.day);
    assert.equal(data.tasks.find(t=>t.id==='overdue').done,true);assert.equal(data.tasks.find(t=>t.id==='overdue').completedDay,window.day);
    assert.deepEqual((await (await call('bob',tasksUrl)).json()).tasks,[]);
    assert.equal((await call('alice','/api/room/todo',{note:'随手记'},'PATCH')).status,200);
    let profile=await (await call('bob','/api/room/classroom')).json();assert.equal(profile.members.find(m=>m.id==='alice').todoNote,'随手记');assert.equal(profile.members.find(m=>m.id==='bob').todoNote,'');
    assert.equal((await call('bob','/api/room/todo',{note:'篡改',identityId:'alice'},'PATCH')).status,400);
    assert.equal((await call('alice','/api/room/todo',{note:'跨站'},'PATCH',{Origin:'https://elsewhere.example'})).status,403);
    assert.equal((await call('alice','/api/room/todo',{note:'换\n行'},'PATCH')).status,400);
    assert.equal((await call('alice','/api/room/todo',{note:'a'.repeat(25)},'PATCH')).status,400);
    assert.equal((await call('alice','/api/room/todo',{note:''},'PATCH')).status,200);
    profile=await (await call('bob','/api/room/classroom')).json();assert.equal(profile.members.find(m=>m.id==='alice').todoNote,'');assert.ok(!JSON.stringify(profile).includes('ticktickToken'));
  }finally{child.kill();await new Promise(resolve=>child.once('exit',resolve));}
});
