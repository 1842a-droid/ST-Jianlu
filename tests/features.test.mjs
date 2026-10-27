import test from 'node:test';
import assert from 'node:assert/strict';
import { readCompletion } from '../stream.js';
import { normalizeEntity,mergeEntities,entityInstructions,collectContext,parseEntities,promptFor } from '../library.js';
import { createTavern,characterCard } from '../tavern.js';
import { createRepository } from '../store.js';
import { createQueue } from '../queue.js';

function sse(text,step=7){const bytes=new TextEncoder().encode(text);return new Response(new ReadableStream({start(c){for(let i=0;i<bytes.length;i+=step)c.enqueue(bytes.slice(i,i+step));c.close();}}),{headers:{'Content-Type':'text/event-stream'}});}
function memory(){const files=new Map();return{files,repo:createRepository({read:async k=>files.get(k)??null,write:async(k,v)=>{files.set(k,v);},remove:async k=>{files.delete(k);}})};}

test('SSE 增量按 UTF-8 字节与事件边界接收，保留最终结束原因',async()=>{
    const progress=[];const result=await readCompletion(sse('data: {"choices":[{"delta":{"content":"中😀"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":"文"},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n',1),{onProgress:x=>progress.push(x)});
    assert.equal(result.text,'中😀文');assert.equal(result.finishReason,'length');assert.deepEqual(progress,['中😀','中😀文']);
});
test('流中断和服务端错误不伪装完成，回调已收到的文字仍可保留',async()=>{
    let partial='';await assert.rejects(readCompletion(sse('data: {"choices":[{"delta":{"content":"已收到"}}]}\n\n'),{onProgress:x=>partial=x}),/提前结束/);assert.equal(partial,'已收到');
    await assert.rejects(readCompletion(sse('data: {"error":{"message":"quota"}}\n\n')),/quota/);
    const result=await readCompletion(Response.json({choices:[{message:{content:'普通响应'},finish_reason:'stop'}]}));assert.equal(result.text,'普通响应');
});
test('Claude 与 Cohere 流只收集正文，正确保留结束原因',async()=>{
    const claude=await readCompletion(sse('data: {"type":"content_block_start","content_block":{"type":"text","text":"甲"}}\n\ndata: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"不混入正文"}}\n\ndata: {"type":"content_block_delta","delta":{"text":"乙"}}\n\ndata: {"type":"message_delta","delta":{"stop_reason":"max_tokens"}}\n\ndata: {"type":"message_stop"}\n\n'));
    assert.equal(claude.text,'甲乙');assert.equal(claude.finishReason,'max_tokens');
    const cohere=await readCompletion(sse('data: {"type":"content-delta","delta":{"message":{"content":{"text":"正文"}}}}\n\ndata: {"type":"message-end","delta":{"finish_reason":"COMPLETE"}}\n\n'));
    assert.equal(cohere.text,'正文');assert.equal(cohere.finishReason,'COMPLETE');
});
test('流式中途暂停保留部分成果，并且迟到数据不能覆盖',async()=>{
    const {repo}=memory();const project=await repo.createProject({title:'流式项目',sourceText:'测试原文'});let arrived;const started=new Promise(r=>arrived=r);let release;
    const host={capture:async input=>({messages:[{role:'user',content:input}]}),generate:async(snapshot,{onProgress})=>{onProgress('部分输出');arrived();await new Promise(r=>release=r);onProgress('迟到输出');return{text:'迟到输出'};}};
    const queue=createQueue({repo,host});const run=await queue.plan({projectId:project.id});const work=queue.run(run.id);await started;assert.equal(queue.current().output,'部分输出');await queue.pause();await work;const saved=await repo.getChunk(run.id,run.chunks[0].id);assert.equal(saved.status,'paused');assert.equal(saved.output,'部分输出');release();await Promise.resolve();assert.equal((await repo.getChunk(run.id,saved.id)).output,'部分输出');
});
test('流式网络错误保留新内容及上一版，不丢弃失败块片段',async()=>{
    const {repo}=memory();const p=await repo.createProject({sourceText:'原文',title:'流'});const q=createQueue({repo,host:{capture:async()=>({messages:[]}),generate:async(s,{onProgress})=>{onProgress('新片段');throw new Error('断线');}}});const run=await q.plan({projectId:p.id});await q.run(run.id);const c=await repo.getChunk(run.id,run.chunks[0].id);assert.equal(c.status,'partial');assert.equal(c.output,'新片段');assert.match(c.error,/断线/);
});
test('检索名与输出主名称独立；关联族群不自动变成同人别名',()=>{
    const a=normalizeEntity({name:'abc',outputName:'a',contextTerms:['某族']});const b=normalizeEntity({name:'神剑',type:'prop'});const duplicate=normalizeEntity({name:'abc'});assert.notEqual(a.id,duplicate.id);
    const merged=mergeEntities([a,b],a.id);assert.deepEqual(merged.aliases,[]);assert.deepEqual(merged.contextTerms,['某族','神剑']);assert.match(entityInstructions(merged),/"输出主名称": "a"/);assert.match(entityInstructions(merged),/不得归给主对象/);
});
test('可编辑提示词按对象类型与单对象覆盖，自检沿用编辑内容，宏不递归替换',()=>{
    const e=normalizeEntity({name:'abc',outputName:'a',type:'prop',notes:'保留 {{char}} 与 {{name}}',content:'旧资料'});
    const prompts={prop:'道具 {{name}} / {{notes}}',check:'检查：{{existing}}'};
    assert.match(entityInstructions(e,{prompts,check:true}),/道具 a \/ 保留 \{\{char\}\} 与 \{\{name\}\}/);
    assert.match(entityInstructions(e,{prompts,check:true}),/检查：旧资料/);
    assert.match(entityInstructions({...e,prompt:'对象覆盖 {{name}}'},{prompts}),/对象覆盖 a/);
    assert.equal(promptFor({prop:''},'prop'),'');
});
test('关联检索支持大小写与正则字符字面值，超范围显式标记',()=>{
    const text='开头 ABC 原文 [x] '+ '片段'.repeat(60)+'\nABC 尾声';const r=collectContext(text,['abc','[x]'],{radius:4,maxChars:100});assert.equal(r.matches,3);assert.match(r.text,/ABC/);const cap=collectContext(text,['ABC'],{radius:300,maxChars:30});assert.equal(cap.truncated,true);assert.ok(cap.text.length<=30);assert.deepEqual(parseEntities('[{"name":"甲","type":"prop"}]').map(x=>x.type),['prop']);
});
test('检索上下文和上限截取不切断 emoji 字符',()=>{
    const source='😀甲😀乙😀';
    const result=collectContext(source,['甲'],{radius:1,maxChars:0});assert.equal(result.text.split('\n').at(-1),'😀甲😀');assert.equal(result.text.isWellFormed(),true);
    for(let limit=20;limit<30;limit++)assert.equal(collectContext(source,['甲'],{radius:20,maxChars:limit}).text.isWellFormed(),true);
});
test('多块扫描结果可直接导入，保留字符串内括号，拒绝不完整 JSON',()=>{
    const records=parseEntities('```json\n[{"name":"甲","notes":"字符串里的 ] [ 与 \\\"引号\\\""}]\n```\n\n```json\n{"items":[{"name":"信","type":"prop"}]}\n```');
    assert.deepEqual(records.map(x=>x.name),['甲','信']);assert.equal(records[1].type,'prop');
    assert.throws(()=>parseEntities('["甲"]\n["乙"'),/完整 JSON/);
});
test('项目资料单独保存，备份保留内容并重映射资料与生成任务归属',async()=>{
    const {repo}=memory();const p=await repo.createProject({title:'一',sourceText:'主角原文'});const other=await repo.createProject({title:'二',sourceText:'其他原文'});const e=normalizeEntity({name:'abc',outputName:'a',content:'档案'});await repo.saveLibrary(p.id,{version:1,items:[e],format:'名称: 内容'});assert.equal((await repo.getLibrary(other.id)).items.length,0);
    const q=createQueue({repo,host:{capture:async(input,o)=>({messages:[{role:'user',content:input}],instructions:o.instructions}),generate:async()=>({text:'输出'})}});const run=await q.plan({projectId:p.id,units:[{label:'a',sourceText:'检索材料',instructions:entityInstructions(e),entityId:e.id,outputName:'a'}],sourceKind:'paste'});await q.run(run.id);assert.equal(await repo.getSource(p.id),'主角原文');const c=await repo.getChunk(run.id,run.chunks[0].id);assert.match(c.snapshot.instructions,/输出主名称/);
    const imported=await repo.importProject(await repo.exportProject(p.id));const library=await repo.getLibrary(imported.id);assert.equal(library.items[0].content,'档案');assert.notEqual(library.items[0].id,e.id);const ir=await repo.getRun(imported.runs[0].id);assert.equal((await repo.getChunk(ir.id,ir.chunks[0].id)).entityId,library.items[0].id);
});

function tavernFixture(){
    const cards=new Map([['old.png',{name:'旧卡',description:'旧描述',first_mes:'保留开场',data:{name:'旧卡',description:'旧描述',first_mes:'保留开场'}}]]);const worlds=new Map([['旧书',{entries:{7:{uid:7,comment:'旧条目',content:'保持原样'}}}]]);const calls=[];
    const ctx={characters:[{avatar:'old.png',name:'旧卡'}],getRequestHeaders:()=>({'Content-Type':'application/json','X-CSRF-Token':'mock'}),getCharacters:async()=>{},updateWorldInfoList:async()=>{}};
    const fetch=async(url,opts)=>{calls.push({url,opts});
        if(url==='/api/characters/import'){const card=JSON.parse(await opts.body.get('avatar').text());assert.equal(opts.headers['Content-Type'],undefined);cards.set('new.png',card);return Response.json({file_name:'new.png'});}
        const b=JSON.parse(opts.body);
        if(url==='/api/characters/get')return Response.json(cards.get(b.avatar_url));
        if(url==='/api/characters/edit-attribute'){const c=cards.get(b.avatar_url);assert.equal(b.ch_name,c.name);c[b.field]=b.value;c.data[b.field]=b.value;return new Response('OK');}
        if(url==='/api/worldinfo/list')return Response.json([...worlds.keys()].map(name=>({file_id:name})));
        if(url==='/api/worldinfo/get')return Response.json(worlds.get(b.name)||{entries:{}});
        if(url==='/api/worldinfo/edit'){worlds.set(b.name,b.data);return Response.json({ok:true});}
        throw new Error(url);
    };return{api:createTavern({getContext:()=>ctx,fetch}),cards,worlds,calls};
}
test('角色卡新建使用指定主名称；追加只改选定字段并校验保存',async()=>{
    const f=tavernFixture();await f.api.writeCharacter({target:'new',name:'a',content:'自定义角色资料'});assert.equal(f.cards.get('new.png').data.name,'a');await f.api.writeCharacter({target:'old.png',content:'新资料'});assert.equal(f.cards.get('old.png').description,'旧描述\n\n新资料');assert.equal(f.cards.get('old.png').first_mes,'保留开场');await assert.rejects(f.api.writeCharacter({target:'../bad.png',content:'X'}),/有效的目标角色卡/);assert.equal(characterCard('甲','资料').spec,'chara_card_v2');
});
test('世界书只追加新 UID，不覆盖原条目；同名新建被拒绝',async()=>{
    const f=tavernFixture();await f.api.writeWorldbook({name:'旧书',entries:[{name:'a',content:'新信息',keys:['abc']}]});assert.equal(f.worlds.get('旧书').entries[7].content,'保持原样');assert.equal(f.worlds.get('旧书').entries[8].content,'新信息');assert.deepEqual(f.worlds.get('旧书').entries[8].key,['abc']);await assert.rejects(f.api.writeWorldbook({name:'旧书',create:true,entries:[{name:'x',content:'y'}]}),/同名/);await f.api.writeWorldbook({name:'新书',create:true,entries:[{name:'神剑',content:'道具资料'}]});assert.equal(f.worlds.get('新书').entries[0].comment,'神剑');
});
