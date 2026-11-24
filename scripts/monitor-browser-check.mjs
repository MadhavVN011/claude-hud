import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import assert from 'node:assert/strict';
import {createMonitorServer} from '../monitor/server.ts';
import {serverConfig} from '../monitor/config.ts';
import {secret,hash} from '../monitor/protocol.ts';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hud-browser-'));
const token=secret();const app=createMonitorServer(serverConfig({host:'127.0.0.1',port:8787,database:path.join(dir,'db.sqlite'),adminToken:token}),{log:()=>{}});
app.server.listen(0,'127.0.0.1');await once(app.server,'listening');const origin='http://127.0.0.1:'+app.server.address().port;
const now=Date.now();
for (const [index,name] of ['Linux-Desktop','Windows-Laptop','Windows-PC'].entries()){
 const e=app.store.enrollment(name,now);const id=(await import('node:crypto')).randomUUID();const status={hostname:name.toLowerCase(),os:index?'win32':'linux',version:'1.0.0',claudeAvailable:true,dataAvailable:true,localEvents:30,localTokens:123456,errors:{}};
 app.store.register(e.enrollment,id,status,now);
 const events=Array.from({length:24},(_,i)=>({id:hash(name+i),session:hash(name+'session'+Math.floor(i/4)),project:hash('project'+i%2),projectLabel:i%2?'Dashboard':'Automation',model:i%3?'claude-sonnet-test':'claude-opus-test',at:now-i*3600000,input:1200*(index+1),output:360*(i%3+1),cacheCreation:2500,cacheRead:12000*(index+1)}));
 app.store.ingest(id,events,status,index?null:{source:'claude-code-statusline',at:now,fiveHour:{used:42,resetAt:now+3600000},sevenDay:{used:23,resetAt:now+4*86400000}},now);
}
const desktopPath=path.join(os.tmpdir(),'claude-hud-monitor-desktop.png');
const mobilePath=path.join(os.tmpdir(),'claude-hud-monitor-mobile.png');
let chrome,ws;
try{
 // Only generated metrics are loaded into this isolated, disposable browser profile.
 chrome=spawn(process.env.CHROME_BIN??'google-chrome',['--headless=new','--no-sandbox','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-port=0','--user-data-dir='+path.join(dir,'chrome')],{stdio:['ignore','ignore','pipe']});
 let output='';let resolveDev,rejectDev;const dev=new Promise((r,j)=>{resolveDev=r;rejectDev=j});chrome.stderr.on('data',c=>{output+=c;const match=/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(output);if(match)resolveDev(Number(match[1]));});chrome.on('exit',()=>rejectDev(new Error('chrome exited')));
 chrome.on('error',rejectDev);
 const port=await Promise.race([dev,new Promise((_,j)=>{const timer=setTimeout(()=>j(new Error('chrome startup timeout; set CHROME_BIN')),10000);timer.unref()})]);
 const target=await(await fetch('http://127.0.0.1:'+port+'/json/new?'+origin,{method:'PUT'})).json();
 ws=new WebSocket(target.webSocketDebuggerUrl);await once(ws,'open');let sequence=0;const pending=new Map();const errors=[];
 ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result)}else if(m.method==='Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text)});
 const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}))});
 const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.text);return r.result.value;};
 const wait=async expression=>{for(let i=0;i<100;i++){if(await evaluate(expression))return;await new Promise(r=>setTimeout(r,50));}throw new Error('condition timeout: '+expression)};
 await send('Runtime.enable');await send('Page.enable');await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1100,deviceScaleFactor:1,mobile:false});
 await wait("document.querySelector('#login-form')");
 await evaluate(`document.querySelector('#admin-token').value=${JSON.stringify(token)};document.querySelector('#login-form').requestSubmit()`);
 await wait("document.querySelectorAll('.device-card').length===3 && document.querySelectorAll('#daily-chart svg').length===1");
 assert.equal(await evaluate("document.querySelector('#app-error').hidden"),true);
 assert.equal(await evaluate("document.querySelectorAll('#quota-windows .quota-value')[0].textContent.includes('42')"),true);
 const screenshot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(desktopPath,Buffer.from(screenshot.data,'base64'));
 await evaluate("document.querySelector('.device-card').click()");await wait("!document.querySelector('#detail-section').hidden && document.querySelector('#detail-title').textContent.includes('Linux-Desktop')");
 assert.equal(await evaluate("document.querySelector('#device-filter').value===location.hash.split('/')[1]"),true);
 await evaluate("location.hash='manage'");await wait("!document.querySelector('#manage-section').hidden");
 await evaluate("document.querySelector('#new-device-name').value='Workstation';document.querySelector('#enroll-form').requestSubmit()");await wait("!document.querySelector('#enrollment-result').hidden && document.querySelectorAll('.manage-card').length===4");
 assert.equal(await evaluate("document.querySelector('#enrollment-token').value.length>32"),true);
 await evaluate("window.prompt=()=> 'Renamed-Linux';document.querySelector('[data-action=rename]').click()");await wait("document.querySelector('#management-devices').textContent.includes('Renamed-Linux')");
 await evaluate("location.hash='overview';document.querySelector('#device-filter').value='';document.querySelector('#device-filter').dispatchEvent(new Event('change'))");await wait("!document.querySelector('#overview-section').hidden");
 await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
 await new Promise(r=>setTimeout(r,500));
 assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"),true,'mobile horizontal overflow');
 const mobile=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(mobilePath,Buffer.from(mobile.data,'base64'));
 await evaluate("document.querySelector('#logout').click()");await wait("!document.querySelector('#login').hidden");
 assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:true,checks:['login','native quota','device charts','device detail route','enrollment','rename','mobile overflow','lock'],screenshots:[desktopPath,mobilePath]}));
}finally{if(ws)ws.close();if(chrome&&chrome.pid&&chrome.exitCode===null){chrome.kill();await once(chrome,'exit').catch(()=>{});}await app.close();fs.rmSync(dir,{recursive:true,force:true});}
