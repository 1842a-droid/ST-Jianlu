import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHost } from '../host.js';

function emitter() {
    const listeners = new Map();
    return {
        on(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); },
        removeListener(name, fn) { listeners.set(name, (listeners.get(name) || []).filter(x => x !== fn)); },
        async emit(name, value) { for (const listener of listeners.get(name) || []) await listener(value); },
    };
}

function fixture(overrides = {}) {
    const handlers = new Map();
    const events = emitter();
    const oldDepth = { value: 'PRIVATE OLD CHAT', position: 1, depth: 0, role: 0 };
    const chat = [{ mes: 'PRIVATE CHAT HISTORY', is_user: true }];
    const ctx = {
        mainApi: 'openai', characterId: '0', groupId: null, name1: 'Reader', name2: 'Tool', chatId: 'chat-one', chat,
        characters: [{ data: { extensions: {} } }], maxContext: 8192,
        chatCompletionSettings: { chat_completion_source: 'custom', custom_url: 'https://u:secret@example.test/v1?key=secret', api_key: 'DO-NOT-SAVE' },
        extensionPrompts: { oldDepth }, chatMetadata: { marker: 'keep' },
        eventSource: events,
        eventTypes: { CHAT_COMPLETION_PROMPT_READY: 'prompt', CHAT_COMPLETION_SETTINGS_READY: 'settings', CHAT_CHANGED: 'chat' },
        getPresetManager: () => ({ getSelectedPresetName: () => 'My preset' }),
        getChatCompletionModel: () => 'model-A',
        getCharacterCardFields: () => ({ description: 'CARD DESCRIPTION', personality: '', scenario: '' }),
        getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'csrf' }),
        macros: { register(name, { handler }) { handlers.set(name, handler); } },
        async getWorldInfoPrompt(source, max, dryRun, scan) {
            assert.deepEqual(source, [state.input]); assert.equal(dryRun, true); assert.equal(scan.trigger, 'quiet');
            ctx.chatMetadata.timedWorldInfo = { sticky: {} };
            return { worldInfoBefore: 'BOOK BEFORE', worldInfoAfter: 'BOOK AFTER', worldInfoDepth: [{ depth: 0, role: 0, entries: ['BOOK DEPTH'] }] };
        },
    };
    const state = { input: '正文 {{char}} 不得替换 🐈', sent: 0, prepareOptions: null, sourceSlot: false, removeSource: false };
    const nativeExpand = content => String(content).replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (whole, name) => handlers.has(name) ? handlers.get(name)() : name === 'char' ? 'THIS WOULD CORRUPT THE NOVEL' : whole);
    const prompt = { identifier: 'task', name: 'User task', role: 'system', content: '' };
    const openai = {
        promptManager: { activeCharacter: { id: '0' }, getPromptOrderForCharacter: () => [{ identifier: 'task', enabled: true }], getPromptById: () => ({ ...prompt, content: state.sourceSlot ? '{{jl_source}}' : 'Preset rules' }), shouldTrigger: () => true },
        async prepareOpenAIMessages(options, dryRun) {
            state.prepareOptions = options; assert.equal(dryRun, true);
            assert.equal(Object.hasOwn(ctx.extensionPrompts, 'oldDepth'), false);
            assert.equal(ctx.extensionPrompts.customDepthWI_0_0.value, 'BOOK DEPTH');
            if (state.removeSource) return [[{ role: 'system', content: 'no data' }], {}];
            return [[{ role: 'system', content: 'SECOND RULE FIRST' }, { role: 'system', content: 'FIRST RULE SECOND' },
                { role: 'user', content: state.sourceSlot ? nativeExpand('{{jl_source}}') : nativeExpand(options.messages[0].content) }], {}];
        },
        async sendOpenAIRequest(type, messages, signal) {
            assert.equal(type, 'quiet'); state.sent++;
            const settings = { messages, model: 'model-A', api_key: 'NEVER-PERSIST' };
            await events.emit('settings', settings);
            if (signal?.aborted) throw signal.reason;
            return { choices: [{ message: { content: 'result' }, finish_reason: 'length' }] };
        },
    };
    const script = { isGenerating: () => false };
    Object.assign(ctx, overrides);
    const host = createHost({ getContext: () => ctx, loadModule: async name => name.includes('openai.js') ? openai : script });
    return { host, ctx, state, openai, script, events, oldDepth, chat };
}

test('capture uses native preset builder and isolates/restores chat injections without changing chat', async () => {
    const f = fixture(); const snapshot = await f.host.capture(f.state.input, { projectTitle: 'Novel', blockLabel: 'Chapter one' });
    assert.equal(snapshot.messages[0].content, 'SECOND RULE FIRST');
    assert.equal(snapshot.messages[1].content, 'FIRST RULE SECOND');
    assert.equal(snapshot.messages[2].content, f.state.input);
    assert.equal(f.ctx.chat, f.chat); assert.equal(f.ctx.chat[0].mes, 'PRIVATE CHAT HISTORY');
    assert.equal(f.ctx.extensionPrompts.oldDepth, f.oldDepth);
    assert.deepEqual(Object.keys(f.ctx.extensionPrompts), ['oldDepth']);
    assert.deepEqual(f.ctx.chatMetadata, { marker: 'keep' });
    assert.equal(snapshot.profile.endpoint, 'https://example.test/v1');
    assert.doesNotMatch(JSON.stringify(snapshot), /DO-NOT-SAVE|u:secret|key=secret/);
});

test('jl_source goes through enabled preset slot with no duplicate chat-history input', async () => {
    const f = fixture(); f.state.sourceSlot = true;
    const snapshot = await f.host.capture(f.state.input);
    assert.deepEqual(f.state.prepareOptions.messages, []);
    assert.equal(snapshot.messages[2].content, f.state.input);
});

test('capture rejects missing/truncated source and restores state after native failure', async () => {
    const f = fixture(); f.state.removeSource = true;
    await assert.rejects(f.host.capture(f.state.input), /原文未完整/);
    assert.equal(f.ctx.extensionPrompts.oldDepth, f.oldDepth);
    f.openai.prepareOpenAIMessages = async () => { throw new Error('tokenizer failed'); };
    await assert.rejects(f.host.capture(f.state.input), /tokenizer failed/);
    assert.equal(f.ctx.extensionPrompts.oldDepth, f.oldDepth);
    assert.deepEqual(f.ctx.chatMetadata, { marker: 'keep' });
});

test('unsupported modes, group chats and absent characters fail before generation', async () => {
    for (const overrides of [{ mainApi: 'textgenerationwebui' }, { groupId: 'group' }, { characterId: undefined }]) {
        const f = fixture(overrides);
        await assert.rejects(f.host.capture(f.state.input)); assert.equal(f.state.sent, 0);
    }
});

test('generation retains actual post-event messages, signal and finish reason without storing settings secrets', async () => {
    const f = fixture(); const snapshot = await f.host.capture(f.state.input);
    f.events.on('prompt', event => event.chat.push({ role: 'system', content: 'extension addition' }));
    f.events.on('settings', settings => settings.messages.push({ role: 'system', content: 'final settings addition' }));
    const controller = new AbortController(); const result = await f.host.generate(snapshot, { signal: controller.signal });
    assert.equal(result.text, 'result'); assert.equal(result.finishReason, 'length');
    assert.equal(result.requestMessages.at(-1).content, 'final settings addition');
    assert.equal(snapshot.requestMessages.at(-1).content, 'final settings addition');
    assert.equal(snapshot.messages.length, 3); assert.equal(f.ctx.chat, f.chat);
    assert.equal(result.requestStage, 'settings-ready');
    assert.doesNotMatch(JSON.stringify(snapshot), /NEVER-PERSIST/);
});

test('global settings events from unrelated chats cannot overwrite this request snapshot', async () => {
    const f = fixture(); const snapshot = await f.host.capture(f.state.input);
    f.openai.sendOpenAIRequest = async (type, messages) => {
        await f.events.emit('settings', { messages, model: 'model-A' });
        await f.events.emit('settings', { messages: [{ role: 'user', content: 'UNRELATED PRIVATE CHAT' }], model: 'another-model' });
        return { choices: [{ message: { content: 'ours' } }] };
    };
    const result = await f.host.generate(snapshot);
    assert.equal(result.text, 'ours'); assert.equal(result.profile.model, 'model-A');
    assert.equal(result.requestMessages[2].content, f.state.input);
    assert.doesNotMatch(JSON.stringify(snapshot), /UNRELATED PRIVATE CHAT|another-model/);
});

test('replacement before the scoped settings observer safely retains prompt-stage snapshot', async () => {
    const f = fixture(); const snapshot = await f.host.capture(f.state.input);
    f.events.on('settings', data => { data.messages = [{ role: 'user', content: 'replacement without request identity' }]; });
    const result = await f.host.generate(snapshot);
    assert.equal(result.requestStage, 'prompt-ready');
    assert.match(result.requestNote, /后端仍可能/);
    assert.equal(result.requestMessages[2].content, f.state.input);
    assert.doesNotMatch(JSON.stringify(snapshot), /replacement without request identity/);
});

test('retry blocks changed model/connection and aborted signal before sending', async () => {
    const f = fixture(); const snapshot = await f.host.capture(f.state.input);
    f.ctx.getChatCompletionModel = () => 'model-B';
    await assert.rejects(f.host.generate(snapshot), /当前 API 或模型/); assert.equal(f.state.sent, 0);
    f.ctx.getChatCompletionModel = () => 'model-A';
    const controller = new AbortController(); controller.abort();
    await assert.rejects(f.host.generate(snapshot, { signal: controller.signal }), { name: 'AbortError' });
    assert.equal(f.state.sent, 0);
});

test('API failure keeps actual request on snapshot and generation lock is released', async () => {
    const f = fixture(); const snapshot = await f.host.capture(f.state.input);
    f.openai.sendOpenAIRequest = async () => { throw new Error('network error'); };
    await assert.rejects(f.host.generate(snapshot), /network error/);
    assert.equal(snapshot.requestMessages[2].content, f.state.input);
    f.openai.sendOpenAIRequest = async () => ({ choices: [{ message: { content: 'recovered' } }] });
    assert.equal((await f.host.generate(snapshot)).text, 'recovered');
});

test('server file backend handles UTF-8 text, exact scoped paths, missing files and hard errors', async () => {
    const files = new Map(); const requests = [];
    const ctx = { getRequestHeaders: () => ({ 'X-CSRF-Token': 'csrf' }) };
    const request = async (url, options) => {
        requests.push({ url, options });
        if (url === '/api/files/upload') {
            const body = JSON.parse(options.body); files.set(body.name, Buffer.from(body.data, 'base64').toString('utf8'));
            return { ok: true, status: 200, json: async () => ({ path: `/user/files/${body.name}` }) };
        }
        if (url === '/api/files/delete') {
            const body = JSON.parse(options.body); assert.match(body.path, /^\/user\/files\/jl-/); files.delete(body.path.split('/').at(-1));
            return { ok: true, status: 200 };
        }
        const name = url.split('/').at(-1);
        if (name === 'jl-error.json') return { ok: false, status: 500 };
        if (name === 'jl-login.json') return { ok: true, status: 200, headers: { get: () => 'text/html; charset=utf8' }, text: async () => '<!doctype html><html>login</html>' };
        return { ok: files.has(name), status: files.has(name) ? 200 : 404, text: async () => files.get(name) };
    };
    const backend = createHost({ getContext: () => ctx, fetch: request }).fileBackend();
    const text = '小说🪶 {{char}}\n'.repeat(9000);
    await backend.write('jl-project-source.txt', text);
    assert.equal(await backend.read('jl-project-source.txt'), text);
    await backend.write('jl-empty.txt', ''); assert.equal(await backend.read('jl-empty.txt'), '');
    assert.equal(await backend.read('jl-absent.json'), null);
    await assert.rejects(backend.read('jl-error.json'), /500/);
    await assert.rejects(backend.read('jl-login.json'), /登录/);
    await assert.rejects(backend.write('../settings.json', 'x'), /无效/);
    await assert.rejects(backend.remove('jl-..-source.txt'), /无效/);
    await backend.remove('jl-project-source.txt'); assert.equal(await backend.read('jl-project-source.txt'), null);
    assert.equal(requests.every(x => x.options.headers['X-CSRF-Token'] === 'csrf'), true);
});

test('native API entry opens its drawer without clicking the Connect button', () => {
    const previous = globalThis.document;
    const clicks = [];
    globalThis.document = { getElementById: id => ({ classList: { contains: () => false }, click: () => clicks.push(id) }) };
    try {
        const host = createHost(); host.openApi(); host.openPreset(); host.openWorldInfo();
        assert.deepEqual(clicks, ['API-status-top', 'leftNavDrawerIcon', 'WIDrawerIcon']);
    } finally { globalThis.document = previous; }
});
