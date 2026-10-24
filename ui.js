const STATUS = Object.freeze({ pending: '待处理', running: '处理中', done: '完成', failed: '失败', paused: '已暂停', partial: '未完整' });
const FILTERS = [['all', '全部'], ['failed', '失败'], ['done', '完成'], ['pending', '待处理']];

function node(tag, className = '', text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined && text !== null) element.textContent = String(text);
    return element;
}

function button(text, callback, className = '', ariaLabel) {
    const element = node('button', `jl-button ${className}`.trim(), text);
    element.type = 'button';
    if (ariaLabel) element.setAttribute('aria-label', ariaLabel);
    element.addEventListener('click', callback);
    return element;
}

function iconButton(text, label, callback) {
    const element = button(text, callback, 'jl-icon-button', label);
    element.title = label;
    return element;
}

function formatNumber(value) {
    return new Intl.NumberFormat('zh-CN').format(Number(value) || 0);
}

function formatDate(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}

function filteredChunks(chunks, filter) {
    if (filter === 'all' || !filter) return chunks;
    if (filter === 'failed') return chunks.filter(chunk => ['failed', 'partial'].includes(chunk.status));
    if (filter === 'pending') return chunks.filter(chunk => ['pending', 'paused'].includes(chunk.status));
    return chunks.filter(chunk => chunk.status === filter);
}

function safeJSON(value) {
    try { return JSON.stringify(value, null, 2); } catch { return String(value ?? ''); }
}

function promptText(snapshot) {
    if (!snapshot) return '';
    const parts = [];
    if (snapshot.actualProfile || snapshot.profile) parts.push(safeJSON(snapshot.actualProfile || snapshot.profile));
    if (snapshot.requestStage) parts.push(`记录阶段：${snapshot.requestStage}`);
    if (snapshot.requestNote) parts.push(String(snapshot.requestNote));
    if (snapshot.warnings?.length) parts.push(snapshot.warnings.map(String).join('\n'));
    const messages = Array.isArray(snapshot.requestMessages) ? snapshot.requestMessages : snapshot.messages;
    if (Array.isArray(messages)) {
        for (const message of messages) {
            parts.push(`[${message.role || 'user'}]\n${typeof message.content === 'string' ? message.content : safeJSON(message.content)}`);
        }
    } else parts.push(safeJSON(snapshot));
    return parts.join('\n\n');
}

export async function copyText(text) {
    if (navigator.clipboard?.writeText) {
        try { await navigator.clipboard.writeText(text); return; } catch { /* Fall through for HTTP installations. */ }
    }
    const field = node('textarea', 'jl-copy-field');
    field.value = text;
    field.setAttribute('aria-label', '复制内容');
    (document.querySelector('#jianlu-root') || document.body).append(field);
    field.select();
    const copied = document.execCommand('copy');
    field.remove();
    if (!copied) throw new Error('复制失败，请选中文本复制');
}

function logo() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 28 28');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('aria-hidden', 'true');
    svg.classList.add('jl-logo');
    const lines = [
        ['path', { d: 'M7 4.5h10l5 5v14H7z', fill: 'currentColor', opacity: '.13' }],
        ['path', { d: 'M7 4.5h10l5 5v14H7zM17 4.5v5h5M4 8v17h14M10 13h9M10 17h9', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }],
    ];
    for (const [tag, attributes] of lines) {
        const child = document.createElementNS('http://www.w3.org/2000/svg', tag);
        for (const [key, value] of Object.entries(attributes)) child.setAttribute(key, value);
        svg.append(child);
    }
    return svg;
}

/** A self-contained view. All persistence and host actions are supplied by the controller. */
export function createUI({ onAction = () => {} } = {}) {
    let root;
    let frame;
    let content;
    let overlay;
    let toast;
    let state = {};
    let visible = false;
    let returnFocus = null;
    let toastTimer;
    let chunkView = null;
    const dialogs = [];

    function announce(message) {
        if (!root) return;
        toast.textContent = String(message || '操作失败');
        toast.hidden = false;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { if (toast) toast.hidden = true; }, 5000);
    }

    async function act(type, payload = {}) {
        try {
            const value = await onAction(type, payload);
            return { ok: true, value };
        } catch (error) {
            announce(error?.message || error);
            return { ok: false, error };
        }
    }

    function mount() {
        if (root) return root;
        root = node('div');
        root.id = 'jianlu-root';
        root.hidden = true;
        root.dataset.theme = 'host';
        const backdrop = node('div', 'jl-backdrop');
        backdrop.addEventListener('click', close);
        frame = node('section', 'jl-frame');
        frame.setAttribute('role', 'dialog');
        frame.setAttribute('aria-modal', 'true');
        frame.setAttribute('aria-label', '笺录小说工作台');
        frame.tabIndex = -1;
        content = node('div', 'jl-content');
        frame.append(content);
        overlay = node('div', 'jl-overlays');
        toast = node('div', 'jl-toast');
        toast.setAttribute('role', 'status');
        toast.setAttribute('aria-live', 'polite');
        toast.hidden = true;
        root.append(backdrop, frame, overlay, toast);
        document.body.append(root);
        document.addEventListener('keydown', handleKeydown, true);
        return root;
    }

    function topSurface() {
        return dialogs.at(-1)?.surface || chunkView?.surface || frame;
    }

    function focusSurface(surface) {
        queueMicrotask(() => {
            if (!visible || !surface?.isConnected) return;
            const preferred = surface.querySelector('[autofocus]') || surface.querySelector('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]');
            (preferred || surface).focus();
        });
    }

    function handleKeydown(event) {
        if (!visible) return;
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopImmediatePropagation();
            if (dialogs.length) dialogs.at(-1).finish(null);
            else if (chunkView) chunkView.close();
            else close();
            return;
        }
        if (event.key !== 'Tab') return;
        const surface = topSurface();
        const elements = [...surface.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]')]
            .filter(element => !element.hidden && !element.closest('[hidden]') && element.getClientRects().length);
        if (!elements.length) {
            event.preventDefault();
            surface.focus();
            return;
        }
        const first = elements[0];
        const last = elements.at(-1);
        if (!surface.contains(document.activeElement) || (!event.shiftKey && document.activeElement === last)) {
            event.preventDefault();
            first.focus();
        } else if (event.shiftKey && (document.activeElement === first || document.activeElement === surface)) {
            event.preventDefault();
            last.focus();
        }
    }

    function open() {
        mount();
        if (visible) return;
        returnFocus = document.activeElement;
        visible = true;
        root.hidden = false;
        render(state);
        focusSurface(topSurface());
    }

    function close() {
        if (!root || !visible) return;
        for (const entry of [...dialogs].reverse()) entry.finish(null);
        chunkView?.close(false);
        visible = false;
        root.hidden = true;
        if (returnFocus?.isConnected) returnFocus.focus();
    }

    function render(nextState = {}) {
        state = nextState;
        if (!root || !visible) return;
        const scroller = content.querySelector('.jl-scroll');
        const scrollTop = scroller?.scrollTop || 0;
        const previousProject = content.dataset.project || '';
        const activeElement = document.activeElement;
        const focusKey = content.contains(activeElement) ? activeElement.dataset.focusKey : null;
        root.dataset.theme = ['light', 'dark'].includes(state.settings?.theme) ? state.settings.theme : 'host';
        root.style.setProperty('--jl-font-size', `${Math.max(12, Math.min(16, Number(state.settings?.fontSize) || 13))}px`);
        content.replaceChildren();
        content.dataset.project = state.project?.id || '';
        const header = node('header', 'jl-header');
        const brand = node('div', 'jl-brand');
        brand.append(logo(), node('span', '', '笺录'));
        header.append(brand);
        if (state.project) {
            const title = node('h1', 'jl-header-title', state.project.title || '未命名项目');
            title.title = state.project.title || '';
            header.append(title);
        } else header.append(node('span', 'jl-header-space'));
        const refresh = iconButton('↻', '刷新项目和当前配置', () => { void act('refresh'); });
        refresh.disabled = Boolean(state.busy);
        header.append(refresh, iconButton('⚙', '设置', () => { void act('settings'); }), iconButton('×', '关闭工作台', close));
        content.append(header);
        if (state.notice) {
            const notice = node('div', 'jl-notice', state.notice);
            notice.setAttribute('role', 'status');
            content.append(notice);
        }
        if (state.project) renderProject();
        else renderProjects();
        if (previousProject === (state.project?.id || '')) {
            const nextScroller = content.querySelector('.jl-scroll');
            if (nextScroller) nextScroller.scrollTop = scrollTop;
        }
        if (focusKey && !chunkView && !dialogs.length) {
            const match = [...content.querySelectorAll('[data-focus-key]')].find(element => element.dataset.focusKey === focusKey);
            match?.focus();
        }
    }

    function renderProjects() {
        const toolbar = node('div', 'jl-toolbar jl-project-toolbar');
        const title = node('h2', 'jl-section-title', '小说项目');
        toolbar.append(title, node('span', 'jl-grow'));
        const importButton = button('导入备份', () => { void act('importBackup'); });
        importButton.disabled = Boolean(state.busy);
        const create = button('＋ 新建项目', () => { void act('newProject'); }, 'jl-primary');
        create.disabled = Boolean(state.busy);
        toolbar.append(importButton, create);
        content.append(toolbar);
        const list = node('div', 'jl-scroll jl-project-grid');
        const projects = Array.isArray(state.projects) ? state.projects : [];
        for (const project of projects) {
            const card = button('', () => { void act('openProject', { id: project.id }); }, 'jl-project-card');
            card.dataset.focusKey = `project-${project.id}`;
            card.append(node('span', 'jl-project-symbol', '文'), node('strong', 'jl-project-name', project.title || '未命名项目'));
            const file = node('span', 'jl-project-source', project.sourceName || '未导入原文');
            file.title = project.sourceName || '';
            card.append(file);
            const meta = node('span', 'jl-project-meta');
            meta.append(node('span', '', `${formatNumber(project.length)} 字`), node('span', '', formatDate(project.updatedAt)));
            card.append(meta);
            list.append(card);
        }
        if (!projects.length) {
            const empty = node('div', 'jl-empty');
            empty.append(node('span', 'jl-empty-mark', '文'), node('span', '', '暂无项目'), button('新建项目', () => { void act('newProject'); }, 'jl-primary'));
            list.append(empty);
        }
        content.append(list);
    }

    function renderProject() {
        const nav = node('div', 'jl-toolbar jl-project-nav');
        nav.append(button('‹ 项目', () => { void act('backProjects'); }, 'jl-quiet'));
        const source = button(state.project.sourceName || '原文', () => { void act('source'); }, 'jl-source-button');
        source.title = state.project.sourceName || '查看原文';
        nav.append(source, node('span', 'jl-muted jl-word-count', `${formatNumber(state.project.length)} 字`), node('span', 'jl-grow'));
        const more = node('details', 'jl-more');
        const summary = node('summary', 'jl-button jl-icon-button', '···');
        summary.setAttribute('aria-label', '项目操作');
        const menu = node('div', 'jl-more-menu');
        for (const [label, type, danger] of [['重命名', 'renameProject'], ['导出项目备份', 'exportBackup'], ['删除项目', 'deleteProject', true]]) {
            menu.append(button(label, () => { more.open = false; void act(type); }, danger ? 'jl-danger' : ''));
        }
        more.append(summary, menu);
        nav.append(more);
        content.append(nav);

        const host = state.hostInfo || {};
        const connections = node('div', 'jl-toolbar jl-connections');
        const preset = button('', () => { void act('openPreset'); }, 'jl-connection');
        preset.append(node('span', 'jl-connection-label', '预设'), node('span', 'jl-connection-value', host.presetName || '当前预设'), node('span', 'jl-chevron', '↗'));
        const api = button('', () => { void act('openApi'); }, 'jl-connection');
        api.append(node('span', 'jl-connection-label', '接口'), node('span', 'jl-connection-value', host.model || host.api || '当前接口'), node('span', 'jl-chevron', '↗'));
        connections.append(preset, api, button('世界书 ↗', () => { void act('openWorldInfo'); }, 'jl-quiet jl-world-info'));
        content.append(connections);

        const runBar = node('div', 'jl-toolbar jl-run-toolbar');
        const runs = Array.isArray(state.runs) ? state.runs : [];
        const select = node('select', 'jl-run-select');
        select.setAttribute('aria-label', '处理任务');
        select.dataset.focusKey = 'run-select';
        if (!runs.length) {
            const option = node('option', '', '暂无任务');
            option.value = '';
            select.append(option);
        }
        for (const run of runs) {
            const option = node('option', '', run.title || formatDate(run.createdAt) || '未命名任务');
            option.value = run.id;
            option.selected = run.id === state.run?.id;
            select.append(option);
        }
        select.disabled = !runs.length || Boolean(state.busy);
        select.addEventListener('change', () => { void act('selectRun', { id: select.value }); });
        const newRun = button('＋ 新建任务', () => { void act('newRun'); }, 'jl-primary');
        newRun.disabled = Boolean(state.busy) || !state.project.length;
        runBar.append(select, node('span', 'jl-grow'), newRun);
        content.append(runBar);
        if (!state.run) {
            const empty = node('div', 'jl-scroll jl-empty');
            empty.append(node('span', 'jl-empty-mark', '≡'), node('span', '', '暂无处理记录'));
            content.append(empty);
            return;
        }

        const chunks = Array.isArray(state.run.chunks) ? state.run.chunks : [];
        const doneCount = chunks.filter(chunk => chunk.status === 'done').length;
        const partialCount = chunks.filter(chunk => chunk.status === 'partial').length;
        const failedCount = chunks.filter(chunk => chunk.status === 'failed').length;
        const progressRow = node('div', 'jl-progress-row');
        const progress = node('progress', 'jl-progress');
        progress.max = Math.max(1, chunks.length);
        progress.value = doneCount;
        progress.setAttribute('aria-label', '处理进度');
        progressRow.append(progress, node('span', 'jl-muted', `${doneCount} / ${chunks.length}`));
        if (failedCount) progressRow.append(node('span', 'jl-status jl-status-failed', `${failedCount} 失败`));
        if (partialCount) progressRow.append(node('span', 'jl-status jl-status-partial', `${partialCount} 未完整`));
        content.append(progressRow);

        const filters = node('div', 'jl-toolbar jl-filter-toolbar');
        const tabs = node('div', 'jl-filter-tabs');
        tabs.setAttribute('role', 'group');
        tabs.setAttribute('aria-label', '筛选文本块');
        for (const [value, label] of FILTERS) {
            const tab = button(label, () => { void act('filter', { value }); }, (state.filter || 'all') === value ? 'jl-filter-active' : 'jl-quiet');
            tab.setAttribute('aria-pressed', String((state.filter || 'all') === value));
            tab.dataset.focusKey = `filter-${value}`;
            tabs.append(tab);
        }
        filters.append(tabs, node('span', 'jl-grow'));
        filters.append(button('全选', () => { void act('selectFiltered'); }, 'jl-quiet'), button('清空', () => { void act('deselectAll'); }, 'jl-quiet'));
        const selected = new Set(Array.isArray(state.selectedIds) ? state.selectedIds : state.selectedIds ? [...state.selectedIds] : []);
        if (selected.size) filters.append(node('span', 'jl-selected-count', `${selected.size} 已选`));
        content.append(filters);

        const filtered = filteredChunks(chunks, state.filter);
        const pageSize = Math.max(1, Number(state.pageSize) || 30);
        const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
        const page = Math.max(0, Math.min(pageCount - 1, Number(state.page) || 0));
        const list = node('div', 'jl-scroll jl-chunk-list');
        list.setAttribute('role', 'list');
        for (const chunk of filtered.slice(page * pageSize, (page + 1) * pageSize)) {
            const row = node('div', 'jl-chunk-row');
            row.setAttribute('role', 'listitem');
            row.dataset.status = chunk.status || 'pending';
            const label = node('label', 'jl-check-label');
            const checkbox = node('input');
            checkbox.type = 'checkbox';
            checkbox.checked = selected.has(chunk.id);
            checkbox.setAttribute('aria-label', `选择第 ${Number(chunk.index) + 1} 块`);
            checkbox.dataset.focusKey = `check-${chunk.id}`;
            checkbox.addEventListener('change', () => { void act('toggleChunk', { id: chunk.id, checked: checkbox.checked }); });
            label.append(checkbox);
            const openChunk = button('', () => { void act('openChunk', { id: chunk.id }); }, 'jl-chunk-open');
            openChunk.dataset.focusKey = `chunk-${chunk.id}`;
            const main = node('span', 'jl-chunk-main');
            main.append(node('span', 'jl-chunk-number', String(Number(chunk.index) + 1).padStart(2, '0')), node('span', 'jl-chunk-label', chunk.label || `文本块 ${Number(chunk.index) + 1}`));
            const meta = node('span', 'jl-chunk-meta');
            meta.append(node('span', '', `${formatNumber(Number(chunk.start) + 1)}–${formatNumber(chunk.end)} 字`));
            if (chunk.outputLength) meta.append(node('span', '', `${formatNumber(chunk.outputLength)} 字输出`));
            if (chunk.error) {
                const error = node('span', 'jl-chunk-error', chunk.error);
                error.title = chunk.error;
                meta.append(error);
            }
            openChunk.append(main, meta);
            const badge = node('span', `jl-status jl-status-${chunk.status || 'pending'}`, STATUS[chunk.status] || chunk.status || '待处理');
            row.append(label, openChunk, badge);
            if (['failed', 'paused', 'partial'].includes(chunk.status)) {
                const retry = iconButton('↻', '重试此块', () => { void act('retryChunk', { id: chunk.id }); });
                retry.disabled = Boolean(state.active) || Boolean(state.busy);
                row.append(retry);
            } else row.append(node('span', 'jl-row-spacer'));
            list.append(row);
        }
        if (!filtered.length) list.append(node('div', 'jl-empty', '没有符合条件的文本块'));
        content.append(list);
        if (pageCount > 1) {
            const pagination = node('div', 'jl-pagination');
            const previous = button('‹', () => { void act('page', { value: page - 1 }); }, 'jl-icon-button', '上一页');
            previous.disabled = page === 0;
            const next = button('›', () => { void act('page', { value: page + 1 }); }, 'jl-icon-button', '下一页');
            next.disabled = page === pageCount - 1;
            pagination.append(previous, node('span', 'jl-muted', `${page + 1} / ${pageCount}`), next);
            content.append(pagination);
        }
        const footer = node('footer', 'jl-footer');
        const activeHere = state.active?.runId === state.run.id;
        const canRun = chunks.some(chunk => ['pending', 'paused'].includes(chunk.status));
        const run = button(selected.size ? `运行所选 · ${selected.size}` : '继续剩余', () => { void act('run', selected.size ? { ids: [...selected] } : {}); }, 'jl-primary');
        run.disabled = Boolean(state.active) || Boolean(state.busy) || (!selected.size && !canRun);
        const pause = button('暂停', () => { void act('pause'); });
        pause.disabled = !activeHere;
        const retry = button('仅重试失败', () => { void act('retryFailed'); });
        retry.disabled = Boolean(state.active) || Boolean(state.busy) || failedCount + partialCount === 0;
        const exportButton = button('合并导出', () => { void act('mergeExport'); });
        exportButton.disabled = Boolean(state.busy) || !chunks.some(chunk => ['done', 'partial'].includes(chunk.status));
        footer.append(run, pause, retry, node('span', 'jl-grow'), exportButton);
        content.append(footer);
    }

    function dialog({ title = '', body, buttons = [{ label: '完成', value: true, primary: true }] } = {}) {
        mount();
        if (!visible) open();
        const layer = node('div', 'jl-modal-layer');
        const surface = node('section', 'jl-dialog');
        surface.setAttribute('role', 'dialog');
        surface.setAttribute('aria-modal', 'true');
        surface.setAttribute('aria-label', title || '操作');
        surface.tabIndex = -1;
        const header = node('header', 'jl-sheet-header');
        header.append(node('h2', '', title));
        const previousFocus = document.activeElement;
        let finish;
        const promise = new Promise(resolve => {
            finish = value => {
                const index = dialogs.findIndex(entry => entry.surface === surface);
                if (index < 0) return;
                dialogs.splice(index, 1);
                layer.remove();
                if (visible) {
                    if (previousFocus?.isConnected) previousFocus.focus();
                    else focusSurface(topSurface());
                }
                resolve(value);
            };
        });
        header.append(iconButton('×', '关闭对话框', () => finish(null)));
        const bodyContainer = node('div', 'jl-dialog-body');
        if (body?.nodeType) bodyContainer.append(body);
        else if (body !== undefined) bodyContainer.textContent = String(body);
        const footer = node('footer', 'jl-dialog-footer');
        for (const specification of buttons) {
            footer.append(button(specification.label, () => finish(specification.value), specification.primary ? 'jl-primary' : specification.danger ? 'jl-danger' : ''));
        }
        surface.append(header, bodyContainer, footer);
        layer.append(surface);
        layer.addEventListener('click', event => { if (event.target === layer) finish(null); });
        overlay.append(layer);
        dialogs.push({ surface, finish });
        focusSurface(surface);
        return promise;
    }

    function showChunk({ chunk, sourceText = '' }) {
        mount();
        if (!visible) open();
        chunkView?.close(false);
        let currentChunk = { ...chunk };
        let dirty = false;
        const previousFocus = document.activeElement;
        const layer = node('div', 'jl-sheet-layer');
        const surface = node('section', 'jl-sheet');
        surface.setAttribute('role', 'dialog');
        surface.setAttribute('aria-modal', 'true');
        surface.setAttribute('aria-label', chunk.label || '文本块详情');
        surface.tabIndex = -1;
        const header = node('header', 'jl-sheet-header');
        const heading = node('div', 'jl-sheet-heading');
        heading.append(node('h2', '', `${String(Number(chunk.index) + 1).padStart(2, '0')} · ${chunk.label || '文本块'}`), node('span', 'jl-muted', `${formatNumber(Number(chunk.start) + 1)}–${formatNumber(chunk.end)} 字`));
        const view = {
            surface,
            close(restoreFocus = true) {
                if (chunkView !== view) return;
                layer.remove();
                chunkView = null;
                if (restoreFocus && visible) {
                    if (previousFocus?.isConnected) previousFocus.focus();
                    else focusSurface(frame);
                }
            },
            update(nextChunk) {
                const value = nextChunk.chunk || nextChunk;
                currentChunk = { ...currentChunk, ...value };
                if (!dirty) output.value = currentChunk.output || '';
                if (nextChunk.sourceText !== undefined) source.value = nextChunk.sourceText;
                request.value = promptText(currentChunk.snapshot);
                tabButtons.prompt.textContent = currentChunk.snapshot?.previewOnly ? '当前预览' : '实际请求';
                error.value = currentChunk.error || currentChunk.previewError || '';
                previous.value = currentChunk.previousOutput || '';
                tabButtons.error.hidden = !error.value;
                tabButtons.previous.hidden = !previous.value;
                retry.disabled = currentChunk.status === 'done' || Boolean(state.active);
            },
        };
        header.append(heading, iconButton('×', '关闭文本块详情', () => view.close()));
        const tabs = node('div', 'jl-sheet-tabs');
        tabs.setAttribute('role', 'tablist');
        tabs.setAttribute('aria-label', '文本块内容');
        const body = node('div', 'jl-sheet-body');
        const panes = {};
        const tabButtons = {};
        let activeTab = 'output';

        function textPane(id, label, value, editable = false) {
            const pane = node('div', 'jl-pane');
            pane.setAttribute('role', 'tabpanel');
            pane.id = `jl-chunk-${id}`;
            const field = node('textarea', 'jl-textarea jl-chunk-textarea');
            field.value = value || '';
            field.readOnly = !editable;
            field.spellcheck = false;
            field.setAttribute('aria-label', label);
            pane.append(field);
            pane.hidden = id !== activeTab;
            panes[id] = { pane, field };
            const tab = button(label, () => switchTab(id), id === activeTab ? 'jl-tab-active' : 'jl-quiet');
            tab.setAttribute('role', 'tab');
            tab.setAttribute('aria-controls', pane.id);
            tab.setAttribute('aria-selected', String(id === activeTab));
            tabButtons[id] = tab;
            tabs.append(tab);
            body.append(pane);
            return field;
        }

        function switchTab(id) {
            activeTab = id;
            for (const [key, pane] of Object.entries(panes)) {
                pane.pane.hidden = key !== id;
                tabButtons[key].classList.toggle('jl-tab-active', key === id);
                tabButtons[key].classList.toggle('jl-quiet', key !== id);
                tabButtons[key].setAttribute('aria-selected', String(key === id));
            }
            save.hidden = id !== 'output';
            copy.textContent = id === 'output' ? '复制输出' : '复制';
        }

        const output = textPane('output', '输出', chunk.output || '', true);
        const source = textPane('source', '原文', sourceText);
        const request = textPane('prompt', chunk.snapshot?.previewOnly ? '当前预览' : '实际请求', promptText(chunk.snapshot));
        const error = textPane('error', '错误', chunk.error || chunk.previewError || '');
        const previous = textPane('previous', '上次输出', chunk.previousOutput || '');
        if (!chunk.error && !chunk.previewError) tabButtons.error.hidden = true;
        if (!chunk.previousOutput) tabButtons.previous.hidden = true;
        output.addEventListener('input', () => { dirty = output.value !== (currentChunk.output || ''); });
        const footer = node('footer', 'jl-sheet-footer');
        const copy = button('复制输出', async () => {
            try { await copyText(panes[activeTab].field.value); announce('已复制'); } catch (error) { announce(error.message); }
        });
        const exportButton = button('导出', () => { void act('exportChunk', { id: currentChunk.id, output: output.value }); });
        const save = button('保存为完成', async () => {
            save.disabled = true;
            const result = await act('saveChunk', { id: currentChunk.id, output: output.value });
            save.disabled = false;
            if (result.ok) {
                currentChunk.output = output.value;
                currentChunk.status = 'done';
                dirty = false;
                announce('已保存');
            }
        }, 'jl-primary');
        const retry = button('重试', () => { void act('retryChunk', { id: currentChunk.id }); });
        retry.disabled = chunk.status === 'done' || Boolean(state.active);
        const rerun = button('按当前预设重跑', () => { void act('rerunChunk', { id: currentChunk.id }); }, 'jl-quiet');
        rerun.disabled = Boolean(state.active);
        footer.append(copy, exportButton, retry, rerun, node('span', 'jl-grow'), save);
        surface.append(header, tabs, body, footer);
        layer.append(surface);
        layer.addEventListener('click', event => { if (event.target === layer) view.close(); });
        overlay.append(layer);
        chunkView = view;
        focusSurface(surface);
        return view;
    }

    function destroy() {
        close();
        document.removeEventListener('keydown', handleKeydown, true);
        clearTimeout(toastTimer);
        root?.remove();
        root = frame = content = overlay = toast = null;
    }

    return { mount, open, close, render, dialog, showChunk, destroy };
}
