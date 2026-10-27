import { newId } from './store.js';
export const terms = value => [...new Set((Array.isArray(value) ? value : String(value || '').split(/[\n,，、;；]+/)).map(x => String(x).trim()).filter(Boolean))];
export const PROMPT_TYPES = [['character','人物'],['prop','道具'],['setting','设定'],['check','自检'],['scan','名称扫描']];
const objectPrompt = kind => `只为「{{name}}」生成${kind}资料，使用该输出主名称。检索词用于寻找材料，不代表它们是同一对象。其他对象（包括人物、族群、组织、道具）的经历和属性不得归给主对象；不能确认的信息标为未确认，不编造。\n限定阶段：{{stage}}\n补充要求：{{notes}}`;
export const DEFAULT_PROMPTS = Object.freeze({
    character: objectPrompt('人物'), prop: objectPrompt('道具'), setting: objectPrompt('设定'),
    check: '核对、纠错并补充「{{name}}」的以下资料。只根据本次提供的扫描材料，不混淆关联对象。\n【待检查资料】\n{{existing}}',
    scan: '从当前小说片段列出明确出现的人物、道具、设定。只输出 JSON 数组，每项如 {"name":"原文名称","type":"character","aliases":[],"contextTerms":[]}。type 只选 character、prop、setting 之一。别名必须确指同一主体，族群和道具不作为人物别名。',
});
export const promptFor = (prompts, type) => String(prompts?.[type] ?? DEFAULT_PROMPTS[type] ?? '');
export function renderEntityPrompt(template, entity) {
    const values = { name:entity.outputName, search_name:entity.name, aliases:terms(entity.aliases).join('、'), context_terms:terms(entity.contextTerms).join('、'), stage:entity.stage||'不限', notes:entity.notes||'无', existing:entity.content||'' };
    return String(template).replace(/\{\{\s*(name|search_name|aliases|context_terms|stage|notes|existing)\s*\}\}/g, (_,key) => values[key]);
}
export function normalizeEntity(value = {}) {
    const name = String(value.name || '').trim();
    if (!name) throw new Error('请填写检索名称');
    return { ...value, id: value.id || newId(), type: ['character', 'prop', 'setting'].includes(value.type) ? value.type : 'character', name, outputName: String(value.outputName || name).trim() || name, aliases: terms(value.aliases), searchTerms: terms(value.searchTerms), contextTerms: terms(value.contextTerms), notes: String(value.notes || ''), prompt: String(value.prompt || ''), content: String(value.content || ''), stage: String(value.stage || '') };
}
export function mergeEntities(records, primaryId, asAliases = false) {
    const primary = normalizeEntity(records.find(x => x.id === primaryId));
    const extra = records.filter(x => x.id !== primaryId);
    return normalizeEntity({ ...primary, aliases: [...primary.aliases, ...(asAliases ? extra.flatMap(x => [x.name, ...(x.aliases || [])]) : [])], contextTerms: [...primary.contextTerms, ...extra.flatMap(x => [...(x.contextTerms || []), ...(asAliases ? [] : [x.name, ...(x.aliases || [])])])], content: [primary.content, ...extra.map(x => x.content)].filter(Boolean).join('\n\n') });
}
export function entityInstructions(entity, { format = '', check = false, prompts = {} } = {}) {
    const e = normalizeEntity(entity);
    const template = e.prompt?.trim() ? e.prompt : promptFor(prompts, e.type);
    return `【本次${check ? '检查' : '生成'}对象】\n${JSON.stringify({对象类型:e.type === 'character' ? '人物' : e.type === 'prop' ? '道具' : '设定',输出主名称:e.outputName,原文检索名称:e.name,同一对象别名:e.aliases,附加检索词:e.searchTerms,关联背景_不是同一对象别名:e.contextTerms,限定阶段:e.stage,补充要求:e.notes}, null, 2)}\n` +
        renderEntityPrompt(template,e) + (check ? '\n\n' + renderEntityPrompt(promptFor(prompts,'check'),e) : '') + '\n\n' + (format ? `【本次输出格式】\n${format}` : '输出格式沿用当前酒馆预设。');
}
export function collectContext(text, values, { radius = 700, maxChars = 60000 } = {}) {
    const keys = terms(values); if (!keys.length) throw new Error('请填写检索名称或检索词');
    // Keep UTF-16 surrogate pairs intact at both context and preview boundaries.
    const boundary = value => value > 0 && value < text.length && /[\uD800-\uDBFF]/.test(text[value - 1]) && /[\uDC00-\uDFFF]/.test(text[value]) ? value - 1 : value;
    const ranges = []; let matches = 0;
    for (const key of keys) {
        const pattern=new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'giu');let match,last;
        while ((match=pattern.exec(text))) {
            const cursor=match.index;matches++; const rawEnd=Math.min(text.length,cursor+match[0].length+radius);const range=[boundary(Math.max(0,cursor-radius)),boundary(rawEnd)===rawEnd?rawEnd:rawEnd+1];
            if(last&&range[0]<=last[1])last[1]=Math.max(last[1],range[1]);else{ranges.push(range);last=range;}
        }
    }
    ranges.sort((a,b) => a[0]-b[0]);
    const merged = [];
    for (const range of ranges) { const last = merged.at(-1); if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]); else merged.push([...range]); }
    let out = '', truncated = false;
    for (const [start,end] of merged) {
        const label = `\n【原文位置 ${start + 1}–${end}】\n`;
        const part = label + text.slice(start,end);
        if (maxChars > 0 && out.length + part.length > maxChars) { const left = Math.max(0,maxChars-out.length-label.length); if(left) out += label + text.slice(start,boundary(start+left)); truncated = true; break; }
        out += part;
    }
    return { text: out, matches, truncated };
}
export function parseEntities(text) {
    const clean = String(text).trim().replace(/^\s*```(?:json)?[ \t]*\r?$/gmi,'').trim();
    let documents;
    try { documents = [JSON.parse(clean)]; } catch {
        // Consecutive chunks each produce a valid document; importing all of them
        // must not require merging independent arrays into one valid JSON first.
        documents=[];let depth=0,start=-1,quoted=false,escaped=false;
        try {
            for(let i=0;i<clean.length;i++){
                const ch=clean[i];
                if(start<0){if(/\s/.test(ch))continue;if(ch!=='['&&ch!=='{')throw new Error();start=i;}
                if(quoted){if(escaped)escaped=false;else if(ch==='\\')escaped=true;else if(ch==='"')quoted=false;continue;}
                if(ch==='"')quoted=true;
                else if(ch==='['||ch==='{')depth++;
                else if(ch===']'||ch==='}'){
                    if(--depth===0){documents.push(JSON.parse(clean.slice(start,i+1)));start=-1;}
                }
            }
            if(start>=0||!documents.length)throw new Error();
        }catch{throw new Error('请提供完整 JSON 名称数组或含 name / 名称 的对象数组');}
    }
    return documents.flatMap(value=>{
        const data=Array.isArray(value)?value:value?.characters||value?.entities||value?.items||value?.人物||value?.道具;
        if (!Array.isArray(data)) throw new Error('未找到资料数组');
        return data.map(value => normalizeEntity(typeof value === 'string' ? {name:value} : { ...value, name:value?.name || value?.名称, outputName:value?.outputName || value?.主名称, type:value?.type === '道具' ? 'prop' : value?.type === '设定' ? 'setting' : value?.type }));
    });
}
