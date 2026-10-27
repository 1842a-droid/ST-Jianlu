const CARD_FIELDS = ['description', 'personality', 'scenario', 'first_mes', 'mes_example'];
const copy = value => structuredClone(value);

export function characterCard(name, content) {
    if (!String(name || '').trim() || !String(content || '').trim()) throw new Error('名称和内容不能为空');
    return { spec: 'chara_card_v2', spec_version: '2.0', data: { name: String(name).trim(), description: String(content), personality: '', scenario: '', first_mes: '', mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '', alternate_greetings: [], tags: [], creator: 'Jianlu', character_version: '1', extensions: {} } };
}

export function worldEntry(uid, { name, content, keys = [] }) {
    if (!String(name || '').trim() || !String(content || '').trim()) throw new Error('世界书条目的名称和内容不能为空');
    const words = (Array.isArray(keys) ? keys : String(keys).split(/[\n,，、]/)).map(x => String(x).trim()).filter(Boolean);
    return { uid, key: words.length ? [...new Set(words)] : [String(name)], keysecondary: [], comment: String(name), content: String(content), constant: false, selective: true, selectiveLogic: 0, order: 100, position: 0, disable: false, excludeRecursion: false, preventRecursion: false, probability: 100, useProbability: true, depth: 4, role: 0, sticky: 0, cooldown: 0, delay: 0 };
}

/** Targets are always stable avatar IDs / exact book names, never the active chat. */
export function createTavern({ getContext = () => globalThis.SillyTavern?.getContext?.(), fetch: request = globalThis.fetch?.bind(globalThis), loadModule = path => import(path), getHelper = () => globalThis.TavernHelper } = {}) {
    const ctx = () => { const value = getContext(); if (!value) throw new Error('酒馆尚未就绪，请刷新酒馆'); return value; };
    const modules = new Map();
    const module = path => { if (!modules.has(path)) modules.set(path, loadModule(path).catch(() => null)); return modules.get(path); };
    async function headers(form) {
        const c = ctx();
        const getter = c.getRequestHeaders || (await module('/script.js'))?.getRequestHeaders;
        const raw = getter ? getter() : { 'Content-Type': 'application/json' };
        const result = Object.fromEntries(new Headers(raw).entries());
        if (form) delete result['content-type'];
        else result['content-type'] = 'application/json';
        return result;
    }
    async function post(url, data, { form = false, textOK = false } = {}) {
        const response = await request(url, { method: 'POST', credentials: 'same-origin', headers: await headers(form), body: form ? data : JSON.stringify(data) });
        const text = await response.text();
        if (!response.ok) {
            const error = new Error(`${response.status === 401 || response.status === 403 ? '酒馆登录或权限已失效，请重新登录后重试' : '酒馆接口请求失败'} (${response.status})：${text.replace(/<[^>]*>/g, '').slice(0, 150)}`);
            error.status = response.status; error.endpoint = url; throw error;
        }
        if (/^\s*(?:<!doctype|<html)/i.test(text)) throw new Error('酒馆返回了登录页面，请重新登录后重试');
        let value;
        try { value = JSON.parse(text); if (typeof value === 'string' && /^[\[{]/.test(value.trim())) value = JSON.parse(value); }
        catch { if (textOK && (!text.trim() || /^OK$/i.test(text.trim()))) return {}; throw new Error('酒馆返回的数据格式不正确，请检查酒馆版本'); }
        if (value?.error) throw new Error(value.error.message || value.message || '酒馆拒绝保存');
        return value;
    }
    function characterTargets(values) {
        if (!values || typeof values !== 'object') throw new Error('角色卡列表格式无效');
        const list = Array.isArray(values) ? values : Object.values(values);
        return [...new Map(list.filter(x => x && typeof x.avatar === 'string').map(x => [x.avatar, { id: x.avatar, name: x.name || x.data?.name || x.avatar }])).values()];
    }
    async function listCharacters({ refresh = false } = {}) {
        const c = ctx();
        const cached = characterTargets(c.characters || []);
        if (cached.length && !refresh) return cached;
        try { return characterTargets(await post('/api/characters/all', {})); }
        catch (error) { if (cached.length) return cached; throw error; }
    }
    function namesOf(values) {
        if (!Array.isArray(values)) throw new Error('世界书列表格式无效');
        return [...new Set(values.map(x => typeof x === 'string' ? x : x?.file_id || x?.name).filter(x => typeof x === 'string' && x.trim()))].sort((a,b) => a.localeCompare(b, 'zh-CN'));
    }
    async function listWorldbooks() {
        const c = ctx();
        try { return namesOf(await post('/api/worldinfo/list', {})); }
        catch (error) {
            if (![404,405].includes(error.status)) throw error;
            // Older ST versions do not have /worldinfo/list. Both native sources
            // below and the helper API used by the supplied tool card predate it.
            if (typeof c.getWorldInfoNames === 'function') return namesOf(await c.getWorldInfoNames());
            const helper = getHelper();
            if (typeof helper?.getWorldbookNames === 'function') return namesOf(await helper.getWorldbookNames());
            const native = await module('/scripts/world-info.js');
            if (Array.isArray(native?.world_names)) return namesOf(native.world_names);
            const settings = await post('/api/settings/get', {});
            if (Array.isArray(settings?.world_names)) return namesOf(settings.world_names);
            throw new Error('无法读取世界书列表，请更新酒馆或重新登录');
        }
    }
    async function targets() {
        const results = await Promise.allSettled([listCharacters(), listWorldbooks()]);
        return { characters: results[0].status === 'fulfilled' ? results[0].value : [], worldbooks: results[1].status === 'fulfilled' ? results[1].value : [], errors: Object.fromEntries(results.flatMap((r,i) => r.status === 'rejected' ? [[i ? 'worldbooks' : 'characters', r.reason.message]] : [])) };
    }
    async function refreshSafely(name) {
        try {
            const native=typeof ctx()[name]==='function'?ctx():await module(name==='getCharacters'?'/script.js':'/scripts/world-info.js');
            if(typeof native?.[name]==='function')await native[name]();
            return '';
        } catch { return '内容已保存，酒馆列表刷新失败；请手动刷新页面查看'; }
    }
    async function writeCharacter({ target = 'new', name, content, field = 'description', mode = 'append' }) {
        if (!CARD_FIELDS.includes(field)) throw new Error('不支持的角色卡字段');
        if (!['append', 'replace'].includes(mode)) throw new Error('写入方式无效');
        if (!String(content || '').trim()) throw new Error('没有可写入的内容');
        if (target === 'new') {
            const card = characterCard(name, content);
            if (field !== 'description') { card.data.description = ''; card.data[field] = String(content); }
            const form = new FormData();
            form.append('avatar', new Blob([JSON.stringify(card)], { type: 'application/json' }), 'jianlu-character.json');
            form.append('file_type', 'json');
            const result = await post('/api/characters/import', form, { form: true });
            if (!result.file_name) throw new Error('酒馆没有返回新角色卡标识，请先刷新检查是否已创建');
            return { target: result.file_name, name, created: true, warning: await refreshSafely('getCharacters') };
        }
        if (typeof target !== 'string' || /[\/\\]/.test(target) || !/\.png$/i.test(target)) throw new Error('请选择有效的目标角色卡');
        const current = await post('/api/characters/get', { avatar_url: target });
        if (!current?.name && !current?.data?.name) throw new Error('目标角色卡读取失败，请重新选择');
        const previous = current.data?.[field] ?? current[field] ?? '';
        const next = mode === 'append' && previous ? `${previous}\n\n${content}` : String(content);
        await post('/api/characters/edit-attribute', { avatar_url: target, ch_name: current.name || current.data?.name, field, value: next }, { textOK: true });
        const verified = await post('/api/characters/get', { avatar_url: target });
        if ((verified.data?.[field] ?? verified[field]) !== next) throw new Error('角色卡保存校验未通过，请刷新检查后再决定是否重试');
        return { target, name: verified.name || verified.data?.name, created: false, warning: await refreshSafely('getCharacters') };
    }
    async function writeWorldbook({ name, entries, create = false, operationId }) {
        name = String(name || '').trim();
        if (!name || name === '.' || name === '..' || /[\/\\<>:"|?*\x00-\x1f]/.test(name)) throw new Error('世界书名称无效');
        if (!Array.isArray(entries) || !entries.length) throw new Error('没有可写入的条目');
        // Validate all input before any write, including creating an empty book.
        entries.forEach((entry,i) => worldEntry(i, entry));
        const exists = (await listWorldbooks()).includes(name);
        const data = exists ? await post('/api/worldinfo/get', { name }) : { entries: {} };
        if (!data?.entries || typeof data.entries !== 'object' || Array.isArray(data.entries)) throw new Error('目标世界书格式无效');
        const existing = Object.values(data.entries);
        if (operationId) {
            const previous = existing.filter(x => x.extensions?.jianlu?.operationId === operationId);
            if (previous.length === entries.length && entries.every((e,i) => previous.some(x => x.extensions.jianlu.index === i && x.content === e.content && x.comment === e.name))) return { name, count: entries.length, created: create, alreadySaved: true };
        }
        if (create && exists) throw new Error('同名世界书已存在，请选择导入已有世界书或更换名称');
        if (!create && !exists) throw new Error('目标世界书不存在，请重新选择');
        let uid = -1;
        for (const key of Object.keys(data.entries)) if (Number.isFinite(Number(key))) uid = Math.max(uid, Number(key));
        for (const entry of existing) if (Number.isFinite(Number(entry.uid))) uid = Math.max(uid, Number(entry.uid));
        uid++;
        const added = entries.map((entry,index) => ({ ...worldEntry(uid++, entry), ...(operationId ? { extensions: { jianlu: { operationId, index } } } : {}) }));
        const next = copy(data);
        for (const entry of added) next.entries[entry.uid] = entry;
        const native = ctx().saveWorldInfo ? ctx() : await module('/scripts/world-info.js');
        let saveError;
        try {
            if (typeof native?.saveWorldInfo === 'function') await native.saveWorldInfo(name, next, true);
            else await post('/api/worldinfo/edit', { name, data: next }, { textOK: true });
        } catch (error) { saveError = error; }
        let verified;
        try { verified = await post('/api/worldinfo/get', { name }); } catch (error) { throw saveError || error; }
        if (added.some(entry => verified?.entries?.[entry.uid]?.content !== entry.content || verified.entries[entry.uid].comment !== entry.comment)) throw saveError || new Error('世界书保存校验未通过，请刷新检查后再决定是否重试');
        const warning = await refreshSafely('updateWorldInfoList');
        return { name, count: added.length, created: create, warning: warning || (saveError ? '内容已保存，酒馆更新事件报错；请刷新查看' : '') };
    }
    return { targets, listCharacters, listWorldbooks, writeCharacter, writeWorldbook };
}
