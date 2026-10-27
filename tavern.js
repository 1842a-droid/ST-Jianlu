export function characterCard(name, content) {
    if (!String(name).trim() || !String(content).trim()) throw new Error('名称和内容不能为空');
    return { spec: 'chara_card_v2', spec_version: '2.0', data: { name: String(name).trim(), description: String(content), personality: '', scenario: '', first_mes: '', mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '', alternate_greetings: [], tags: [], creator: 'Jianlu', character_version: '1', extensions: {} } };
}

export function worldEntry(uid, { name, content, keys = [] }) {
    if (!String(name).trim() || !String(content).trim()) throw new Error('世界书条目的名称和内容不能为空');
    return { uid, key: keys.length ? keys.map(String) : [String(name)], keysecondary: [], comment: String(name), content: String(content), constant: false, selective: true, selectiveLogic: 0, order: 100, position: 0, disable: false, excludeRecursion: false, preventRecursion: false, probability: 100, useProbability: true, depth: 4, role: 0, sticky: 0, cooldown: 0, delay: 0 };
}

/** Explicit target only; no current-character guessing or automatic overwrites. */
export function createTavern({ getContext = () => globalThis.SillyTavern?.getContext?.(), fetch: request = globalThis.fetch?.bind(globalThis) } = {}) {
    const ctx = () => { const value = getContext(); if (!value) throw new Error('酒馆尚未就绪'); return value; };
    async function post(url, data, form = false) {
        const headers = { ...ctx().getRequestHeaders() };
        if (form) for (const key of Object.keys(headers)) if (key.toLowerCase() === 'content-type') delete headers[key];
        const response = await request(url, { method: 'POST', headers, body: form ? data : JSON.stringify(data) });
        if (!response.ok) {const error=new Error(`酒馆保存失败 (${response.status})：${(await response.text()).slice(0, 160)}`);error.status=response.status;throw error;}
        const text = await response.text();
        let value; try { value = JSON.parse(text); } catch { return {}; }
        if (value?.error) throw new Error(value.error.message || '酒馆拒绝保存');
        return value;
    }
    async function targets() {
        const c = ctx();
        let worlds;
        try { worlds = (await post('/api/worldinfo/list', {})).map(item => item.file_id || item.name); }
        catch (error) { if (![404,405].includes(error.status)||typeof c.getWorldInfoNames !== 'function') throw error; worlds = c.getWorldInfoNames(); }
        return { characters: (c.characters || []).filter(x => x.avatar).map(x => ({ id: x.avatar, name: x.name || x.data?.name || x.avatar })), worldbooks: worlds || [] };
    }
    async function writeCharacter({ target = 'new', name, content, field = 'description', mode = 'append' }) {
        if (!['description', 'personality', 'scenario', 'first_mes', 'mes_example'].includes(field)) throw new Error('不支持的角色卡字段');
        if (!['append', 'replace'].includes(mode)) throw new Error('写入方式无效');
        if (!String(content || '').trim()) throw new Error('没有可写入的内容');
        if (target === 'new') {
            const card = characterCard(name, content);
            if (field !== 'description') { card.data.description = ''; card.data[field] = content; }
            const form = new FormData();
            form.append('avatar', new Blob([JSON.stringify(card)], { type: 'application/json' }), 'jianlu-character.json');
            form.append('file_type', 'json');
            const result = await post('/api/characters/import', form, true);
            if (!result.file_name) throw new Error('酒馆没有返回新角色卡标识');
            await ctx().getCharacters?.();
            return { target: result.file_name, name, created: true };
        }
        if (/[\/\\]/.test(target) || !target.endsWith('.png')) throw new Error('角色卡标识无效');
        const current = await post('/api/characters/get', { avatar_url: target });
        const previous = current.data?.[field] ?? current[field] ?? '';
        const next = mode === 'append' && previous ? `${previous}\n\n${content}` : String(content);
        await post('/api/characters/edit-attribute', { avatar_url: target, ch_name: current.name || current.data?.name, field, value: next });
        const verified = await post('/api/characters/get', { avatar_url: target });
        if ((verified.data?.[field] ?? verified[field]) !== next) throw new Error('角色卡保存校验未通过，请刷新后检查');
        await ctx().getCharacters?.();
        return { target, name: verified.name || verified.data?.name, created: false };
    }
    async function writeWorldbook({ name, entries, create = false }) {
        if (!String(name || '').trim() || /[\/\\<>:"|?*\x00-\x1f]/.test(name)) throw new Error('世界书名称无效');
        if (!Array.isArray(entries) || !entries.length) throw new Error('没有可写入的条目');
        const names = (await targets()).worldbooks;
        if (create && names.includes(name)) throw new Error('同名世界书已存在，请选择追加或更换名称');
        if (!create && !names.includes(name)) throw new Error('目标世界书不存在');
        const data = create ? { entries: {} } : await post('/api/worldinfo/get', { name });
        if (!data.entries || typeof data.entries !== 'object' || Array.isArray(data.entries)) throw new Error('目标世界书格式无效');
        let uid = Object.keys(data.entries).reduce((max,key)=>Number.isFinite(Number(key))?Math.max(max,Number(key)):max,-1) + 1;
        const added = entries.map(entry => worldEntry(uid++, entry));
        for (const entry of added) data.entries[entry.uid] = entry;
        if (ctx().saveWorldInfo) await ctx().saveWorldInfo(name, data, true);
        else await post('/api/worldinfo/edit', { name, data });
        const verified = await post('/api/worldinfo/get', { name });
        if (added.some(entry => verified.entries?.[entry.uid]?.content !== entry.content)) throw new Error('世界书保存校验未通过，请刷新后检查');
        await ctx().updateWorldInfoList?.();
        return { name, count: added.length };
    }
    return { targets, writeCharacter, writeWorldbook };
}
