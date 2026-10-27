import test from 'node:test';
import assert from 'node:assert/strict';
import { createTavern } from '../tavern.js';

function fixture({ listStatus=200, cachedCharacters=true, missingHeaders=false, nativeNames=false, helper=false, refreshError=false, nativeSaveError=false, login=false }={}) {
    const cards=new Map([['one.png',{name:'同名卡',description:'旧内容',data:{name:'同名卡',description:'旧内容',first_mes:'保留'}}],['two.png',{name:'同名卡',description:'另一张',data:{name:'同名卡',description:'另一张'}}]]);
    const worlds=new Map([['旧书',{entries:{5:{uid:40,comment:'保留',content:'旧条目'}}}]]);
    const calls=[];let refreshes=0;
    const ctx={characters:cachedCharacters?Object.fromEntries([...cards].map(([avatar,v])=>[avatar,{avatar,name:v.name}])):[]};
    if(!missingHeaders)ctx.getRequestHeaders=()=>new Headers({'content-type':'application/json','x-csrf-token':'mock-csrf'});
    if(nativeNames)ctx.getWorldInfoNames=()=>[...worlds.keys()];
    ctx.getCharacters=async()=>{refreshes++;if(refreshError)throw new Error('extension refresh error');};
    ctx.updateWorldInfoList=async()=>{refreshes++;if(refreshError)throw new Error('extension refresh error');};
    if(nativeSaveError)ctx.saveWorldInfo=async(name,data)=>{worlds.set(name,structuredClone(data));throw new Error('another extension event failed');};
    const loadModule=async path=>path==='/script.js'?{getRequestHeaders:()=>new Headers({'x-csrf-token':'mock-csrf'})}:null;
    const fetch=async(url,options)=>{
        calls.push({url,options});assert.equal(options.credentials,'same-origin');assert.equal(options.headers['x-csrf-token'],'mock-csrf');
        const data=JSON.parse(options.body);
        if(login&&url==='/api/worldinfo/list')return new Response('<!doctype html><html>login</html>');
        if(url==='/api/worldinfo/list')return listStatus===200?Response.json([...worlds.keys()].map(file_id=>({file_id}))):new Response('unsupported',{status:listStatus});
        if(url==='/api/settings/get')return Response.json({world_names:[...worlds.keys()],settings:{api_key:'PRIVATE-NOT-RETURNED'}});
        if(url==='/api/characters/all')return Response.json([...cards].map(([avatar,v])=>({avatar,...v})));
        if(url==='/api/characters/get')return Response.json(cards.get(data.avatar_url));
        if(url==='/api/characters/edit-attribute'){const c=cards.get(data.avatar_url);c[data.field]=data.value;c.data[data.field]=data.value;return new Response('OK');}
        if(url==='/api/worldinfo/get')return Response.json(worlds.get(data.name)||{entries:{}});
        if(url==='/api/worldinfo/edit'){worlds.set(data.name,data.data);return new Response('OK');}
        throw new Error(`Unexpected ${url}`);
    };
    const api=createTavern({getContext:()=>ctx,fetch,loadModule,getHelper:()=>helper?{getWorldbookNames:()=>[...worlds.keys()]}:null});
    return {api,ctx,calls,cards,worlds,refreshes:()=>refreshes};
}

test('旧版酒馆缺少列表和上下文 headers 时，通过原生模块与 settings 读取目标',async()=>{
    const f=fixture({listStatus:404,missingHeaders:true,cachedCharacters:false});const targets=await f.api.targets();
    assert.deepEqual(targets.worldbooks,['旧书']);assert.equal(targets.characters.length,2);assert.deepEqual(targets.errors,{});
    assert.equal(new Set(targets.characters.map(x=>x.id)).size,2);assert.equal(targets.characters[0].name,targets.characters[1].name);
    assert.ok(f.calls.some(c=>c.url==='/api/settings/get'));assert.doesNotMatch(JSON.stringify(targets),/PRIVATE-NOT-RETURNED/);
});
test('世界书列表失败不阻断角色卡选择与按稳定 ID 写入',async()=>{
    const f=fixture({listStatus:500});const targets=await f.api.targets();assert.equal(targets.characters.length,2);assert.match(targets.errors.worldbooks,/500/);
    await f.api.writeCharacter({target:'two.png',content:'指定第二张卡'});
    assert.equal(f.cards.get('one.png').description,'旧内容');assert.equal(f.cards.get('two.png').description,'另一张\n\n指定第二张卡');
});
test('兼容工具卡使用的世界书名称读取能力；401/403 不作为旧版接口处理',async()=>{
    const f=fixture({listStatus:404,helper:true});assert.deepEqual(await f.api.listWorldbooks(),['旧书']);
    assert.equal(f.calls.some(c=>c.url==='/api/settings/get'),false);
    const denied=fixture({listStatus:403,helper:true});await assert.rejects(denied.api.listWorldbooks(),/权限已失效/);
});
test('角色卡已保存后刷新报错只返回提示，避免将成功误报为失败',async()=>{
    const f=fixture({refreshError:true});const result=await f.api.writeCharacter({target:'one.png',content:'新内容'});
    assert.match(result.warning,/已保存/);assert.equal(f.cards.get('one.png').description,'旧内容\n\n新内容');
    assert.equal(f.calls.filter(c=>c.url==='/api/characters/edit-attribute').length,1);
});
test('世界书保存后的扩展事件异常不误报失败；重试同一操作不重复追加',async()=>{
    const f=fixture({nativeSaveError:true,refreshError:true});const input={name:'新书',create:true,operationId:'operation-1',entries:[{name:'青',content:'资料内容'}]};
    const first=await f.api.writeWorldbook(input);assert.match(first.warning,/已保存/);
    const second=await f.api.writeWorldbook(input);assert.equal(second.alreadySaved,true);assert.equal(Object.keys(f.worlds.get('新书').entries).length,1);
});
test('追加条目考虑现存 uid，与新建书名称分开，并保留原字段',async()=>{
    const f=fixture();await f.api.writeWorldbook({name:'旧书',entries:[{name:'主对象',content:'档案',keys:'甲、乙'}]});
    assert.equal(f.worlds.get('旧书').entries[5].content,'旧条目');assert.equal(f.worlds.get('旧书').entries[41].comment,'主对象');assert.deepEqual(f.worlds.get('旧书').entries[41].key,['甲','乙']);
});
test('登录 HTML 明确报错，空内容在新建世界书前拒绝',async()=>{
    const f=fixture({login:true});await assert.rejects(f.api.listWorldbooks(),/登录页面/);
    const clean=fixture();await assert.rejects(clean.api.writeWorldbook({name:'新书',create:true,entries:[{name:'甲',content:''}]}),/不能为空/);
    assert.equal(clean.calls.length,0);
});
