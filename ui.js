export const THEMES = [['host','跟随酒馆'],['light','纸白'],['dark','墨色'],['cream','暖笺'],['sage','青苔'],['mist','雾灰'],['rose','浅蔷薇'],['ocean','海盐'],['plum','暮紫'],['sepia','旧纸']];
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

function activeElement() {
    let element = document.activeElement;
    while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
    return element;
}

export async function copyText(text) {
    if (navigator.clipboard?.writeText) {
        try { await navigator.clipboard.writeText(text); return; } catch { /* Fall through for HTTP installations. */ }
    }
    const field = node('textarea', 'jl-copy-field');
    field.value = text;
    field.setAttribute('aria-label', '复制内容');
    field.style.cssText = 'position:fixed;opacity:0;left:-10000px;top:0;pointer-events:none;';
    const previousFocus = activeElement();
    const shadow = document.getElementById('jianlu-extension-host')?.shadowRoot;
    (shadow?.getElementById('jianlu-root') || document.body).append(field);
    let copied;
    try {
        field.focus({ preventScroll: true });
        field.select();
        copied = document.execCommand('copy');
    } finally {
        field.remove();
        if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    }
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

function navigationIcon(kind) {
    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
    svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('fill','none');svg.setAttribute('aria-hidden','true');svg.classList.add('jl-nav-symbol');
    const path=document.createElementNS('http://www.w3.org/2000/svg','path');
    path.setAttribute('d',({projects:'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',tasks:'M8 5h13M8 12h13M8 19h13M3 5h.01M3 12h.01M3 19h.01',library:'M4 4h13v16H4zM8 8h6M8 12h6M20 7v14H7',prompts:'M5 4h14v16H5zM9 8h6M9 12h6M9 16h3'})[kind]);
    for(const[key,value]of Object.entries({stroke:'currentColor','stroke-width':'1.5','stroke-linecap':'round','stroke-linejoin':'round'}))path.setAttribute(key,value);
    svg.append(path);return svg;
}

/** A self-contained view. All persistence and host actions are supplied by the controller. */
export function createUI({ onAction = () => {} } = {}) {
    let host;
    let shadow;
    let root;
    let frame;
    let content;
    let chrome;
    let navigation;
    let pageHost;
    let pageEntry = null;
    let pageWork = null;
    let currentPage = 'tasks';
    let mobilePanel = 'chunks';
    let overlay;
    let toast;
    let state = {};
    let visible = false;
    let returnFocus = null;
    let toastTimer;
    let chunkView = null;
    let lastLive = null;
    const dialogs = [];
    const shieldedEvents = ['click', 'dblclick', 'contextmenu', 'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'touchstart', 'touchmove', 'touchend', 'wheel', 'keydown', 'keyup', 'input', 'change'];

    function stopHostEvent(event) { event.stopPropagation(); }

    function syncViewport() {
        if (!host) return;
        const viewport = window.visualViewport;
        const height = Math.max(1, Math.round(viewport?.height || window.innerHeight));
        host.style.setProperty('height', `${height}px`, 'important');
        host.style.setProperty('top', `${Math.max(0, Math.round(viewport?.offsetTop || 0))}px`, 'important');
        root?.style.setProperty('--jl-viewport-height', `${height}px`);
    }

    function setVisible(value) {
        host.hidden = !value;
        host.style.setProperty('display', value ? 'block' : 'none', 'important');
        root.hidden = !value;
    }

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
        host = node('div');
        host.id = 'jianlu-extension-host';
        host.hidden = true;
        for (const [property, value] of Object.entries({
            all: 'initial', position: 'fixed', inset: '0', bottom: 'auto', 'z-index': '2147483000',
            display: 'none', overflow: 'hidden', isolation: 'isolate', 'pointer-events': 'auto',
            'touch-action': 'auto', margin: '0', padding: '0', border: '0', 'box-sizing': 'border-box',
        })) host.style.setProperty(property, value, 'important');
        shadow = host.attachShadow({ mode: 'open' });
        const criticalStyle = node('style');
        criticalStyle.textContent = ':host{display:block}#jianlu-root{position:absolute;inset:0;overflow:hidden}#jianlu-root[hidden],#jianlu-root [hidden]{display:none!important}';
        const stylesheet = node('link');
        stylesheet.rel = 'stylesheet';
        const stylesheetUrl = new URL('./style.css', import.meta.url);
        stylesheetUrl.search = new URL(import.meta.url).search;
        stylesheet.href = stylesheetUrl.href;
        shadow.append(criticalStyle, stylesheet);
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
        chrome = node('div', 'jl-chrome');
        navigation = node('nav', 'jl-navigation');
        navigation.setAttribute('aria-label','工作台导航');
        content = node('main', 'jl-content');
        pageHost = node('main', 'jl-page-host');
        pageHost.hidden = true;
        frame.append(chrome,navigation,content,pageHost);
        overlay = node('div', 'jl-overlays');
        toast = node('div', 'jl-toast');
        toast.setAttribute('role', 'status');
        toast.setAttribute('aria-live', 'polite');
        toast.hidden = true;
        root.append(backdrop, frame, overlay, toast);
        shadow.append(root);
        document.body.append(host);
        shadow.addEventListener('keydown', handleKeydown, true);
        for (const type of shieldedEvents) shadow.addEventListener(type, stopHostEvent);
        window.addEventListener('resize', syncViewport);
        window.visualViewport?.addEventListener('resize', syncViewport);
        window.visualViewport?.addEventListener('scroll', syncViewport);
        syncViewport();
        return root;
    }

    function topSurface() {
        const modal=[...dialogs].reverse().find(entry=>entry!==pageEntry);
        return modal?.surface || (!chunkView?.inline&&chunkView?.surface) || frame;
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
        const focused = activeElement();
        if (!surface.contains(focused) || (!event.shiftKey && focused === last)) {
            event.preventDefault();
            first.focus();
        } else if (event.shiftKey && (focused === first || focused === surface)) {
            event.preventDefault();
            last.focus();
        }
    }

    function open() {
        mount();
        if (visible) return;
        returnFocus = activeElement();
        visible = true;
        setVisible(true);
        syncViewport();
        render(state);
        focusSurface(topSurface());
    }

    function close() {
        if (!root || !visible) return;
        for (const entry of [...dialogs].reverse()) entry.finish(null);
        chunkView?.close(false);
        visible = false;
        setVisible(false);
        if (returnFocus?.isConnected) returnFocus.focus();
    }

    async function navigate(page) {
        const previous = pageWork;
        pageEntry?.finish(null);
        if (previous) await previous;
        if (!visible) return;
        currentPage = page;
        if (page === 'projects') { await act('backProjects'); render(state); return; }
        if (page === 'tasks') { render(state); return; }
        const work = act(page === 'prompts' ? 'libraryPrompts' : 'library');
        pageWork = work;
        await work;
        if (pageWork === work) { pageWork = null; currentPage = 'tasks'; render(state); }
    }

    async function showSettings() {
        const previous=pageWork;
        const back=currentPage;
        pageEntry?.finish(null);
        if(previous)await previous;
        await act('settings');
        if(visible&&state.project&&['library','prompts'].includes(back))void navigate(back);
    }

    async function refreshCurrent() {
        const back=currentPage, previous=pageWork;
        pageEntry?.finish(null);if(previous)await previous;
        await act('refresh');
        if(visible&&state.project&&['library','prompts'].includes(back))void navigate(back);
    }

    function renderNavigation() {
        navigation.replaceChildren();
        const selected = !state.project ? 'projects' : currentPage;
        for (const [id,label,mark] of [['projects','项目','▦'],['tasks','任务','≡'],['library','资料','◇'],['prompts','提示词','⌘']]) {
            const item = button('',()=>{void navigate(id);},`jl-nav-item ${id===selected?'jl-nav-active':''}`,label);
            item.append(navigationIcon(id),node('span','jl-nav-label',label));
            if(id===selected)item.setAttribute('aria-current','page');
            item.disabled = id!=='projects'&&!state.project;
            navigation.append(item);
        }
    }

    function render(nextState = {}) {
        state = nextState;
        if(state.project&&currentPage==='projects')currentPage='tasks';
        if (!root || !visible) return;
        const scroller = content.querySelector('.jl-scroll');
        const scrollTop = scroller?.scrollTop || 0;
        const previousProject = content.dataset.project || '';
        const focused = activeElement();
        const focusKey = content.contains(focused) ? focused.dataset.focusKey : null;
        const inlineView=chunkView?.inline&&chunkView.runId===state.run?.id?chunkView:null;
        root.dataset.theme = THEMES.some(([id])=>id===state.settings?.theme) ? state.settings.theme : 'host';
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
        const refresh = iconButton('↻', '刷新项目和当前配置', () => { void refreshCurrent(); });
        refresh.disabled = Boolean(state.busy)&&!pageEntry;
        header.append(refresh, iconButton('⚙', '设置', () => { void showSettings(); }), iconButton('×', '关闭工作台', close));
        chrome.replaceChildren(header);
        renderNavigation();
        content.hidden = Boolean(pageEntry);
        if (state.notice) {
            const notice = node('div', 'jl-notice', state.notice);
            notice.setAttribute('role', 'status');
            content.append(notice);
        }
        if (state.project) renderProject();
        else renderProjects();
        if(inlineView){content.querySelector('.jl-live')?.replaceChildren(inlineView.layer);if(inlineView.surface.contains(focused))focused.focus({preventScroll:true});}
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
        content.append(nav);

        const runBar = node('div', 'jl-toolbar jl-run-toolbar');
        const runs = Array.isArray(state.runs) ? state.runs : [];
        const picker = node('label', 'jl-run-picker');
        const select = node('select', 'jl-run-select');
        select.setAttribute('aria-label', '当前任务');
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
        const newRun = button('＋', () => { void act('newRun'); }, 'jl-add-button','新建任务');
        newRun.disabled = Boolean(state.busy) || !state.project.length;
        picker.append(select);
        const runActions = node('div', 'jl-run-actions');
        const taskActions = button('任务操作', () => { void act('taskActions'); }, 'jl-primary');
        taskActions.disabled = Boolean(state.busy) || !state.run;
        const chunks=state.run?.chunks||[];
        const numeric=node('span','jl-count',`${chunks.filter(x=>x.status==='done').length} / ${chunks.length}`);
        numeric.setAttribute('aria-label','完成块数');
        runActions.append(newRun,numeric,taskActions);
        runBar.append(picker, runActions);
        content.append(runBar);
        if (!state.run) {
            const empty = node('div', 'jl-scroll jl-empty');
            empty.append(node('span', 'jl-empty-mark', '≡'), node('span', '', '暂无处理记录'));
            content.append(empty);
            return;
        }

        const switcher = node('div','jl-task-panels');
        for(const [id,label] of [['chunks','分块'],['output','输出']]){
            const tab=button(label,()=>{mobilePanel=id;render(state);},mobilePanel===id?'jl-filter-active':'jl-quiet');
            tab.setAttribute('aria-pressed',String(mobilePanel===id));switcher.append(tab);
        }
        content.append(switcher);
        const layout=node('div','jl-job-layout');layout.dataset.mobilePanel=mobilePanel;
        const blocks=node('section','jl-blocks-panel');
        const live=state.active?.runId===state.run.id?state.active:null;
        const recent=lastLive?.runId===state.run.id?lastLive:null;
        const liveBox=node('section','jl-live');
        const liveHead=node('header','jl-preview-heading');
        liveHead.append(node('h2','','输出预览'),node('span','jl-preview-count',`${(live?.output||recent?.text||'').length.toLocaleString()} 字`));
        const copy=button('复制',()=>{copyText(liveText.value).then(()=>announce('已复制')).catch(error=>announce(error.message));},'jl-quiet');
        liveHead.append(copy);
        const liveText=node('textarea','jl-textarea jl-live-text');
        liveText.readOnly=true;liveText.spellcheck=false;liveText.setAttribute('aria-label','流式输出预览');liveText.value=live?.output||recent?.text||'';
        liveBox.append(liveHead,liveText);
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
        filters.append(button('全选', () => { void act('selectFiltered'); }, 'jl-quiet'), button('取消选择', () => { void act('deselectAll'); }, 'jl-quiet'));
        const selected = new Set(Array.isArray(state.selectedIds) ? state.selectedIds : state.selectedIds ? [...state.selectedIds] : []);
        const selectionCount = node('span', 'jl-selected-count', `已选 ${selected.size} 块`);
        selectionCount.setAttribute('role', 'status');
        selectionCount.setAttribute('aria-live', 'polite');
        filters.append(selectionCount);
        const bulkDelete=button('删除所选',()=>{void act('deleteChunks',{ids:[...selected]});},'jl-danger');bulkDelete.disabled=!selected.size||state.active?.runId===state.run.id;filters.append(bulkDelete);
        blocks.append(filters);

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
            row.dataset.selected = String(selected.has(chunk.id));
            row.dataset.open = String(chunkView?.chunkId===chunk.id);
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
            const remove=iconButton('删除',`删除第 ${Number(chunk.index)+1} 块`,()=>{void act('deleteChunks',{ids:[chunk.id]});});remove.classList.add('jl-delete-block');remove.disabled=state.active?.runId===state.run.id;
            row.append(label, openChunk, badge,remove);
            list.append(row);
        }
        if (!filtered.length) list.append(node('div', 'jl-empty', '没有符合条件的文本块'));
        blocks.append(list);
        if (pageCount > 1) {
            const pagination = node('div', 'jl-pagination');
            const previous = button('‹', () => { void act('page', { value: page - 1 }); }, 'jl-icon-button', '上一页');
            previous.disabled = page === 0;
            const next = button('›', () => { void act('page', { value: page + 1 }); }, 'jl-icon-button', '下一页');
            next.disabled = page === pageCount - 1;
            pagination.append(previous, node('span', 'jl-muted', `${page + 1} / ${pageCount}`), next);
            blocks.append(pagination);
        }
        layout.append(blocks,liveBox);content.append(layout);
    }

    function dialog({ title = '', body, buttons = [{ label: '完成', value: true, primary: true }], layout = 'default', page = 'library' } = {}) {
        mount();
        if (!visible) open();
        const isPage = layout === 'page';
        const layer = node('div', isPage ? 'jl-page-layer' : 'jl-modal-layer');
        const surface = node('section', 'jl-dialog');
        if(isPage)surface.classList.add('jl-page-surface');
        if (layout === 'menu') surface.classList.add('jl-dialog-menu');
        if (layout === 'wide') surface.classList.add('jl-dialog-wide');
        surface.setAttribute('role', isPage ? 'region' : 'dialog');
        if(!isPage)surface.setAttribute('aria-modal', 'true');
        surface.setAttribute('aria-label', title || '操作');
        surface.tabIndex = -1;
        const header = node('header', 'jl-sheet-header');
        header.append(node('h2', '', title));
        const previousFocus = activeElement();
        let finish;
        const promise = new Promise(resolve => {
            finish = value => {
                const index = dialogs.findIndex(entry => entry.surface === surface);
                if (index < 0) return;
                dialogs.splice(index, 1);
                layer.remove();
                if(pageEntry?.surface===surface){pageEntry=null;pageHost.hidden=true;content.hidden=false;}
                if (visible) {
                    if (previousFocus?.isConnected) previousFocus.focus();
                    else focusSurface(topSurface());
                }
                resolve(value);
            };
        });
        if(!isPage)header.append(iconButton('×', '关闭对话框', () => finish(null)));
        const bodyContainer = node('div', 'jl-dialog-body');
        if (body?.nodeType) bodyContainer.append(body);
        else if (body !== undefined) bodyContainer.textContent = String(body);
        const footer = node('footer', 'jl-dialog-footer');
        for (const specification of buttons) {
            const choice = button(specification.label, () => finish(specification.value), specification.primary ? 'jl-primary' : specification.danger ? 'jl-danger' : '');
            choice.disabled = Boolean(specification.disabled);
            footer.append(choice);
        }
        if(isPage)surface.append(header,footer,bodyContainer);
        else surface.append(header, bodyContainer, footer);
        layer.append(surface);
        layer.addEventListener('click', event => { if (event.target === layer) finish(null); });
        const entry={ surface, finish };
        if(isPage){pageEntry=entry;currentPage=page;pageHost.replaceChildren(layer);pageHost.hidden=false;content.hidden=true;render(state);}
        else overlay.append(layer);
        dialogs.push(entry);
        focusSurface(surface);
        return promise;
    }

    function showChunk({ chunk, sourceText = '' }) {
        mount();
        if (!visible) open();
        chunkView?.close(false);
        let currentChunk = { ...chunk };
        let dirty = false;
        const previousFocus = activeElement();
        const layer = node('div', 'jl-sheet-layer');
        const surface = node('section', 'jl-sheet');
        const inline=window.innerWidth>950&&Boolean(content.querySelector('.jl-live'));
        if(inline){layer.className='jl-inline-sheet-layer';surface.classList.add('jl-inline-sheet');}
        surface.setAttribute('role', 'dialog');
        if(!inline)surface.setAttribute('aria-modal', 'true');else surface.setAttribute('role','region');
        surface.setAttribute('aria-label', chunk.label || '文本块详情');
        surface.tabIndex = -1;
        const header = node('header', 'jl-sheet-header');
        const heading = node('div', 'jl-sheet-heading');
        heading.append(node('h2', '', `${String(Number(chunk.index) + 1).padStart(2, '0')} · ${chunk.label || '文本块'}`), node('span', 'jl-muted', `${formatNumber(Number(chunk.start) + 1)}–${formatNumber(chunk.end)} 字`));
        const view = {
            surface,
            inline,layer,
            runId:chunk.runId,chunkId:chunk.id,
            stream(text){if(!dirty){const near=output.scrollTop+output.clientHeight>=output.scrollHeight-40;output.value=text;output.readOnly=true;if(near)output.scrollTop=output.scrollHeight;}},
            close(restoreFocus = true) {
                if (chunkView !== view) return;
                layer.remove();
                chunkView = null;
                if(inline&&restoreFocus)render(state);
                if (restoreFocus && visible) {
                    if (previousFocus?.isConnected) previousFocus.focus();
                    else focusSurface(frame);
                }
            },
            update(nextChunk) {
                const value = nextChunk.chunk || nextChunk;
                currentChunk = { ...currentChunk, ...value };
                if (!dirty) output.value = currentChunk.output || '';
                output.readOnly=currentChunk.status==='running';
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
        output.readOnly=chunk.status==='running';
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
        const remove = button('删除此块', () => { void act('deleteChunks', { ids: [currentChunk.id] }); }, 'jl-danger');
        remove.disabled = Boolean(state.active);
        const write=button('写入酒馆',()=>{void act('publishOutput',{id:currentChunk.id,output:output.value});});
        const more=button('更多',async()=>{
            const value=await dialog({title:'分块操作',layout:'menu',buttons:[{label:'导出',value:'export'},{label:'保存到资料',value:'library'},{label:'重试',value:'retry',disabled:retry.disabled},{label:'按当前预设重跑',value:'rerun',disabled:rerun.disabled},{label:'删除此块',value:'delete',danger:true,disabled:remove.disabled},{label:'返回',value:'close'}]});
            if(value==='export')exportButton.click();
            if(value==='library')void act('saveToLibrary',{id:currentChunk.id,output:output.value});
            if(value==='retry')retry.click();if(value==='rerun')rerun.click();if(value==='delete')remove.click();
        });
        footer.append(copy,write,more,node('span','jl-grow'),save);
        surface.append(header, tabs, body, footer);
        layer.append(surface);
        layer.addEventListener('click', event => { if (event.target === layer) view.close(); });
        if(inline)content.querySelector('.jl-live').replaceChildren(layer);else overlay.append(layer);
        chunkView = view;
        for(const row of content.querySelectorAll('.jl-chunk-row'))row.dataset.open=String(row.querySelector(`[data-focus-key="chunk-${chunk.id}"]`)!==null);
        focusSurface(surface);
        return view;
    }

    function destroy() {
        close();
        shadow?.removeEventListener('keydown', handleKeydown, true);
        for (const type of shieldedEvents) shadow?.removeEventListener(type, stopHostEvent);
        window.removeEventListener('resize', syncViewport);
        window.visualViewport?.removeEventListener('resize', syncViewport);
        window.visualViewport?.removeEventListener('scroll', syncViewport);
        clearTimeout(toastTimer);
        host?.remove();
        host = shadow = null;
        root = frame = content = overlay = toast = null;
    }

    function updateStream(event){
        lastLive=event;
        if(state.run?.id===event.runId){
            const field=content?.querySelector('.jl-live-text');
            if(field){const near=field.scrollTop+field.clientHeight>=field.scrollHeight-40;field.value=event.text;if(near)field.scrollTop=field.scrollHeight;}
            const count=content?.querySelector('.jl-preview-count');if(count)count.textContent=`${event.text.length.toLocaleString()} 字`;
        }
        if(chunkView?.runId===event.runId&&chunkView.chunkId===event.chunkId)chunkView.stream(event.text);
    }

    return { mount, open, close, render, dialog, showChunk, updateStream,notify: announce, destroy };
}
