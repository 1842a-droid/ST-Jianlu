import { copyText } from './ui.js';

const defaultSettings = { theme: 'host', fontSize: 13 };

export function decodeNovel(buffer) {
    const bytes = new Uint8Array(buffer);
    if (bytes[0] === 255 && bytes[1] === 254) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
    if (bytes[0] === 254 && bytes[1] === 255) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, ''); }
    catch { return new TextDecoder('gb18030', { fatal: true }).decode(bytes); }
}

export function safeFileName(text, suffix = '') {
    return (String(text || '笺录').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 100) || '笺录') + suffix;
}

function el(tag, attrs = {}, text) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
        if (key === 'class') node.className = value;
        else if (key in node) node[key] = value;
        else node.setAttribute(key, String(value));
    }
    if (text !== undefined) node.textContent = text;
    return node;
}

function field(parent, label, node) {
    const wrap = el('label', { class: 'jl-form-field' });
    wrap.append(el('span', {}, label), node); parent.append(wrap); return node;
}

function select(options, value) {
    const node = el('select');
    for (const [id, name] of options) node.append(el('option', { value: id }, name));
    node.value = value ?? options[0]?.[0] ?? ''; return node;
}

function saveFile(name, text, type = 'text/plain;charset=utf-8') {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = el('a', { href: url, download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 15000);
}

async function pickFile(accept = '.txt,.md,.text') {
    return new Promise(resolve => {
        const input = el('input', { type: 'file', accept, hidden: true });
        let settled = false;
        const done = value => { if (settled) return; settled = true; input.remove(); resolve(value); };
        input.addEventListener('change', () => done(input.files?.[0] || null), { once: true });
        input.addEventListener('cancel', () => done(null), { once: true });
        document.body.append(input); input.click();
    });
}

export function createController({ repo, host, queue, ui, context = () => globalThis.SillyTavern?.getContext?.() }) {
    const state = {
        projects: [], project: null, runs: [], run: null, hostInfo: {}, active: null,
        busy: false, filter: 'all', selectedIds: [], page: 0, pageSize: 30,
        settings: { ...defaultSettings }, notice: '',
    };
    let sourceCache = null;
    let refreshVersion = 0;
    let drawer = null;
    let destroyed = false;
    let refreshPending = false;
    const disposers = [];

    const draw = () => { if (!destroyed) { state.active = queue.current(); ui.render(state); } };
    const notify = (message, type = 'info') => {
        if (ui.notify) ui.notify(message, type);
        else host.notify?.(message, type);
    };
    const report = error => {
        const message = error?.message || String(error);
        state.notice = message; notify(message, 'error'); draw();
    };
    const toast = message => { state.notice = ''; notify(message, 'success'); };
    const persistSettings = () => {
        const ctx = context();
        if (ctx?.extensionSettings) {
            ctx.extensionSettings.jianlu = { ...state.settings };
            ctx.saveSettingsDebounced?.();
        }
    };

    async function refreshHost() { state.hostInfo = await host.info(); draw(); }

    async function refresh() {
        const version = ++refreshVersion;
        const projectId = state.project?.id;
        const runId = state.run?.id;
        const projects = await repo.listProjects();
        const project = projectId ? await repo.getProject(projectId) : null;
        const runs = project ? await repo.listRuns(projectId) : [];
        const selected = runs.find(run => run.id === runId) || runs[0] || null;
        const run = selected ? await repo.getRun(selected.id) : null;
        if (destroyed || version !== refreshVersion || state.project?.id !== projectId) return;
        Object.assign(state, { projects, project, runs, run });
        const available = new Set((run?.chunks || []).map(chunk => chunk.id));
        state.selectedIds = state.selectedIds.filter(id => available.has(id));
        draw();
    }

    function scheduleRefresh() {
        if (refreshPending || destroyed) return;
        refreshPending = true;
        queueMicrotask(() => {
            refreshPending = false;
            refresh().catch(report);
        });
    }

    async function init() {
        const config = context()?.extensionSettings?.jianlu || {};
        state.settings = {
            theme: ['host', 'light', 'dark'].includes(config.theme) ? config.theme : 'host',
            fontSize: Math.min(16, Math.max(12, Number(config.fontSize) || 13)),
        };
        ui.mount();
        await refresh(); await refreshHost();
        disposers.push(queue.subscribe(scheduleRefresh));
        if (host.subscribe) disposers.push(host.subscribe(() => refreshHost().catch(report)));
    }

    async function open() { ui.open(); await refresh(); await refreshHost(); }

    async function openProject(id) {
        await queue.recover(id);
        const project = await repo.getProject(id);
        if (!project) throw new Error('项目不存在，请刷新项目列表');
        drawer?.close?.(); sourceCache = null; state.project = project; state.run = null;
        state.selectedIds = []; state.page = 0; state.filter = 'all'; state.notice = '';
        await refresh();
    }

    async function readRunSource(run) {
        if (sourceCache?.file === run.sourceFile) return sourceCache.text;
        const text = await repo.readSourceFile(run.sourceFile);
        sourceCache = { file: run.sourceFile, text }; return text;
    }

    async function newProject() {
        const body = el('div', { class: 'jl-form' });
        const title = field(body, '项目名称', el('input', { type: 'text', autocomplete: 'off' }));
        const choose = el('button', { type: 'button', class: 'jl-button' }, '选择小说文件');
        const count = el('span', { class: 'jl-muted' });
        const text = field(body, '原文', el('textarea', { rows: 10, placeholder: '粘贴小说，或选择文件', spellcheck: false }));
        body.insertBefore(choose, text.parentElement); body.insertBefore(count, text.parentElement);
        let sourceText = ''; let sourceName = '粘贴文本.txt'; let loading = Promise.resolve();
        text.addEventListener('input', () => { sourceText = text.value; count.textContent = `${sourceText.length.toLocaleString()} 字`; });
        choose.addEventListener('click', () => {
            loading = (async () => {
                const file = await pickFile(); if (!file) return;
                sourceText = decodeNovel(await file.arrayBuffer()); sourceName = file.name;
                if (!title.value.trim()) title.value = file.name.replace(/\.[^.]+$/, '');
                text.value = sourceText.slice(0, 200000); text.readOnly = sourceText.length > 200000;
                count.textContent = `${file.name} · ${sourceText.length.toLocaleString()} 字${text.readOnly ? ' · 预览前 20 万字' : ''}`;
            })().catch(report);
        });
        for (;;) {
            const value = await ui.dialog({ title: '新建项目', body, buttons: [{ label: '取消', value: 'cancel' }, { label: '创建', value: 'create', primary: true }] });
            if (value !== 'create') return;
            await loading;
            if (!title.value.trim() || !sourceText.trim()) { notify('请填写项目名称并导入原文', 'warning'); continue; }
            const project = await repo.createProject({ title: title.value.trim(), sourceName, sourceText });
            await openProject(project.id); toast('项目已保存'); return;
        }
    }

    async function source() {
        if (!state.project) return;
        const projectId = state.project.id;
        const original = await repo.getSource(projectId);
        let current = original; let name = state.project.sourceName;
        const body = el('div', { class: 'jl-form' });
        const count = el('p', { class: 'jl-muted' }, `${name} · ${original.length.toLocaleString()} 字${original.length > 200000 ? ' · 预览前 20 万字' : ''}`);
        const text = el('textarea', { rows: 16, spellcheck: false, value: original.slice(0, 200000), readOnly: original.length > 200000 });
        const pick = el('button', { type: 'button' }, '替换文件');
        body.append(count, text, pick);
        let loading = Promise.resolve();
        text.addEventListener('input', () => { current = text.value; });
        pick.addEventListener('click', () => {
            loading = (async () => {
                const file = await pickFile(); if (!file) return;
                current = decodeNovel(await file.arrayBuffer()); name = file.name;
                text.value = current.slice(0, 200000); text.readOnly = current.length > 200000;
                count.textContent = `${name} · ${current.length.toLocaleString()} 字${text.readOnly ? ' · 预览前 20 万字' : ''}`;
            })().catch(report);
        });
        const value = await ui.dialog({ title: '小说原文', body, buttons: [
            { label: '关闭', value: 'cancel' }, { label: '导出原文', value: 'export' }, { label: '保存', value: 'save', primary: true },
        ] });
        await loading;
        if (value === 'export') saveFile(safeFileName(name), current);
        if (value === 'save' && current !== original) {
            if (!current.trim()) throw new Error('原文不能为空');
            await repo.setSource(projectId, current, name); sourceCache = null;
            await refresh(); toast('原文已保存，已有任务保留原来的输入');
        }
    }

    async function renameProject() {
        const project = state.project; if (!project) return;
        const body = el('div', { class: 'jl-form' });
        const title = field(body, '项目名称', el('input', { value: project.title }));
        const choice = await ui.dialog({ title: '项目名称', body, buttons: [{ label: '取消', value: 'cancel' }, { label: '保存', value: 'save', primary: true }] });
        if (choice !== 'save') return;
        if (!title.value.trim()) throw new Error('项目名称不能为空');
        await repo.updateProject(project.id, { title: title.value.trim() }); await refresh();
    }

    async function deleteProject() {
        const project = state.project; if (!project) return;
        if (queue.current()?.projectId === project.id) throw new Error('请先暂停当前项目的任务');
        const body = el('p', {}, `删除「${project.title}」及其原文、任务和结果？`);
        const choice = await ui.dialog({ title: '删除项目', body, buttons: [{ label: '取消', value: 'cancel' }, { label: '删除', value: 'delete', danger: true }] });
        if (choice !== 'delete') return;
        await repo.deleteProject(project.id); state.project = null; state.run = null; sourceCache = null; await refresh();
    }

    async function newRun() {
        const project = state.project; if (!project) return;
        const body = el('div', { class: 'jl-form' });
        const title = field(body, '任务名称', el('input', { value: `处理任务 · ${new Date().toLocaleDateString()}` }));
        const sourceType = field(body, '输入', select([['novel', '小说原文'], ['result', '已有任务的结果'], ['paste', '粘贴文本']], 'novel'));
        const prior = field(body, '来源任务', select(state.runs.map(run => [run.id, run.title]), state.run?.id));
        const pasted = field(body, '输入文本', el('textarea', { rows: 9, spellcheck: false }));
        const splitMode = field(body, '分块方式', select([['characters', '按字数'], ['chapters', '按章节']], 'characters'));
        const start = field(body, '起始位置', el('input', { type: 'number', min: 1, value: 1 }));
        const end = field(body, '结束位置', el('input', { type: 'number', min: 1, value: project.length }));
        const size = field(body, '每块字数', el('input', { type: 'number', min: 100, step: 100, value: 6000 }));
        const overlap = field(body, '重叠字数', el('input', { type: 'number', min: 0, step: 50, value: 200 }));
        const chaptersPerChunk = field(body, '每块章数', el('input', { type: 'number', min: 1, step: 1, value: 1 }));
        const chapterStart = field(body, '起始章节序号', el('input', { type: 'number', min: 1, step: 1, value: 1 }));
        const chapterEnd = field(body, '结束章节序号', el('input', { type: 'number', min: 1, step: 1, placeholder: '至末章' }));
        const syncFields = () => {
            const byChapter = splitMode.value === 'chapters';
            prior.parentElement.hidden = sourceType.value !== 'result';
            pasted.parentElement.hidden = sourceType.value !== 'paste';
            start.parentElement.hidden = end.parentElement.hidden = byChapter || sourceType.value !== 'novel';
            size.parentElement.hidden = overlap.parentElement.hidden = byChapter;
            chaptersPerChunk.parentElement.hidden = !byChapter;
            chapterStart.parentElement.hidden = chapterEnd.parentElement.hidden = !byChapter;
        };
        sourceType.addEventListener('change', syncFields); splitMode.addEventListener('change', syncFields); syncFields();
        for (;;) {
            const choice = await ui.dialog({ title: '新建任务', body, buttons: [{ label: '取消', value: 'cancel' }, { label: '生成任务计划', value: 'plan', primary: true }] });
            if (choice !== 'plan') return;
            const options = { projectId: project.id, title: title.value.trim() || '新任务', chunkSize: Number(size.value), overlap: Number(overlap.value), sourceKind: sourceType.value, splitMode: splitMode.value };
            if (splitMode.value === 'chapters') {
                options.chaptersPerChunk = Number(chaptersPerChunk.value);
                options.chapterStart = Number(chapterStart.value);
                if (chapterEnd.value.trim()) options.chapterEnd = Number(chapterEnd.value);
            }
            if (sourceType.value === 'paste') { options.inputText = pasted.value; options.inputName = '粘贴文本'; }
            else if (sourceType.value === 'result') {
                if (!prior.value) { notify('请选择来源任务', 'warning'); continue; }
                const merged = await queue.merge(prior.value, { includePartial: true });
                options.inputText = merged.text; options.inputName = `任务结果：${state.runs.find(run => run.id === prior.value)?.title || ''}`;
            } else if (splitMode.value === 'characters') { options.start = Number(start.value) - 1; options.end = Number(end.value); }
            if (options.inputText !== undefined && !options.inputText.trim()) { notify('输入文本不能为空', 'warning'); continue; }
            try {
                const run = await queue.plan(options);
                state.run = run; state.selectedIds = []; state.filter = 'all'; state.page = 0;
                await refresh(); toast('任务计划已保存'); return;
            } catch (error) { notify(error.message, 'error'); }
        }
    }

    async function openChunk(id) {
        if (!state.run) return;
        const run = await repo.getRun(state.run.id);
        const chunk = await repo.getChunk(run.id, id);
        const full = await readRunSource(run);
        const sourceText = full.slice(chunk.start, chunk.end);
        if (!chunk.snapshot) {
            try {
                chunk.snapshot = { ...await host.capture(sourceText, { projectTitle: state.project?.title, blockIndex: chunk.index, blockTotal: run.chunks.length, blockLabel: chunk.label, rangeStart: chunk.start, rangeEnd: chunk.end }), previewOnly: true };
            } catch (error) { chunk.previewError = error.message; }
        }
        drawer?.close?.(); drawer = ui.showChunk({ chunk, sourceText });
    }

    async function saveChunk(id, output) {
        const run = state.run; if (!run) return;
        if (queue.current()?.runId === run.id) throw new Error('请先暂停任务再编辑输出');
        const chunk = await repo.getChunk(run.id, id);
        if (!String(output).trim()) throw new Error('输出为空，未保存为完成');
        chunk.previousOutput = chunk.output || chunk.previousOutput || '';
        chunk.output = String(output); chunk.status = 'done'; chunk.manual = true;
        chunk.error = ''; chunk.finishReason = 'manual'; chunk.updatedAt = Date.now();
        await repo.saveChunk(run.id, chunk); await refresh();
        drawer?.update?.({ chunk, sourceText: (await readRunSource(run)).slice(chunk.start, chunk.end) });
        toast('该块已保存');
    }

    async function launch(options = {}) {
        if (!state.run) throw new Error('请先新建任务');
        if (queue.current()) throw new Error('已有任务正在运行');
        const runId = state.run.id;
        state.notice = '';
        const work = queue.run(runId, options);
        draw();
        work.catch(report).finally(() => refresh().catch(report));
    }

    async function rerunChunk(id) {
        const body = el('p', {}, '使用当前预设重新处理该块？现有输出会保留为上一版。');
        const choice = await ui.dialog({ title: '重新处理', body, buttons: [{ label: '取消', value: 'cancel' }, { label: '重新处理', value: 'run', primary: true }] });
        if (choice === 'run') { drawer?.close?.(); await launch({ ids: [id], force: true, freshPreset: true }); }
    }

    async function mergeExport() {
        const run = state.run; if (!run) return;
        const merged = await queue.merge(run.id);
        const body = el('div', { class: 'jl-form' });
        const status = el('p', { class: 'jl-muted' }, merged.incomplete ? '包含未完成块' : '已完成');
        const include = el('input', { type: 'checkbox' });
        field(body, '包含被截断的输出', include);
        const format = field(body, '文件格式', select([['txt', '文本 .txt'], ['md', 'Markdown .md'], ['json', '原样 JSON .json']], 'txt'));
        let currentText = merged.text;
        if (currentText.length > 200000) status.textContent += ' · 预览前 20 万字';
        const text = el('textarea', { rows: 15, spellcheck: false, value: currentText.slice(0, 200000), readOnly: currentText.length > 200000 });
        text.addEventListener('input', () => { currentText = text.value; });
        body.prepend(status); body.append(text);
        include.addEventListener('change', () => {
            queue.merge(run.id, { includePartial: include.checked }).then(value => {
                currentText = value.text; text.value = currentText.slice(0, 200000); text.readOnly = currentText.length > 200000;
            }).catch(report);
        });
        const choice = await ui.dialog({ title: '合并结果', body, buttons: [{ label: '关闭', value: 'cancel' }, { label: '复制', value: 'copy' }, { label: '导出', value: 'export', primary: true }] });
        if (choice === 'copy') { await copyText(currentText); toast('已复制'); }
        if (choice === 'export') {
            if (format.value === 'json') {
                try { JSON.parse(currentText); } catch { throw new Error('当前文本不是完整 JSON；可改用文本导出，或通过预设生成合并后的 JSON'); }
            }
            saveFile(safeFileName(run.title, `.${format.value}`), currentText, format.value === 'json' ? 'application/json;charset=utf-8' : 'text/plain;charset=utf-8');
        }
    }

    async function exportBackup() {
        if (!state.project) return;
        const backup = await repo.exportProject(state.project.id);
        saveFile(safeFileName(state.project.title, '-笺录备份.json'), JSON.stringify(backup), 'application/json;charset=utf-8');
    }

    async function importBackup() {
        const file = await pickFile('.json'); if (!file) return;
        let backup;
        try { backup = JSON.parse(await file.text()); } catch { throw new Error('备份不是有效的 JSON 文件'); }
        const imported = await repo.importProject(backup);
        await openProject(imported.id); toast('已作为新项目导入');
    }

    async function apiSettings() {
        if (queue.current()) throw new Error('请先暂停任务再切换模型');
        const available = await host.models();
        const body = el('div', { class: 'jl-form' });
        field(body, '接口来源', el('input', { value: available.source || state.hostInfo.source || '当前接口', readOnly: true }));
        const options = (available.models || []).map(model => [model.id, model.label || model.id]);
        const manualId = '__jianlu_manual_model__';
        const choices = available.editable ? [...options, [manualId, '手动输入模型 ID']] : options;
        const current = options.some(([id]) => id === available.current) ? available.current : available.editable ? manualId : available.current;
        const model = field(body, '模型', select(choices.length ? choices : [['', '暂无可选模型']], current));
        const custom = field(body, '模型 ID', el('input', { value: available.current || '', autocomplete: 'off' }));
        const syncCustom = () => { custom.parentElement.hidden = !available.editable || model.value !== manualId; };
        model.addEventListener('change', syncCustom); syncCustom();
        model.disabled = !available.editable && !options.length;
        const native = el('button', { type: 'button', class: 'jl-settings-row' }, '编辑接口连接 ↗');
        native.addEventListener('click', () => {
            ui.close(); Promise.resolve(host.openApi()).catch(report);
        });
        body.append(native);
        for (;;) {
            const buttons = [{ label: '返回', value: 'cancel' }];
            if (available.editable || options.length) buttons.push({ label: '应用模型', value: 'apply', primary: true });
            const choice = await ui.dialog({ title: '接口与模型', body, buttons });
            if (choice !== 'apply') return;
            try {
                if (queue.current()) throw new Error('请先暂停任务再切换模型');
                const requestedModel = model.value === manualId ? custom.value.trim() : model.value.trim();
                if (!requestedModel) throw new Error('请选择或填写模型');
                await host.setModel(requestedModel); await refreshHost(); toast('模型已切换'); return;
            } catch (error) { notify(error.message, 'error'); }
        }
    }

    async function settings() {
        const body = el('div', { class: 'jl-form' });
        const connection = el('section', { class: 'jl-settings-section' });
        connection.append(el('h3', { class: 'jl-settings-heading' }, '接口'));
        const api = el('button', { type: 'button', class: 'jl-settings-row' });
        const apiValue = el('span', { class: 'jl-settings-value' }, state.hostInfo.model || '选择模型');
        api.append(el('span', {}, '接口与模型'), apiValue, el('span', {}, '›'));
        api.disabled = Boolean(queue.current());
        api.addEventListener('click', () => {
            api.disabled = true;
            apiSettings().then(() => { apiValue.textContent = state.hostInfo.model || '选择模型'; }).catch(report)
                .finally(() => { api.disabled = Boolean(queue.current()); });
        });
        connection.append(api); body.append(connection);
        const theme = field(body, '主题', select([['host', '跟随酒馆'], ['light', '纸白'], ['dark', '墨色']], state.settings.theme));
        const font = field(body, '字号', select([12, 13, 14, 15, 16].map(value => [String(value), `${value}px`]), String(state.settings.fontSize)));
        const saveAppearance = () => {
            state.settings = { theme: theme.value, fontSize: Number(font.value) };
            persistSettings(); draw();
        };
        theme.addEventListener('change', saveAppearance); font.addEventListener('change', saveAppearance);
        if (state.project) {
            const project = el('section', { class: 'jl-settings-section' });
            project.append(el('h3', { class: 'jl-settings-heading' }, '项目'));
            for (const [label, action, danger] of [['重命名项目', renameProject], ['导出项目备份', exportBackup], ['删除项目', deleteProject, true]]) {
                const button = el('button', { type: 'button', class: `jl-settings-row${danger ? ' jl-danger' : ''}` }, label);
                if (danger) button.disabled = queue.current()?.projectId === state.project.id;
                button.addEventListener('click', () => {
                    button.disabled = true;
                    action().then(() => { if (!state.project) project.remove(); }).catch(report)
                        .finally(() => { button.disabled = Boolean(danger && queue.current()?.projectId === state.project?.id); });
                });
                project.append(button);
            }
            body.append(project);
        }
        await ui.dialog({ title: '设置', body, buttons: [{ label: '完成', value: 'close', primary: true }] });
    }

    async function deleteChunks(ids) {
        if (!state.run) throw new Error('请先选择任务');
        const runId = state.run.id;
        if (queue.current()?.runId === runId) throw new Error('请先暂停该任务再删除分块');
        const selected = [...new Set(ids || state.selectedIds)];
        if (!selected.length) throw new Error('请先选择要删除的分块');
        const body = el('p', {}, `删除选中的 ${selected.length} 个分块及其结果？`);
        const choice = await ui.dialog({ title: '删除分块', body, buttons: [{ label: '取消', value: 'cancel' }, { label: '删除', value: 'delete', danger: true }] });
        if (choice !== 'delete') return;
        if (queue.current()?.runId === runId) throw new Error('请先暂停该任务再删除分块');
        await repo.deleteChunks(runId, selected);
        drawer?.close?.(); state.selectedIds = []; state.page = 0;
        await refresh(); toast(`已删除 ${selected.length} 个分块`);
    }

    async function taskActions() {
        if (!state.run) throw new Error('请先新建任务');
        const run = await repo.getRun(state.run.id);
        const selected = state.selectedIds.filter(id => run.chunks.some(chunk => chunk.id === id));
        const active = queue.current();
        const body = el('p', { class: 'jl-muted' }, selected.length ? `已选 ${selected.length} 块` : `共 ${run.chunks.length} 块`);
        const choice = await ui.dialog({ title: '任务操作', body, layout: 'menu', buttons: [
            { label: `执行选中 · ${selected.length}`, value: 'selected', primary: true, disabled: !selected.length || Boolean(active) },
            { label: '继续剩余', value: 'remaining', disabled: Boolean(active) || !run.chunks.some(chunk => ['pending', 'paused'].includes(chunk.status)) },
            { label: '暂停', value: 'pause', disabled: active?.runId !== run.id },
            { label: '仅重试失败', value: 'failed', disabled: Boolean(active) || !run.chunks.some(chunk => ['failed', 'partial'].includes(chunk.status)) },
            { label: '合并导出', value: 'export', disabled: !run.chunks.some(chunk => ['done', 'partial'].includes(chunk.status)) },
            { label: `删除选中 · ${selected.length}`, value: 'delete', danger: true, disabled: !selected.length || active?.runId === run.id },
            { label: '取消', value: 'cancel' },
        ] });
        if (choice === 'selected') return launch({ ids: selected });
        if (choice === 'remaining') return launch();
        if (choice === 'pause') { await queue.pause(); return refresh(); }
        if (choice === 'failed') return launch({ ids: run.chunks.filter(chunk => ['failed', 'partial'].includes(chunk.status)).map(chunk => chunk.id) });
        if (choice === 'export') return mergeExport();
        if (choice === 'delete') return deleteChunks(selected);
    }

    function filteredChunks() {
        return (state.run?.chunks || []).filter(chunk => {
            if (state.filter === 'all') return true;
            if (state.filter === 'failed') return ['failed', 'partial'].includes(chunk.status);
            if (state.filter === 'pending') return ['pending', 'paused'].includes(chunk.status);
            return chunk.status === state.filter;
        });
    }

    async function handle(type, data = {}) {
        if (destroyed) return;
        const exclusive = new Set(['newProject', 'importBackup', 'openProject', 'source', 'renameProject', 'deleteProject', 'exportBackup', 'newRun', 'selectRun', 'openChunk', 'saveChunk', 'mergeExport', 'settings', 'apiSettings', 'taskActions', 'deleteChunks']);
        const lock = exclusive.has(type);
        if (lock && state.busy) return;
        if (lock) { state.busy = true; draw(); }
        try {
            if (type === 'newProject') return await newProject();
            if (type === 'importBackup') return await importBackup();
            if (type === 'settings') return await settings();
            if (type === 'apiSettings') return await apiSettings();
            if (type === 'taskActions') return await taskActions();
            if (type === 'deleteChunks') return await deleteChunks(data.ids);
            if (type === 'openProject') return await openProject(data.id);
            if (type === 'backProjects') { drawer?.close?.(); state.project = null; state.run = null; sourceCache = null; state.selectedIds = []; return await refresh(); }
            if (type === 'source') return await source();
            if (type === 'renameProject') return await renameProject();
            if (type === 'deleteProject') return await deleteProject();
            if (type === 'exportBackup') return await exportBackup();
            if (type === 'newRun') return await newRun();
            if (type === 'selectRun') {
                drawer?.close?.(); state.run = await repo.getRun(data.id); state.selectedIds = []; state.page = 0; sourceCache = null; return draw();
            }
            if (['openPreset', 'openApi', 'openWorldInfo'].includes(type)) { ui.close(); return await host[type]?.(); }
            if (type === 'run') return await launch(state.selectedIds.length ? { ids: [...state.selectedIds] } : {});
            if (type === 'pause') { await queue.pause(); return await refresh(); }
            if (type === 'retryFailed') {
                const selected = new Set(state.selectedIds);
                const ids = (state.run?.chunks || []).filter(chunk => ['failed', 'partial'].includes(chunk.status) && (!selected.size || selected.has(chunk.id))).map(chunk => chunk.id);
                if (!ids.length) throw new Error('没有可重试的失败块');
                return await launch({ ids });
            }
            if (type === 'retryChunk') { drawer?.close?.(); return await launch({ ids: [data.id] }); }
            if (type === 'rerunChunk') return await rerunChunk(data.id);
            if (type === 'mergeExport') return await mergeExport();
            if (type === 'openChunk') return await openChunk(data.id);
            if (type === 'saveChunk') return await saveChunk(data.id, data.output);
            if (type === 'exportChunk') {
                const chunk = await repo.getChunk(state.run.id, data.id);
                saveFile(safeFileName(chunk.label || `第${chunk.index + 1}块`, '.txt'), data.output ?? chunk.output ?? ''); return;
            }
            if (type === 'toggleChunk') {
                const selected = new Set(state.selectedIds);
                data.checked ? selected.add(data.id) : selected.delete(data.id);
                state.selectedIds = [...selected]; return draw();
            }
            if (type === 'selectFiltered') { state.selectedIds = filteredChunks().map(chunk => chunk.id); return draw(); }
            if (type === 'deselectAll') { state.selectedIds = []; return draw(); }
            if (type === 'filter') { state.filter = data.value; state.page = 0; return draw(); }
            if (type === 'page') { state.page = Math.max(0, Number(data.value) || 0); return draw(); }
            if (type === 'refresh') {
                if (state.project && !queue.current()) await queue.recover(state.project.id);
                await refresh(); return await refreshHost();
            }
        } catch (error) { report(error); throw error; }
        finally { if (lock) { state.busy = false; draw(); } }
    }

    function destroy() {
        destroyed = true; refreshVersion++;
        for (const dispose of disposers) dispose?.();
        ui.destroy(); sourceCache = null;
    }

    return { init, open, handle, refresh, state, destroy };
}
