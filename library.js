import { newId } from './store.js';
export const terms = value => [...new Set((Array.isArray(value) ? value : String(value || '').split(/[\n,，、;；]+/)).map(x => String(x).trim()).filter(Boolean))];
export function normalizeEntity(value = {}) {
    const name = String(value.name || '').trim();
    if (!name) throw new Error('请填写检索名称');
    return { ...value, id: value.id || newId(), type: ['character', 'prop', 'setting'].includes(value.type) ? value.type : 'character', name, outputName: String(value.outputName || name).trim() || name, aliases: terms(value.aliases), searchTerms: terms(value.searchTerms), contextTerms: terms(value.contextTerms), notes: String(value.notes || ''), content: String(value.content || ''), stage: String(value.stage || '') };
}
export function mergeEntities(records, primaryId, asAliases = false) {
    const primary = normalizeEntity(records.find(x => x.id === primaryId));
    const extra = records.filter(x => x.id !== primaryId);
    return normalizeEntity({ ...primary, aliases: [...primary.aliases, ...(asAliases ? extra.flatMap(x => [x.name, ...(x.aliases || [])]) : [])], contextTerms: [...primary.contextTerms, ...extra.flatMap(x => [...(x.contextTerms || []), ...(asAliases ? [] : [x.name, ...(x.aliases || [])])])], content: [primary.content, ...extra.map(x => x.content)].filter(Boolean).join('\n\n') });
}
export function entityInstructions(entity, { format = '', check = false } = {}) {
    const e = normalizeEntity(entity);
    return `【本次${check ? '检查' : '生成'}对象】\n${JSON.stringify({对象类型:e.type === 'character' ? '人物' : e.type === 'prop' ? '道具' : '设定',输出主名称:e.outputName,原文检索名称:e.name,真正的同人别名:e.aliases,附加检索词:e.searchTerms,关联背景_不是同人别名:e.contextTerms,限定阶段:e.stage,补充要求:e.notes}, null, 2)}\n` +
        `只为「${e.outputName}」${check ? '核对、纠错并补充所给资料' : '生成资料'}，使用该输出主名称。检索词用于找材料，不代表这些词是同一个人。族群、道具、组织、其他人物的经历和属性不得归给主对象；不能确认的信息标为未确认，不编造。${e.stage ? '只写指定阶段，不混入其他阶段的状态与经历。' : ''}\n${format ? `【本次输出格式】\n${format}` : '输出格式沿用当前酒馆预设。'}${check ? `\n【待检查资料】\n${e.content}` : ''}`;
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
    const clean = String(text).trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
    let data; try { data = JSON.parse(clean); } catch { throw new Error('请提供 JSON 名称数组或含 name / 名称 的对象数组'); }
    if (!Array.isArray(data)) data = data.characters || data.entities || data.items || data.人物 || data.道具;
    if (!Array.isArray(data)) throw new Error('未找到资料数组');
    return data.map(value => normalizeEntity(typeof value === 'string' ? {name:value} : { ...value, name:value.name || value.名称, outputName:value.outputName || value.主名称, type:value.type === '道具' ? 'prop' : value.type === '设定' ? 'setting' : value.type }));
}
