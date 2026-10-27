import test from 'node:test';
import assert from 'node:assert/strict';
import { createLibraryUI } from '../library-ui.js';
import { normalizeEntity } from '../library.js';
import { createRepository } from '../store.js';
import { createQueue } from '../queue.js';

// A tiny DOM model checks form actions, not browser layout or rendering.
class Element {
    constructor(tag){this.tagName=tag;this.children=[];this.value='';this.textContent='';this.type='';this.rows=0;this.hidden=false;this.checked=false;this.className='';this.autocomplete='';this.spellcheck=false;}
    append(...nodes){for(const n of nodes){n.parentElement=this;this.children.push(n);}}
    prepend(...nodes){for(const n of nodes)n.parentElement=this;this.children.unshift(...nodes);}
    replaceChildren(...nodes){this.children=[];this.append(...nodes);}
    setAttribute(k,v){this[k]=v;}
}
const walk=n=>[n,...n.children.flatMap(walk)];
const field=(body,name)=>{const label=walk(body).find(n=>n.tagName==='label'&&n.children[0]?.textContent===name);assert.ok(label,`Missing field: ${name}`);return label.children[1];};
async function fixture(action){
    const previous=globalThis.document;globalThis.document={createElement:tag=>new Element(tag)};
    try{
        const files=new Map();const repo=createRepository({read:async k=>files.get(k)??null,write:async(k,v)=>files.set(k,v),remove:async k=>files.delete(k)});
        const project=await repo.createProject({title:'项目',sourceText:'小说中有甲和一封信。'});const item=normalizeEntity({name:'甲',outputName:'a',content:'原资料'});
        await repo.saveLibrary(project.id,{version:1,items:[item],format:''});
        let called=0,planned;const queue=createQueue({repo,host:{capture:async()=>{called++;},generate:async()=>{called++;}}});
        const notices=[];const ui={dialog:null};
        const lib=createLibraryUI({repo,queue,ui,tavern:{},getProject:()=>project,getRun:()=>null,onRun:r=>{planned=r;},notify:x=>notices.push(x)});
        await action({repo,project,item,queue,ui,lib,notices,planned:()=>planned,called:()=>called});
    }finally{globalThis.document=previous;}
}

test('资料自检可编辑待检内容并改用粘贴材料，建计划不会调用模型或改小说',()=>fixture(async f=>{
    let step=0;
    f.ui.dialog=async options=>{
        if(step++===0){assert.equal(options.title,'资料');walk(options.body).find(n=>n.textContent==='全选').onclick();return 'actions';}
        if(options.title==='资料操作')return 'check';
        assert.equal(options.title,'自检所选资料');
        const scan=field(options.body,'扫描材料');scan.value='paste';scan.onchange();
        const material=field(options.body,'扫描内容');assert.equal(material.parentElement.hidden,false);material.value='我粘贴的其他核对依据。';
        field(options.body,'待检查资料').value='可以编辑或粘贴待检查内容。';return 'plan';
    };
    await f.lib.open();const run=f.planned();assert.ok(run);const c=await f.repo.getChunk(run.id,run.chunks[0].id);
    assert.match(c.instructions,/可以编辑或粘贴待检查内容/);assert.equal(c.outputName,'a');
    assert.match(await f.repo.readSourceFile(run.sourceFile),/我粘贴的其他核对依据/);
    assert.equal(await f.repo.getSource(f.project.id),'小说中有甲和一封信。');assert.equal(f.called(),0);
}));

test('资料导入接受代码围栏中的 JSON，重复名称使用不同标识',()=>fixture(async f=>{
    let page=0;
    f.ui.dialog=async options=>{
        if(options.title==='资料')return page++===0?'actions':'close';
        if(options.title==='资料操作')return 'import';
        assert.equal(options.title,'导入资料');field(options.body,'名称数组、角色卡 JSON 或资料备份').value='```json\n["甲","甲"]\n```';return 'import';
    };
    await f.lib.open();const data=await f.repo.getLibrary(f.project.id);assert.equal(data.items.length,3);assert.equal(new Set(data.items.map(x=>x.id)).size,3);assert.equal(f.called(),0);
}));

test('人物道具设定提示词分别保存，生成使用已修改的项目提示词',()=>fixture(async f=>{
    let saved=false;
    f.ui.dialog=async options=>{
        assert.equal(options.title,'提示词');
        if(saved)return 'close';
        const type=field(options.body,'提示词类型');type.value='prop';type.onchange();
        field(options.body,'相关提示词').value='道具自定义：{{name}}';saved=true;return 'save';
    };
    await f.lib.openPrompts();const data=await f.repo.getLibrary(f.project.id);assert.equal(data.prompts.prop,'道具自定义：{{name}}');assert.match(data.prompts.character,/人物/);assert.equal(f.called(),0);
    data.items[0].type='prop';await f.repo.saveLibrary(f.project.id,data);
    f.ui.dialog=async options=>{if(options.title==='资料'){walk(options.body).find(n=>n.textContent==='全选').onclick();return 'generate';}assert.equal(options.title,'生成所选资料');return 'plan';};
    await f.lib.open();const run=f.planned();assert.match((await f.repo.getChunk(run.id,run.chunks[0].id)).instructions,/道具自定义：a/);assert.equal(f.called(),0);
}));

test('单个对象可查看并保存自己的提示词，不覆盖项目模板或资料内容',()=>fixture(async f=>{
    let step=0;
    f.ui.dialog=async options=>{
        assert.match(options.title,/a · 提示词/);
        assert.match(field(options.body,'本次对象要求').value,/输出主名称/);
        if(step++)return 'close';
        const prompt=field(options.body,'相关提示词');prompt.value='只生成 {{name}} 的资料';prompt.oninput();return 'save';
    };
    await f.lib.openPrompts({record:f.item,inline:true});const item=(await f.repo.getLibrary(f.project.id)).items[0];assert.equal(item.prompt,'只生成 {{name}} 的资料');assert.equal(item.content,'原资料');assert.equal(f.called(),0);
}));
