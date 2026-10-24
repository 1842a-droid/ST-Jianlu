import { createHost } from './host.js';
import { createRepository } from './store.js';
import { createQueue } from './queue.js';
import { createUI } from './ui.js';
import { createController } from './app.js';

const INSTANCE = '__jianlu_extension__';
let initialization = null;

export async function initialize() {
    if (globalThis[INSTANCE]) return globalThis[INSTANCE];
    if (initialization) return initialization;
    initialization = initializeOnce();
    try { return await initialization; }
    finally { initialization = null; }
}

async function initializeOnce() {
    if (!globalThis.SillyTavern?.getContext) throw new Error('SillyTavern 尚未就绪');
    const host = createHost();
    const repo = createRepository(host.fileBackend());
    const queue = createQueue({ repo, host });
    let app;
    const ui = createUI({ onAction: (type, payload) => app.handle(type, payload) });
    app = createController({ repo, host, queue, ui });
    const buttons = [];
    const addEntry = (target, id, label) => {
        if (!target || document.getElementById(id)) return;
        const button = document.createElement('button');
        button.id = id; button.type = 'button'; button.title = label;
        button.className = 'list-group-item flex-container flexGap5';
        const icon = document.createElement('i'); icon.className = 'fa-solid fa-book-open'; icon.setAttribute('aria-hidden', 'true');
        const text = document.createElement('span'); text.textContent = label;
        button.append(icon, text);
        button.addEventListener('click', () => app.open().catch(error => host.notify(error.message, 'error')));
        target.append(button); buttons.push(button);
    };
    try {
        await app.init();
        addEntry(document.getElementById('extensionsMenu'), 'jianlu-menu-entry', '笺录');
        if (!buttons.length) {
            const target = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
            addEntry(target, 'jianlu-settings-entry', '打开笺录 · 小说工作台');
        }
        if (!buttons.length) throw new Error('未找到酒馆扩展菜单，请刷新酒馆后重试');
        const instance = { open: () => app.open(), destroy: () => { app.destroy(); buttons.forEach(button => button.remove()); delete globalThis[INSTANCE]; } };
        globalThis[INSTANCE] = instance;
        return instance;
    } catch (error) {
        app.destroy(); buttons.forEach(button => button.remove()); throw error;
    }
}

if (typeof document !== 'undefined') {
    const start = () => {
        const ctx = globalThis.SillyTavern?.getContext?.();
        if (!ctx) {
            console.error('[笺录] SillyTavern getContext 不可用');
            return;
        }
        const boot = () => initialize().catch(error => {
            console.error('[笺录]', error);
            globalThis.toastr?.error?.(error.message, '笺录');
        });
        if (ctx.eventSource && ctx.eventTypes?.APP_READY) ctx.eventSource.once(ctx.eventTypes.APP_READY, boot);
        // The extension may also be enabled after APP_READY has already fired.
        boot();
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
}
