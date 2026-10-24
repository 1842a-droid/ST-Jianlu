/* SillyTavern adapter. No task instructions or API credentials are stored here. */
const clone = value => value == null ? value : structuredClone(value);
const SOURCE_MACRO = /\{\{\s*jl_source\s*\}\}/i;
const FILE_NAME = /^jl-[A-Za-z0-9_.-]{1,200}\.(?:json|txt)$/;
const roleName = role => ({ 0: 'system', 1: 'user', 2: 'assistant' }[role] || role || 'system');

function abortError() {
    return new DOMException('已暂停', 'AbortError');
}

function publicEndpoint(value) {
    if (!value) return '';
    try {
        const url = new URL(String(value));
        return `${url.protocol}//${url.host}${url.pathname}`;
    } catch { return ''; }
}

function textContent(content) {
    if (typeof content === 'string') return content;
    return Array.isArray(content) ? content.filter(x => x?.type === 'text').map(x => x.text || '').join('\n') : '';
}

function finishReason(raw) {
    return raw?.choices?.[0]?.finish_reason || raw?.candidates?.[0]?.finishReason || raw?.stop_reason || raw?.finish_reason || '';
}

function responseText(raw, ctx) {
    if (typeof raw === 'string') return raw;
    const direct = raw?.choices?.[0]?.message?.content ?? raw?.choices?.[0]?.text;
    if (typeof direct === 'string') return direct;
    if (Array.isArray(direct)) return direct.filter(x => x?.type === 'text' || x?.type === 'output_text').map(x => x.text || '').join('');
    if (Array.isArray(raw?.candidates)) return (raw.candidates[0]?.content?.parts || []).filter(x => !x.thought).map(x => x.text || '').join('');
    if (Array.isArray(raw?.content)) return raw.content.filter(x => x.type === 'text').map(x => x.text || '').join('');
    if (typeof ctx.extractMessageFromData === 'function') return String(ctx.extractMessageFromData(raw, 'openai') || '');
    return '';
}

function base64(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 16384) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
    }
    return btoa(binary);
}

/** The optional loader and context injection are for lightweight host-contract tests. */
export function createHost({ getContext, fetch: request = globalThis.fetch?.bind(globalThis), loadModule = path => import(path) } = {}) {
    const context = getContext || (() => globalThis.SillyTavern?.getContext?.());
    let corePromise;
    let active = false;
    let capturing = false;
    let macroRegistry;
    let macroValues = Object.create(null);

    function ctxOrThrow() {
        const ctx = context();
        if (!ctx) throw new Error('请在 SillyTavern 中打开笺录');
        return ctx;
    }

    function profile(ctx) {
        const settings = ctx.chatCompletionSettings || {};
        let presetName = '';
        try { presetName = ctx.getPresetManager?.('openai')?.getSelectedPresetName?.() || ''; } catch { /* Not initialized yet. */ }
        let model = '';
        try { model = ctx.getChatCompletionModel?.() || ''; } catch { /* Optional on old versions. */ }
        return {
            api: ctx.mainApi || '', source: settings.chat_completion_source || '', model: String(model),
            presetName: String(presetName), characterName: String(ctx.name2 || ''), chatId: String(ctx.chatId || ''),
            endpoint: publicEndpoint(settings.chat_completion_source === 'custom' ? settings.custom_url : settings.reverse_proxy),
        };
    }

    function info() {
        const ctx = context();
        if (!ctx) return { available: false, supported: false, api: '', presetName: '', characterName: '', chatId: '' };
        return { available: true, supported: ctx.mainApi === 'openai', ...profile(ctx) };
    }

    async function core() {
        if (!corePromise) corePromise = Promise.all([loadModule('/scripts/openai.js'), loadModule('/script.js')])
            .then(([openai, script]) => {
                if (typeof openai.prepareOpenAIMessages !== 'function' || typeof openai.sendOpenAIRequest !== 'function') {
                    throw new Error('当前酒馆版本缺少笺录需要的 Chat Completion 接口，请更新酒馆');
                }
                return { openai, script };
            }).catch(error => { corePromise = undefined; throw new Error(`酒馆接口加载失败：${error.message}`); });
        return corePromise;
    }

    function assertSupported(ctx) {
        if (ctx.mainApi !== 'openai') throw new Error('请在酒馆 API 中切换到 Chat Completion；当前模式尚不支持');
        if (ctx.groupId) throw new Error('请先打开一个单角色对话，再使用笺录');
        if (ctx.characterId === undefined || ctx.characterId === null) throw new Error('请先选中一个角色，以使用其预设和世界书');
    }

    function installMacros(ctx) {
        const registry = ctx.macros || ctx.registerMacro;
        if (!registry || registry === macroRegistry) return;
        for (const name of ['jl_source', 'jl_project', 'jl_block', 'jl_index', 'jl_total']) {
            const handler = () => macroValues[name] || '';
            if (ctx.macros?.register) ctx.macros.register(name, { handler, description: `笺录项目数据：${name.slice(3)}` });
            else if (ctx.registerMacro) ctx.registerMacro(name, handler);
        }
        macroRegistry = registry;
    }

    function enabledPrompts(manager) {
        if (!manager?.activeCharacter || !manager.getPromptOrderForCharacter || !manager.getPromptById) return [];
        return manager.getPromptOrderForCharacter(manager.activeCharacter)
            .filter(entry => entry.enabled)
            .map(entry => manager.getPromptById(entry.identifier))
            .filter(prompt => prompt && (!manager.shouldTrigger || manager.shouldTrigger(prompt, 'quiet')));
    }

    async function capture(input, options = {}) {
        if (active || capturing) throw new Error('当前任务正在准备或生成，请稍后再试');
        const ctx = ctxOrThrow();
        assertSupported(ctx);
        if (typeof input !== 'string' || !input.trim()) throw new Error('没有可发送的原文');
        capturing = true;
        const previousValues = macroValues;
        let restorePrompts;
        let restoreTimed;
        try {
            const { openai, script } = await core();
            if (script.isGenerating?.()) throw new Error('酒馆正在生成消息，请等待完成后再运行小说任务');
            if (!openai.promptManager?.activeCharacter) throw new Error('预设管理器尚未就绪，请先打开一个角色对话');
            installMacros(ctx);

            // Protect literal novel macros while retaining real input for native token budgeting.
            const nonce = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
            const left = `⟦JL-${nonce}-OPEN⟧`, right = `⟦JL-${nonce}-CLOSE⟧`;
            const begin = `⟦JL-${nonce}-BEGIN⟧`, end = `⟦JL-${nonce}-END⟧`;
            const protect = text => String(text ?? '').replaceAll('{{', left).replaceAll('}}', right);
            const protectedSource = `${begin}${protect(input)}${end}`;
            const unprotect = text => String(text).replaceAll(begin, '').replaceAll(end, '').replaceAll(left, '{{').replaceAll(right, '}}');
            macroValues = {
                jl_source: protectedSource,
                jl_project: protect(options.projectTitle ?? options.project ?? ''),
                jl_block: protect(options.blockLabel ?? options.label ?? ''),
                jl_index: Number.isFinite(Number(options.blockIndex ?? options.index)) ? String(Number(options.blockIndex ?? options.index) + 1) : '',
                jl_total: String(options.blockTotal ?? options.total ?? ''),
            };

            // Native depth injections read this shared object directly. Isolate them for the
            // short preparation only, then restore every original record in finally.
            const prompts = ctx.extensionPrompts || {};
            const originalPrompts = { ...prompts };
            restorePrompts = () => {
                for (const key of Object.keys(prompts)) delete prompts[key];
                Object.assign(prompts, originalPrompts);
            };
            for (const key of Object.keys(prompts)) delete prompts[key];
            const metadata = ctx.chatMetadata;
            if (metadata) {
                const hadTimed = Object.hasOwn(metadata, 'timedWorldInfo');
                const timed = clone(metadata.timedWorldInfo);
                restoreTimed = () => { if (hadTimed) metadata.timedWorldInfo = timed; else delete metadata.timedWorldInfo; };
            }
            const fields = ctx.getCharacterCardFields?.() || {};
            const wi = typeof ctx.getWorldInfoPrompt === 'function'
                ? await ctx.getWorldInfoPrompt([input], Number(ctx.chatCompletionSettings?.openai_max_context) || Number(ctx.maxContext) || 8192, true, {
                    trigger: 'quiet', personaDescription: fields.persona || '', characterDescription: fields.description || '',
                    characterPersonality: fields.personality || '', characterDepthPrompt: fields.charDepthPrompt || '',
                    scenario: fields.scenario || '', creatorNotes: fields.creatorNotes || '',
                }) : {};
            for (const depth of wi.worldInfoDepth || []) {
                prompts[`customDepthWI_${depth.depth}_${depth.role}`] = {
                    value: (depth.entries || []).join('\n'), position: 1, depth: Number(depth.depth) || 0,
                    role: Number(depth.role) || 0, scan: false,
                };
            }
            for (const [name, entries] of Object.entries(wi.outletEntries || {})) {
                prompts[`customWIOutlet_${name}`] = { value: entries.join('\n'), position: -1, depth: 0, scan: false, role: 0 };
            }
            if (wi.anBefore?.length || wi.anAfter?.length) {
                prompts['2_floating_prompt'] = { value: [...(wi.anBefore || []), ...(wi.anAfter || [])].join('\n'), position: 1, depth: 0, role: 0, scan: false };
            }
            const char = ctx.characters?.[ctx.characterId];
            const depth = char?.data?.extensions?.depth_prompt;
            if (depth?.prompt) prompts.DEPTH_PROMPT = { value: depth.prompt, position: 1, depth: Number(depth.depth) || 0, role: Number(depth.role) || 0, scan: false };

            let examples = [];
            if (script.parseMesExamples && openai.setOpenAIMessageExamples) {
                let strings = script.parseMesExamples(fields.mesExamples || '', false);
                for (const entry of wi.worldInfoExamples || []) {
                    const values = script.parseMesExamples(entry.content || '', false);
                    strings = Number(entry.position) === 0 ? [...values, ...strings] : [...strings, ...values];
                }
                examples = openai.setOpenAIMessageExamples(strings);
            }
            const selected = enabledPrompts(openai.promptManager);
            const rawRules = [fields.system, fields.jailbreak, ...selected.map(x => x.content), wi.worldInfoBefore, wi.worldInfoAfter,
                ...(wi.worldInfoDepth || []).flatMap(x => x.entries || []), ...Object.values(wi.outletEntries || {}).flat()].join('\n');
            const hasSourceSlot = SOURCE_MACRO.test(rawRules) || rawRules.includes(begin);
            const [prepared] = await openai.prepareOpenAIMessages({
                name2: ctx.name2 || '', charDescription: fields.description || '', charPersonality: fields.personality || '',
                scenario: fields.scenario || '', worldInfoBefore: wi.worldInfoBefore || '', worldInfoAfter: wi.worldInfoAfter || '',
                extensionPrompts: prompts, bias: '', type: 'quiet', quietPrompt: '', quietImage: null, cyclePrompt: '',
                systemPromptOverride: fields.system || '', jailbreakPromptOverride: fields.jailbreak || '',
                messages: hasSourceSlot ? [] : [{ role: 'user', content: protectedSource, name: ctx.name1 || 'User' }],
                messageExamples: examples,
            }, true);
            if (!Array.isArray(prepared) || !prepared.length) throw new Error('预设没有生成可用消息，请检查已启用条目');
            const messages = clone(prepared).map(message => {
                if (typeof message.content === 'string') message.content = unprotect(message.content);
                else if (Array.isArray(message.content)) message.content = message.content.map(part => typeof part?.text === 'string' ? { ...part, text: unprotect(part.text) } : part);
                return message;
            });
            if (!messages.some(message => textContent(message.content).includes(input))) {
                throw new Error('原文未完整进入提示词：请启用预设中的 Chat History，或在启用条目内放入 {{jl_source}}；也请检查上下文容量');
            }
            return {
                kind: 'st-chat-completion', createdAt: new Date().toISOString(), messages, profile: profile(ctx),
                presetEntries: selected.map(prompt => ({ identifier: prompt.identifier, name: prompt.name || '', role: roleName(prompt.role), depth: prompt.injection_depth ?? null, position: prompt.injection_position ?? null })),
                warnings: ['不包含聊天历史；复杂酒馆助手和 EJS 脚本的执行效果需另行核对'],
            };
        } finally {
            restoreTimed?.(); restorePrompts?.(); macroValues = previousValues; capturing = false;
        }
    }

    async function generate(snapshot, { signal } = {}) {
        if (active || capturing) throw new Error('已有请求正在执行');
        const ctx = ctxOrThrow();
        assertSupported(ctx);
        if (!Array.isArray(snapshot?.messages) || !snapshot.messages.length) throw new Error('该块没有保存的提示词');
        if (signal?.aborted) throw abortError();
        active = true;
        let removeSettings;
        try {
            const { openai, script } = await core();
            if (script.isGenerating?.()) throw new Error('酒馆正在生成消息，请等待完成后再运行小说任务');
            const current = profile(ctx);
            for (const key of ['api', 'source', 'model', 'endpoint']) {
                if (snapshot.profile?.[key] && snapshot.profile[key] !== current[key]) {
                    throw new Error('当前 API 或模型与该块记录不同；请切回原连接，或按当前预设重新准备该块');
                }
            }
            const eventData = { chat: clone(snapshot.messages), dryRun: false };
            const readyEvent = ctx.eventTypes?.CHAT_COMPLETION_PROMPT_READY;
            if (readyEvent && ctx.eventSource?.emit) await ctx.eventSource.emit(readyEvent, eventData);
            if (signal?.aborted) throw abortError();
            if (!Array.isArray(eventData.chat) || !eventData.chat.length) throw new Error('其他扩展移除了本次提示词');
            snapshot.requestMessages = clone(eventData.chat);
            snapshot.actualProfile = current;
            snapshot.requestStage = 'prompt-ready';
            snapshot.requestNote = '已记录提示词事件后的本次输入；宿主后端仍可能继续处理';
            let finalSettings;
            const settingsEvent = ctx.eventTypes?.CHAT_COMPLETION_SETTINGS_READY;
            // SETTINGS_READY is global: only accept the exact array handed to this
            // request. If an earlier listener replaces it, keep the scoped prompt
            // snapshot rather than risk recording a different chat's payload.
            const observe = value => { if (value?.messages === eventData.chat) finalSettings = value; };
            if (settingsEvent && ctx.eventSource?.on) {
                ctx.eventSource.on(settingsEvent, observe);
                removeSettings = () => ctx.eventSource.removeListener?.(settingsEvent, observe);
            }
            const updateActual = () => {
                if (Array.isArray(finalSettings?.messages)) {
                    snapshot.requestMessages = clone(finalSettings.messages);
                    snapshot.requestStage = 'settings-ready';
                    snapshot.requestNote = '已记录本次设置事件后的消息；模型服务端仍可能继续处理';
                }
                if (finalSettings?.model) snapshot.actualProfile = { ...current, model: String(finalSettings.model) };
            };
            let raw;
            try { raw = await openai.sendOpenAIRequest('quiet', eventData.chat, signal); }
            finally { updateActual(); }
            if (signal?.aborted) throw abortError();
            const text = responseText(raw, ctx);
            if (!text.trim()) throw new Error('模型返回了空内容，原始请求已保留');
            return { text, finishReason: finishReason(raw), raw, requestMessages: clone(snapshot.requestMessages), profile: clone(snapshot.actualProfile), requestStage: snapshot.requestStage, requestNote: snapshot.requestNote };
        } finally { removeSettings?.(); active = false; }
    }

    function fileBackend() {
        const assertName = name => {
            if (typeof name !== 'string' || !FILE_NAME.test(name) || name.includes('..')) throw new Error('无效的笺录数据文件名');
            return name;
        };
        const headers = () => ctxOrThrow().getRequestHeaders?.() || { 'Content-Type': 'application/json' };
        return {
            async read(name) {
                assertName(name);
                const response = await request(`/user/files/${encodeURIComponent(name)}`, { method: 'GET', headers: headers(), cache: 'no-store', credentials: 'same-origin' });
                if (response.status === 404) return null;
                if (!response.ok) throw new Error(`读取服务器数据失败 (${response.status})`);
                const text = await response.text();
                if (response.headers?.get?.('content-type')?.includes('text/html') && /^\s*(?:<!doctype\s+html|<html)/i.test(text)) {
                    throw new Error('服务器返回了登录页面，请先登录酒馆');
                }
                return text === '\uFEFF' ? '' : text;
            },
            async write(name, text) {
                assertName(name);
                const bodyText = String(text);
                // ST rejects an empty base64 string; a lone BOM represents an empty file.
                const response = await request('/api/files/upload', { method: 'POST', headers: headers(), credentials: 'same-origin', body: JSON.stringify({ name, data: base64(bodyText || '\uFEFF') }) });
                if (!response.ok) throw new Error(`保存服务器数据失败 (${response.status})`);
                const data = await response.json();
                if (!data.path || String(data.path).replace(/^\//, '') !== `user/files/${name}`) throw new Error('服务器未确认数据文件已保存');
                return data.path;
            },
            async remove(name) {
                assertName(name);
                const response = await request('/api/files/delete', { method: 'POST', headers: headers(), credentials: 'same-origin', body: JSON.stringify({ path: `/user/files/${name}` }) });
                if (!response.ok && response.status !== 404) throw new Error(`删除服务器数据失败 (${response.status})`);
            },
        };
    }

    function clickPanel(ids) {
        for (const id of ids) {
            const element = globalThis.document?.getElementById(id);
            if (element) {
                if (!element.classList?.contains('openIcon')) element.click();
                return true;
            }
        }
        throw new Error('未找到酒馆对应入口，请从顶部工具栏打开');
    }

    function subscribe(fn) {
        const ctx = context();
        const events = ['CHAT_CHANGED', 'PRESET_CHANGED', 'CHATCOMPLETION_SOURCE_CHANGED', 'ONLINE_STATUS_CHANGED', 'SETTINGS_UPDATED'];
        const bindings = events.map(name => ctx?.eventTypes?.[name]).filter(Boolean);
        const listener = () => fn(info());
        for (const name of bindings) ctx.eventSource?.on?.(name, listener);
        return () => { for (const name of bindings) ctx.eventSource?.removeListener?.(name, listener); };
    }

    function notify(message, type = 'info') {
        const notifier = globalThis.toastr;
        if (typeof notifier?.[type] === 'function') notifier[type](String(message), '笺录');
    }

    return {
        info, capture, generate, fileBackend, subscribe, notify,
        openPreset: () => clickPanel(['leftNavDrawerIcon']),
        openApi: () => clickPanel(['API-status-top']),
        openWorldInfo: () => clickPanel(['WIDrawerIcon']),
    };
}
