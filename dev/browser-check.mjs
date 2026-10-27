// Development-only browser verification. Uses one disposable headless profile.
// Never attaches to the user's browser, Tavern instance, model API, or cards.
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const profile = await mkdtemp(path.join(tmpdir(),'jianlu-browser-'));
const browser = spawn(process.env.JIANLU_TEST_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe', [
    '--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-extensions',
    '--disable-background-networking','--disable-sync','--disable-component-update','--disable-default-apps',
    '--renderer-process-limit=1','--disk-cache-size=1','--media-cache-size=1','--remote-debugging-port=0',
    `--user-data-dir=${profile}`,'about:blank',
], { windowsHide:true, stdio:['ignore','ignore','pipe'] });
let cdp, diagnostics='';
const delay = ms => new Promise(resolve=>setTimeout(resolve,ms));
async function connection(url) {
    const ws = new WebSocket(url), pending = new Map(), errors=[];
    let id=0;
    ws.addEventListener('message',event=>{
        const data=JSON.parse(event.data);
        if(data.method==='Runtime.exceptionThrown')errors.push(data.params.exceptionDetails.exception?.description||data.params.exceptionDetails.text);
        if(data.id){const p=pending.get(data.id);if(p){pending.delete(data.id);data.error?p.reject(new Error(JSON.stringify(data.error))):p.resolve(data.result);}}
    });
    await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
    return { errors, close:()=>ws.close(), send:(method,params={})=>new Promise((resolve,reject)=>{const key=++id;pending.set(key,{resolve,reject});ws.send(JSON.stringify({id:key,method,params}));}) };
}
async function evaluate(body) {
    const data=await cdp.send('Runtime.evaluate',{expression:`(async()=>{const r=document.getElementById('jianlu-extension-host')?.shadowRoot;${body}})()`,awaitPromise:true,returnByValue:true});
    if(data.exceptionDetails)throw new Error(data.exceptionDetails.exception?.description||data.exceptionDetails.text);
    return data.result?.value;
}
async function until(body,label) { for(let i=0;i<100;i++){if(await evaluate(body))return;await delay(60);}throw new Error(`Timed out: ${label}`); }
async function screenshot(name) { await delay(180);const data=await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await writeFile(path.join('dev',name),Buffer.from(data.data,'base64')); }
async function nav(label) { await evaluate(`const b=r.querySelector('.jl-navigation [aria-label=${JSON.stringify(label)}]');if(!b)throw Error('Missing nav');b.click();`); }
const modalCode="const m=[...r.querySelectorAll('.jl-overlays .jl-dialog')].at(-1);const f=s=>[...m.querySelectorAll('label')].find(x=>x.firstChild.textContent===s)?.querySelector('input,select,textarea');";
async function closeModal(){await evaluate("[...r.querySelectorAll('.jl-overlays [aria-label=关闭对话框]')].at(-1).click();");}
const reports=[];
try {
    const endpoint=await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>reject(new Error(`Browser did not start: ${diagnostics.slice(-1000)}`)),12000);
        browser.on('error',error=>{clearTimeout(timer);reject(error);});
        browser.stderr.on('data',bytes=>{diagnostics+=bytes.toString();const match=diagnostics.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(match){clearTimeout(timer);resolve(match[1]);}});
    });
    const origin=`http://${new URL(endpoint).host}`;
    const target=await(await fetch(`${origin}/json/new?about:blank`,{method:'PUT'})).json();
    cdp=await connection(target.webSocketDebuggerUrl);
    await cdp.send('Page.enable');await cdp.send('Runtime.enable');
    for(const [width,height,mobile] of [[1360,900,false],[390,844,true]]) {
        await cdp.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile});
        await cdp.send('Page.navigate',{url:'http://127.0.0.1:18825/'});
        await until("return document.documentElement.dataset.ready==='true';",'demo ready');
        const layout=await evaluate("const a=r.querySelector('.jl-frame').getBoundingClientRect(),n=r.querySelector('.jl-navigation').getBoundingClientRect(),l=r.querySelector('.jl-chunk-list');return {width:innerWidth,height:innerHeight,frame:{x:a.x,y:a.y,width:a.width,height:a.height},navBottom:n.bottom,listHeight:l.clientHeight,listScroll:l.scrollHeight};");
        assert.equal(layout.width,width);assert.ok(layout.frame.height>=height*.94);
        assert.ok(layout.frame.width>=width*(mobile?.99:.94));assert.ok(layout.listHeight>200);
        if(mobile)assert.ok(layout.navBottom>height-10);
        if(!mobile){
            await evaluate("r.querySelector('.jl-chunk-open').click();");await until("return Boolean(r.querySelector('.jl-inline-sheet'));",'inline output');
            await evaluate("const t=r.querySelector('.jl-inline-sheet textarea');t.value+='临时编辑检查';t.dispatchEvent(new Event('input',{bubbles:true}));r.querySelector('.jl-chunk-row input').click();");
            assert.match(await evaluate("return r.querySelector('.jl-inline-sheet textarea').value;"),/临时编辑检查/);
            await evaluate("const t=r.querySelector('.jl-inline-sheet textarea');t.value=t.value.replace('临时编辑检查','');t.dispatchEvent(new Event('input',{bubbles:true}));r.querySelector('.jl-chunk-row input').click();");
        }
        await screenshot(mobile?'ui-mobile.png':'ui-desktop.png');
        if(!mobile)await evaluate("r.querySelector('.jl-inline-sheet [aria-label=关闭文本块详情]').click();");
        const scrolled=await evaluate("const l=r.querySelector('.jl-chunk-list');l.scrollTop=1000;return l.scrollTop;");assert.ok(scrolled>0);
        reports.push({check:'layout',mobile,...layout});
        await nav('资料');
        await until("return r.querySelectorAll('.jl-page-host .jl-library-row').length===3;",'library page');
        assert.equal(await evaluate("return r.querySelectorAll('.jl-library-row-actions button').length;"),6);
        await screenshot(mobile?'ui-mobile-library.png':'ui-library.png');
        await nav('提示词');
        await until("return r.querySelector('.jl-page-surface')?.getAttribute('aria-label')==='提示词';",'prompt page');
        await evaluate("const s=r.querySelector('.jl-page-surface select');s.value='prop';s.dispatchEvent(new Event('change',{bubbles:true}));");
        assert.match(await evaluate("return r.querySelector('.jl-prompt-editor textarea').value;"),/道具/);
        await screenshot(mobile?'ui-mobile-prompts.png':'ui-prompts.png');
        await evaluate("const t=r.querySelector('.jl-prompt-editor textarea');t.value+='\\n浏览器校验条目';t.dispatchEvent(new Event('input',{bubbles:true}));[...r.querySelectorAll('.jl-page-surface .jl-dialog-footer button')].find(b=>b.textContent==='保存').click();");
        await until("return !__jlDemo.app.state.notice&&r.querySelector('.jl-page-surface')?.getAttribute('aria-label')==='提示词';",'prompt save');
        await until("return (await __jlDemo.repo.getLibrary(__jlDemo.app.state.project.id)).prompts?.prop?.includes('浏览器校验条目');",'persisted prompt');
        await nav('资料');await until("return r.querySelectorAll('.jl-page-host .jl-library-row').length===3;",'return library');
        await evaluate("r.querySelector('.jl-library-row-actions button').click();");
        await until("return r.querySelector('.jl-overlays .jl-dialog')?.getAttribute('aria-label')?.includes('提示词');",'object prompt');
        assert.match(await evaluate("return [...r.querySelectorAll('.jl-overlays textarea')].at(-1).value;"),/输出主名称/);
        await closeModal();
        // Verify all three destinations via the real form and mock persistence.
        for(const destination of ['character','world','newWorld']) {
            await evaluate("[...r.querySelectorAll('.jl-library-row-actions button')].find(b=>b.textContent==='写入酒馆').click();");
            await until("return r.querySelector('.jl-overlays .jl-dialog')?.getAttribute('aria-label')==='写入酒馆';",'publish form');
            await evaluate(modalCode+`f('导入到').value=${JSON.stringify(destination)};f('导入到').dispatchEvent(new Event('change',{bubbles:true}));`);
            if(destination==='character')await evaluate(modalCode+"f('目标角色卡').value='second.png';f('目标角色卡').dispatchEvent(new Event('change',{bubbles:true}));");
            if(destination==='world')await evaluate(modalCode+"f('目标世界书').value='示例世界书乙';f('目标世界书').dispatchEvent(new Event('change',{bubbles:true}));");
            if(destination==='newWorld')await evaluate(modalCode+"f('新建名称').value='浏览器示例世界书';");
            if(mobile&&destination==='newWorld')await screenshot('ui-mobile-write.png');
            await evaluate("[...r.querySelectorAll('.jl-overlays .jl-dialog-footer button')].find(b=>b.textContent==='确认导入').click();");
            await until("return !r.querySelector('.jl-overlays .jl-dialog');",'publish finished');
            const result=await evaluate("return __jlDemo.published.at(-1);");
            if(destination==='character')assert.equal(result.target,'second.png');
            else {assert.equal(result.name,destination==='world'?'示例世界书乙':'浏览器示例世界书');assert.equal(result.entries[0].name,'青');assert.equal(result.create,destination==='newWorld');}
        }
        await nav('任务');await until("return !__jlDemo.app.state.busy;",'tasks active');
        await evaluate("r.querySelector('.jl-chunk-row[data-status=pending] input').click();");
        await evaluate("[...r.querySelectorAll('.jl-run-actions button')].find(b=>b.textContent==='任务操作').click();");
        await until("return r.querySelector('.jl-overlays .jl-dialog')?.getAttribute('aria-label')==='任务操作';",'task actions');
        await evaluate("[...r.querySelectorAll('.jl-overlays .jl-dialog-footer button')].find(b=>b.textContent.startsWith('执行选中')).click();");
        await until("return r.querySelector('.jl-live-text')?.value.length>0;",'stream started');
        const first=await evaluate("return r.querySelector('.jl-live-text').value.length;");await delay(400);
        assert.ok(await evaluate("return r.querySelector('.jl-live-text').value.length;")>first);
        if(mobile){await evaluate("[...r.querySelectorAll('.jl-task-panels button')].find(b=>b.textContent==='输出').click();");await screenshot('ui-mobile-stream.png');}
        await evaluate("[...r.querySelectorAll('.jl-run-actions button')].find(b=>b.textContent==='任务操作').click();");
        await until("return r.querySelector('.jl-overlays .jl-dialog')?.getAttribute('aria-label')==='任务操作';",'pause actions');
        await evaluate("[...r.querySelectorAll('.jl-overlays .jl-dialog-footer button')].find(b=>b.textContent==='暂停').click();");
        await until("return !__jlDemo.queue.current();",'paused');
        const chunks=await evaluate("return await Promise.all(__jlDemo.app.state.run.chunks.map(c=>__jlDemo.repo.getChunk(__jlDemo.app.state.run.id,c.id))); ");
        assert.ok(chunks.some(c=>c.status==='paused'&&c.output.length>0));
        reports.push({check:'actions',mobile,promptSaved:true,destinations:3,streamedAndPaused:true});
    }
    assert.deepEqual(cdp.errors,[]);
    await writeFile('dev/browser-report.json',JSON.stringify({date:new Date().toISOString(),reports,errors:cdp.errors},null,2));
    console.log(JSON.stringify({passed:true,reports}));
} catch(error) {
    if(cdp)try{await screenshot('ui-check-failure.png');}catch{}
    throw error;
} finally {
    cdp?.close();
    // The PID belongs only to this disposable test browser and its descendants.
    if(browser.exitCode===null){
        const killer=spawn('taskkill',['/PID',String(browser.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
        await new Promise(resolve=>killer.once('exit',resolve));
    }
}
