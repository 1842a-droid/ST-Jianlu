import { normalizeEntity, mergeEntities, entityInstructions, collectContext, parseEntities } from './library.js';
import { newId } from './store.js';
import { characterCard, worldEntry } from './tavern.js';
import { copyText } from './ui.js';

const types = [['character','人物'],['prop','道具'],['setting','设定']];
function el(tag, text, attrs = {}) { const n=document.createElement(tag); if(text!==undefined)n.textContent=text; for(const[k,v]of Object.entries(attrs)){if(k in n)n[k]=v;else n.setAttribute(k,v);} return n; }
function field(body,name,input){const wrap=el('label');wrap.append(el('span',name),input);body.append(wrap);return input;}
function select(values,current){const n=el('select');for(const[id,name]of values)n.append(el('option',name,{value:id}));n.value=current??values[0]?.[0]??'';return n;}
function form(){return el('div',undefined,{className:'jl-form'});}
function input(value=''){return el('input',undefined,{value,autocomplete:'off'});}
function area(value='',rows=7){return el('textarea',undefined,{value,rows,spellcheck:false});}
function download(name,text,type='application/json'){const u=URL.createObjectURL(new Blob([text],{type}));const a=el('a',undefined,{href:u,download:name.replace(/[<>:"/\\|?*]/g,'_')});document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(u),10000);}

export function createLibraryUI({repo,queue,ui,tavern,getProject,getRun,onRun,onUpdate,notify}) {
    async function editEntity(record={}) {
        const body=form();
        const type=field(body,'类型',select(types,record.type||'character'));
        const name=field(body,'检索名称',input(record.name));
        const output=field(body,'输出主名称',input(record.outputName||record.name));
        const aliases=field(body,'真正的同人别名',area((record.aliases||[]).join('\n'),3));
        const search=field(body,'附加检索词',area((record.searchTerms||[]).join('\n'),3));
        const related=field(body,'关联背景词（非同人别名）',area((record.contextTerms||[]).join('\n'),3));
        const stage=field(body,'限定阶段',input(record.stage));
        const notes=field(body,'补充要求',area(record.notes,3));
        const content=field(body,'已保存资料',area(record.content,12));
        for(;;){const choice=await ui.dialog({title:record.id?'编辑资料':'新增人物 / 道具',body,layout:'wide',buttons:[{label:'取消',value:'cancel'},{label:'保存',value:'save',primary:true}]});if(choice!=='save')return null;
            try{return normalizeEntity({...record,type:type.value,name:name.value,outputName:output.value,aliases:aliases.value,searchTerms:search.value,contextTerms:related.value,stage:stage.value,notes:notes.value,content:content.value});}catch(e){notify(e.message,'error');}}
    }

    async function publish({text='',name='',entries}={}) {
        const targets=await tavern.targets(); const project=getProject();
        const list=entries?.length?entries:[{name:name||project?.title||'新资料',content:text,keys:[name||'新资料']}];
        if(list.some(x=>!String(x.content||'').trim()))throw new Error('所选资料中有空内容，请先保存输出');
        const multi=list.length>1;const body=form();
        const kind=field(body,'写入位置',select([['character','角色卡'],['world','世界书']],'character'));
        const title=field(body,'新建名称',input(name||list[0].name));
        const character=field(body,'目标角色卡',select([['new','新建角色卡'],...targets.characters.map(x=>[x.id,x.name])],'new'));
        const cardField=field(body,'写入字段',select([['description','角色描述'],['personality','性格'],['scenario','场景'],['first_mes','开场白'],['mes_example','对话示例']],'description'));
        const mode=field(body,'写入方式',select([['append','追加到字段'],['replace','替换该字段']],'append'));
        const book=field(body,'目标世界书',select([['new','新建世界书'],...targets.worldbooks.map(x=>[x,x])],'new'));
        const keys=field(body,'触发词',input((list[0].keys||[list[0].name]).join('、')));
        const content=field(body,multi?'待写入条目（JSON 数组）':'待写入内容',area(multi?JSON.stringify(list,null,2):list[0].content,16));
        const sync=()=>{const c=kind.value==='character';character.parentElement.hidden=!c;cardField.parentElement.hidden=!c;mode.parentElement.hidden=!c||character.value==='new';book.parentElement.hidden=c;keys.parentElement.hidden=c||multi;title.parentElement.hidden=c?character.value!=='new'||multi:book.value!=='new';};
        kind.onchange=character.onchange=book.onchange=sync;sync();
        for(;;){const value=await ui.dialog({title:'写入酒馆',body,layout:'wide',buttons:[{label:'取消',value:'cancel'},{label:'写入',value:'write',primary:true}]});if(value!=='write')return;
            try{
                const data=multi?JSON.parse(content.value):[{name:title.value||list[0].name,content:content.value,keys:keys.value.split(/[\n,，、]+/).filter(Boolean)}];
                if(!Array.isArray(data)||!data.length||data.some(x=>!String(x.name||'').trim()||!String(x.content||'').trim()))throw new Error('名称或内容为空');
                if(kind.value==='world')await tavern.writeWorldbook({name:book.value==='new'?title.value.trim():book.value,create:book.value==='new',entries:data});
                else if(character.value==='new'){
                    for(let i=0;i<data.length;i++){
                        await tavern.writeCharacter({target:'new',name:multi?data[i].name:title.value.trim(),content:data[i].content,field:cardField.value});
                        if(multi){ data.splice(i,1); i--; content.value=JSON.stringify(data,null,2); }
                    }
                }else await tavern.writeCharacter({target:character.value,content:data.map(x=>multi?`${x.name}\n${x.content}`:x.content).join('\n\n'),field:cardField.value,mode:mode.value});
                notify('已写入酒馆','success');return;
            }catch(error){notify(error.message,'error');}
        }
    }

    async function saveOutput({text,name,entityId}={}) {
        const project=getProject();if(!project)throw new Error('请先打开小说项目');
        const data=await repo.getLibrary(project.id);const body=form();
        const target=field(body,'目标资料',select([['new','新增资料'],...data.items.map(x=>[x.id,x.outputName||x.name])],entityId||'new'));
        const title=field(body,'主名称',input(name||'新资料'));
        const type=field(body,'类型',select(types,'character'));
        const content=field(body,'资料内容',area(text,16));
        for(;;){
            const choice=await ui.dialog({title:'保存到人物 / 道具',body,layout:'wide',buttons:[{label:'取消',value:'cancel'},{label:'保存',value:'save',primary:true}]});if(choice!=='save')return;
            try{
                const latest=await repo.getLibrary(project.id);
                const old=latest.items.find(x=>x.id===target.value);
                if(target.value!=='new'&&!old)throw new Error('目标资料已被删除，请重新打开后选择');
                const value=normalizeEntity(old?{...old,content:content.value}:{name:title.value,outputName:title.value,type:type.value,content:content.value});
                const i=latest.items.findIndex(x=>x.id===value.id);if(i<0)latest.items.push(value);else latest.items[i]=value;
                await repo.saveLibrary(project.id,latest);notify('资料已保存','success');onUpdate?.();return;
            }catch(error){notify(error.message,'error');}
        }
    }

    async function open() {
        const project=getProject();if(!project)throw new Error('请先打开小说项目');
        let data=await repo.getLibrary(project.id), selected=new Set(), query='', filter='all';
        data.items=data.items.map(normalizeEntity);
        const save=async()=>{await repo.saveLibrary(project.id,data);onUpdate?.();};
        const chosen=()=>data.items.filter(x=>selected.has(x.id));
        async function generate(check=false){
            const items=chosen();if(!items.length)throw new Error('请先选择人物或道具');if(queue.current())throw new Error('请先暂停当前任务');
            const body=form();
            const scan=check?field(body,'扫描材料',select([['novel','检索小说原文'],['paste','粘贴其他材料']],'novel')):null;
            const pasted=check?field(body,'扫描内容',area('',9)):null;
            const review=check?field(body,items.length===1?'待检查资料':'待检查资料（JSON 数组）',area(items.length===1?items[0].content:JSON.stringify(items.map(x=>({id:x.id,name:x.outputName,content:x.content})),null,2),12)):null;
            const cap=field(body,'每个对象材料上限（字，0 为不限制）',el('input',undefined,{type:'number',min:0,value:60000}));
            const radius=field(body,'每处命中前后字数',el('input',undefined,{type:'number',min:50,value:700}));
            if(scan){const sync=()=>{const paste=scan.value==='paste';pasted.parentElement.hidden=!paste;cap.parentElement.hidden=radius.parentElement.hidden=paste;};scan.onchange=sync;sync();}
            const format=field(body,'本次输出格式',area(data.format||'',7));
            const user=field(body,'本次补充要求',area('',3));
            for(;;){
            const value=await ui.dialog({title:check?'自检所选资料':'生成所选资料',body,buttons:[{label:'取消',value:'cancel'},{label:'生成任务',value:'plan',primary:true}]});if(value!=='plan')return false;
            try{
            const limit=Number(cap.value),window=Number(radius.value);if(!Number.isFinite(limit)||limit<0||!Number.isFinite(window)||window<50)throw new Error('材料范围无效');
            let reviews;
            if(check&&items.length>1){reviews=JSON.parse(review.value);if(!Array.isArray(reviews)||reviews.length!==items.length||new Set(reviews.map(x=>x.id)).size!==items.length||reviews.some(x=>!items.some(item=>item.id===x.id)||typeof x.content!=='string'))throw new Error('待检查资料的对象标识或内容无效');}
            const usePaste=scan?.value==='paste';
            if(usePaste&&!pasted.value.trim())throw new Error('请粘贴扫描材料');
            const source=usePaste?pasted.value:await repo.getSource(project.id);let truncated=0;
            const units=items.map(item=>{
                const candidate=check?{...item,content:items.length===1?review.value:reviews.find(x=>x.id===item.id).content}:item;
                if(check&&!candidate.content.trim())throw new Error(`请填写「${item.outputName}」的待检查资料`);
                const context=usePaste?{text:source,matches:1,truncated:false}:collectContext(source,[item.name,...item.aliases,...item.searchTerms,...item.contextTerms],{maxChars:limit,radius:window});if(!context.matches)throw new Error(`未找到「${item.name}」的原文，请修改检索名称`);if(context.truncated)truncated++;
                return{label:item.outputName||item.name,sourceText:context.text,entityId:item.id,outputName:item.outputName,instructions:[entityInstructions(candidate,{format:format.value,check}),user.value].filter(Boolean).join('\n\n')};});
            if(truncated){const confirm=await ui.dialog({title:'材料范围',body:el('p',`${truncated} 个对象命中材料超过上限。是否使用上限内材料？取消后可调整为 0 或更大的值。`),buttons:[{label:'取消',value:'cancel'},{label:'使用当前范围',value:'yes',primary:true}]});if(confirm!=='yes')continue;}
            const run=await queue.plan({projectId:project.id,title:`${check?'自检':'生成资料'} · ${items.map(x=>x.outputName).join('、')}`,units,inputName:'对象检索材料',sourceKind:'paste'});onRun(run);return true;
            }catch(error){notify(error.message,'error');}
            }
        }
        async function actions(){
            return ui.dialog({title:'资料操作',layout:'menu',buttons:[{label:'检索所选原文',value:'search',disabled:!selected.size},{label:'关联 / 合并所选',value:'merge',disabled:selected.size<2},{label:'自检所选资料',value:'check',disabled:!selected.size},{label:'扫描名称',value:'scan'},{label:'从输出或备份导入',value:'import'},{label:'输出格式',value:'format'},{label:'写入角色卡 / 世界书',value:'publish',disabled:!selected.size},{label:'导出角色卡 JSON',value:'exportCard',disabled:!selected.size},{label:'导出世界书 JSON',value:'exportWorld',disabled:!selected.size},{label:'导出所选资料',value:'export',disabled:!selected.size},{label:'删除所选资料',value:'delete',danger:true,disabled:!selected.size},{label:'取消',value:'cancel'}]});
        }
        for(;;){
            const body=form();const toolbar=el('div',undefined,{className:'jl-library-tools'});
            const search=input(query);search.placeholder='搜索人物、道具、别名';search.setAttribute('aria-label','搜索资料');
            const type=select([['all','全部'],...types],filter);type.setAttribute('aria-label','资料类型');
            const selectAll=el('button','全选',{type:'button'}),clear=el('button','取消选择',{type:'button'}),count=el('span',`已选 ${selected.size}`,{className:'jl-muted'});
            toolbar.append(search,type,selectAll,clear,count);body.append(toolbar);
            const list=el('div',undefined,{className:'jl-library-list'});body.append(list);
            const render=()=>{
                list.replaceChildren();const shown=data.items.filter(x=>(filter==='all'||x.type===filter)&&[x.name,x.outputName,...x.aliases,...x.contextTerms].join(' ').toLowerCase().includes(query.toLowerCase()));
                for(const item of shown){const row=el('div',undefined,{className:'jl-library-row'});const check=el('input',undefined,{type:'checkbox',checked:selected.has(item.id)});check.setAttribute('aria-label',`选择资料 ${item.outputName}`);check.onchange=()=>{check.checked?selected.add(item.id):selected.delete(item.id);count.textContent=`已选 ${selected.size}`;};
                    const edit=el('button',undefined,{type:'button',className:'jl-library-edit'});edit.append(el('strong',item.outputName),el('span',`${types.find(x=>x[0]===item.type)?.[1]} · 检索 ${item.name}${item.content?' · 已有资料':''}`,{className:'jl-muted'}));edit.onclick=()=>{edit.disabled=true;editEntity(item).then(async value=>{if(value){data.items[data.items.findIndex(x=>x.id===item.id)]=value;await save();render();}}).catch(e=>notify(e.message,'error')).finally(()=>{edit.disabled=false;});};row.append(check,edit);list.append(row);}
                if(!shown.length)list.append(el('p','暂无资料',{className:'jl-muted'}));
            };
            search.oninput=()=>{query=search.value;render();};type.onchange=()=>{filter=type.value;render();};selectAll.onclick=()=>{data.items.forEach(x=>selected.add(x.id));count.textContent=`已选 ${selected.size}`;render();};clear.onclick=()=>{selected.clear();count.textContent='已选 0';render();};render();
            let choice=await ui.dialog({title:'人物 / 道具',body,layout:'wide',buttons:[{label:'＋',value:'add'},{label:'资料操作',value:'actions'},{label:'生成所选',value:'generate',primary:true},{label:'关闭',value:'close'}]});
            if(!choice||choice==='close')return;
            try{
                if(choice==='actions')choice=await actions();
                if(choice==='add'){const item=await editEntity();if(item){data.items.push(item);await save();}}
                if(choice==='generate'||choice==='check'){if(await generate(choice==='check'))return;}
                if(choice==='delete'){const yes=await ui.dialog({title:'删除资料',body:el('p',`删除 ${selected.size} 条资料？`),buttons:[{label:'取消',value:'cancel'},{label:'删除',value:'yes',danger:true}]});if(yes==='yes'){data.items=data.items.filter(x=>!selected.has(x.id));selected.clear();await save();}}
                if(choice==='format'){const b=form(),t=field(b,'输出格式（留空跟随预设）',area(data.format,16));const v=await ui.dialog({title:'输出格式',body:b,buttons:[{label:'取消',value:'cancel'},{label:'保存',value:'save',primary:true}]});if(v==='save'){data.format=t.value;await save();}}
                if(choice==='merge'){const b=form(),main=field(b,'主对象',select(chosen().map(x=>[x.id,x.outputName]),chosen()[0]?.id)),mode=field(b,'其他所选条目',select([['related','作为关联资料'],['aliases','确认是同人别名']],'related'));const v=await ui.dialog({title:'关联 / 合并',body:b,buttons:[{label:'取消',value:'cancel'},{label:'合并',value:'merge',primary:true}]});if(v==='merge'){const merged=mergeEntities(chosen(),main.value,mode.value==='aliases');data.items=data.items.filter(x=>!selected.has(x.id)||x.id===main.value).map(x=>x.id===main.value?merged:x);selected=new Set([main.value]);await save();}}
                if(choice==='search'){const src=await repo.getSource(project.id),r=collectContext(src,chosen().flatMap(x=>[x.name,...x.aliases,...x.searchTerms,...x.contextTerms]));const b=form();b.append(el('p',`${r.matches} 处命中${r.truncated?' · 当前预览已达上限':''}`,{className:'jl-muted'}),area(r.text,18));const v=await ui.dialog({title:'原文检索',body:b,layout:'wide',buttons:[{label:'关闭',value:'cancel'},{label:'复制',value:'copy'}]});if(v==='copy')await copyText(r.text);}
                if(choice==='publish')await publish({entries:chosen().map(x=>({name:x.outputName,content:x.content,keys:[x.name,...x.aliases]}))});
                if(choice==='export')download(`${project.title}-人物道具.json`,JSON.stringify({kind:'jianlu-library',version:1,items:chosen()},null,2));
                if(choice==='exportCard'){const cards=chosen().map(x=>({name:x.outputName,card:characterCard(x.outputName,x.content)}));for(const [index,item]of cards.entries())download(`${item.name}-${index+1}.json`,JSON.stringify(item.card,null,2));}
                if(choice==='exportWorld'){const entries=Object.fromEntries(chosen().map((x,i)=>[i,worldEntry(i,{name:x.outputName,content:x.content,keys:[x.name,...x.aliases]})]));download(`${project.title}-世界书.json`,JSON.stringify({entries},null,2));}
                if(choice==='import'){
                    const b=form(),text=field(b,'名称数组、角色卡 JSON 或资料备份',area('',16));const upload=el('input',undefined,{type:'file',accept:'.json,.txt'});upload.onchange=()=>upload.files?.[0]?.text().then(x=>{text.value=x;}).catch(e=>notify(e.message,'error'));b.prepend(upload);
                    for(;;){const v=await ui.dialog({title:'导入资料',body:b,layout:'wide',buttons:[{label:'取消',value:'cancel'},{label:'读取当前任务输出',value:'result'},{label:'导入',value:'import',primary:true}]});if(v==='cancel'||!v)break;if(v==='result'){const run=getRun();if(!run)throw new Error('请先选择有输出的任务');text.value=(await queue.merge(run.id,{includePartial:true})).text;continue;}
                        try{let values,raw;try{raw=JSON.parse(text.value.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,''));}catch{values=parseEntities(text.value);}if(!values){if(raw?.kind==='jianlu-library')values=raw.items.map(normalizeEntity);else if(raw?.library?.items)values=raw.library.items.map(normalizeEntity);else if(raw?.spec?.startsWith('chara_card_'))values=[normalizeEntity({name:raw.data?.name||raw.name,content:raw.data?.description||raw.description})];else values=parseEntities(text.value);}
                        data.items.push(...values.map(x=>({...x,id:newId()})));await save();notify(`已导入 ${values.length} 条资料`,'success');break;}catch(error){notify(error.message,'error');}}
                }
                if(choice==='scan'){if(queue.current())throw new Error('请先暂停当前任务');const run=await queue.plan({projectId:project.id,title:'扫描人物与道具名称',instructions:'从当前小说片段列出明确出现的人物、道具、设定。只输出 JSON 数组，每项如 {"name":"原文名称","type":"character","aliases":[],"contextTerms":[]}。type 只选 character、prop、setting 之一。别名必须确指同一主体，族群和道具不作为人物别名。'});onRun(run);return;}
            }catch(error){notify(error.message,'error');}
        }
    }
    return {open,saveOutput,publish};
}
