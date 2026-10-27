import { newId } from './store.js';

const node = (tag, text, attributes = {}) => {
    const value = document.createElement(tag);
    if (text !== undefined) value.textContent = text;
    for (const [key, item] of Object.entries(attributes)) {
        if (key in value) value[key] = item; else value.setAttribute(key, item);
    }
    return value;
};
function field(body, name, control) {
    const label = node('label'); label.append(node('span', name), control); body.append(label); return control;
}
function options(control, values, selected = '') {
    control.replaceChildren(...values.map(([value, label]) => node('option', label, { value })));
    control.value = values.some(([id]) => id === selected) ? selected : '';
}

/** No target list can prevent the other destination from being used. */
export function createPublishUI({ tavern, ui, getProject, notify }) {
    return async function publish({ text = '', name = '', entries } = {}) {
        const project = getProject();
        const list = entries?.length ? entries : [{ name: name || project?.title || '新资料', content: text, keys: [name || '新资料'] }];
        if (list.some(x => !String(x.content || '').trim())) throw new Error('所选资料中有空内容，请先保存输出');
        const multi = list.length > 1;
        const body = node('div', undefined, { className: 'jl-form jl-publish-form' });
        const destination = field(body, '导入到', node('select'));
        options(destination, [['character','角色卡'],['world','已有世界书'],['newWorld','新建世界书']], 'character');
        const lookup = field(body, '搜索目标', node('input', undefined, { value: '', placeholder: '输入名称筛选' }));
        const character = field(body, '目标角色卡', node('select'));
        const book = field(body, '目标世界书', node('select'));
        const newName = field(body, '新建名称', node('input', undefined, { value: name || list[0].name }));
        const entryName = multi ? null : field(body, '条目名称', node('input', undefined, { value: list[0].name }));
        const cardField = field(body, '写入字段', node('select'));
        options(cardField, [['description','角色描述'],['personality','性格'],['scenario','场景'],['first_mes','开场白'],['mes_example','对话示例']], 'description');
        const mode = field(body, '写入方式', node('select'));
        options(mode, [['append','追加到字段'],['replace','替换该字段']], 'append');
        const keys = field(body, '触发词', node('input', undefined, { value: (list[0].keys || [list[0].name]).join('、') }));
        const status = node('p', '', { className: 'jl-inline-status', role: 'status' });
        const refresh = node('button', '重新加载目标', { type: 'button', className: 'jl-button jl-quiet' });
        body.append(status, refresh);
        const content = field(body, multi ? '待写入条目（JSON 数组）' : '待写入内容', node('textarea', undefined, { value: multi ? JSON.stringify(list, null, 2) : list[0].content, rows: 16, spellcheck: false }));
        let targets = { characters: [], worldbooks: [], errors: {} }, loading = false;
        const setHidden = (control, hidden) => { if (control) control.parentElement.hidden = hidden; };
        function sync() {
            const card = destination.value === 'character';
            const creatingCard = card && character.value === 'new';
            setHidden(lookup, destination.value === 'newWorld');
            setHidden(character, !card); setHidden(book, destination.value !== 'world');
            setHidden(newName, !(destination.value === 'newWorld' || (creatingCard && !multi)));
            setHidden(entryName, card); setHidden(keys, card || multi);
            setHidden(cardField, !card); setHidden(mode, !card || creatingCard);
            const error = targets.errors?.[card ? 'characters' : 'worldbooks'];
            status.textContent = loading ? '正在读取目标…' : error || '';
            status.hidden = !status.textContent;
        }
        function filter() {
            const query = lookup.value.trim().toLocaleLowerCase();
            const oldCharacter = character.value, oldBook = book.value;
            const chars = targets.characters.filter(x => `${x.name} ${x.id}`.toLocaleLowerCase().includes(query));
            const duplicates = new Map();
            targets.characters.forEach(x => duplicates.set(x.name, (duplicates.get(x.name) || 0) + 1));
            options(character, [['','选择角色卡'], ...chars.map(x => [x.id, duplicates.get(x.name) > 1 ? `${x.name} · ${x.id}` : x.name]), ['new','＋ 新建角色卡']], oldCharacter);
            options(book, [['','选择世界书'], ...targets.worldbooks.filter(x => x.toLocaleLowerCase().includes(query)).map(x => [x,x])], oldBook);
            sync();
        }
        async function load() {
            loading = true; refresh.disabled = true; sync();
            try { targets = await tavern.targets(); targets.errors ||= {}; }
            catch (error) { targets = { characters: [], worldbooks: [], errors: { characters: error.message, worldbooks: error.message } }; }
            finally { loading = false; refresh.disabled = false; filter(); }
        }
        destination.onchange = () => { lookup.value = ''; filter(); };
        character.onchange = book.onchange = sync;
        lookup.oninput = filter;
        refresh.onclick = () => { void load(); };
        // Complete the first read before opening; failures stay inside the form.
        await load();
        let operationId = newId(), priorPayload = '';
        for (;;) {
            const choice = await ui.dialog({ title: '写入酒馆', body, layout: 'wide', buttons: [
                { label: '取消', value: 'cancel' }, { label: '确认导入', value: 'write', primary: true },
            ] });
            if (choice !== 'write') return;
            try {
                if (loading) throw new Error('目标仍在加载，请稍后再试');
                const card = destination.value === 'character';
                if (card && !character.value) throw new Error('请选择要导入的角色卡');
                if (destination.value === 'world' && !book.value) throw new Error('请选择要导入的世界书');
                const creating = destination.value === 'newWorld' || (card && character.value === 'new');
                if (creating && !multi && !newName.value.trim()) throw new Error('请填写新建名称');
                if (destination.value === 'newWorld' && !newName.value.trim()) throw new Error('请填写世界书名称');
                const data = multi ? JSON.parse(content.value) : [{ name: entryName?.value.trim() || list[0].name, content: content.value, keys: keys.value.split(/[\n,，、]+/).map(x => x.trim()).filter(Boolean) }];
                if (!Array.isArray(data) || !data.length || data.some(x => !String(x.name || '').trim() || !String(x.content || '').trim())) throw new Error('名称或内容为空');
                const payload = JSON.stringify([destination.value, character.value, book.value, newName.value, data, cardField.value, mode.value]);
                if (priorPayload && priorPayload !== payload) operationId = newId();
                priorPayload = payload;
                let result;
                if (!card) {
                    result = await tavern.writeWorldbook({ name: destination.value === 'newWorld' ? newName.value.trim() : book.value, create: destination.value === 'newWorld', entries: data, operationId });
                } else if (character.value === 'new') {
                    const warnings = [];
                    for (let i = 0; i < data.length; i++) {
                        result = await tavern.writeCharacter({ target: 'new', name: multi ? data[i].name : newName.value.trim(), content: data[i].content, field: cardField.value });
                        if (result?.warning) warnings.push(result.warning);
                        if (multi) { data.splice(i, 1); i--; content.value = JSON.stringify(data, null, 2); }
                    }
                    result = { warning: warnings.join('\n') };
                } else {
                    result = await tavern.writeCharacter({ target: character.value, content: data.map(x => multi ? `${x.name}\n${x.content}` : x.content).join('\n\n'), field: cardField.value, mode: mode.value });
                }
                notify(result?.warning || '已导入酒馆', result?.warning ? 'warning' : 'success');
                return result;
            } catch (error) {
                status.textContent = error.message; status.hidden = false;
                notify(error.message, 'error');
            }
        }
    };
}
