import test from 'node:test';
import assert from 'node:assert/strict';
import { createController, decodeNovel, safeFileName } from '../app.js';
import { createRepository } from '../store.js';
import { createQueue } from '../queue.js';

async function fixture() {
    const files = new Map();
    const backend = { read: async name => files.get(name) ?? null, write: async (name, text) => { files.set(name, text); }, remove: async name => { files.delete(name); } };
    const repo = createRepository(backend);
    const calls = [];
    let shown;
    let captureCount = 0;
    const host = {
        info: () => ({ presetName: '自定义预设', api: 'openai', model: 'mock' }),
        capture: async (input, options) => { captureCount++; return { messages: [{ role: 'user', content: input }], options, profile: {} }; },
        generate: async () => ({ text: '保留输出' }),
        notify: (message, type) => calls.push({ message, type }), subscribe: () => () => {},
    };
    const realQueue = createQueue({ repo, host });
    const starts = [];
    const queue = { ...realQueue, run: async (id, options) => { starts.push({ id, options }); } };
    const ui = { mount() {}, open() {}, close() {}, destroy() {}, render() {}, showChunk: value => { shown = value; return { close() {}, update: value => { shown = value; } }; } };
    const controller = createController({ repo, host, queue, ui, context: () => ({ extensionSettings: {} }) });
    await controller.init();
    const project = await repo.createProject({ title: '项目甲', sourceName: '甲.txt', sourceText: '第一章\n甲乙丙丁。第二章\n戊己庚辛。' });
    const run = await realQueue.plan({ projectId: project.id, chunkSize: 7, overlap: 0 });
    await controller.handle('openProject', { id: project.id });
    return { repo, host, queue, controller, project, run, starts, calls, shown: () => shown, captureCount: () => captureCount };
}

test('原文解码支持 UTF-8、UTF-16 BOM、GB18030，导出文件名安全', () => {
    assert.equal(decodeNovel(new TextEncoder().encode('小说😀').buffer), '小说😀');
    assert.equal(decodeNovel(Uint8Array.from([255, 254, 45, 78]).buffer), '中');
    assert.equal(decodeNovel(Uint8Array.from([254, 255, 78, 45]).buffer), '中');
    assert.equal(decodeNovel(Uint8Array.from([214, 208, 206, 196]).buffer), '中文');
    assert.equal(safeFileName('甲/乙:*?', '.txt'), '甲_乙___.txt');
});

test('查看未运行块仅预览当前配置，不执行 AI、不冻结待运行预设', async () => {
    const f = await fixture();
    await f.controller.handle('openChunk', { id: f.run.chunks[0].id });
    assert.equal(f.captureCount(), 1);
    assert.equal(f.shown().chunk.snapshot.previewOnly, true);
    assert.equal(f.shown().chunk.snapshot.options.blockTotal, f.run.chunks.length);
    const stored = await f.repo.getChunk(f.run.id, f.run.chunks[0].id);
    assert.equal(stored.snapshot, undefined);
    assert.equal(stored.status, 'pending');
    f.controller.destroy();
});

test('仅重试失败限制在失败/截断块和当前选择，不包括成功与剩余块', async () => {
    const f = await fixture();
    for (const [index, status] of ['done', 'failed', 'partial', 'pending'].entries()) {
        if (!f.run.chunks[index]) continue;
        const chunk = await f.repo.getChunk(f.run.id, f.run.chunks[index].id);
        await f.repo.saveChunk(f.run.id, { ...chunk, status, output: status === 'done' ? '完成' : '' });
    }
    await f.controller.refresh();
    await f.controller.handle('retryFailed');
    const failedIds = f.controller.state.run.chunks.filter(chunk => ['failed', 'partial'].includes(chunk.status)).map(chunk => chunk.id);
    assert.deepEqual(f.starts[0].options.ids, failedIds);
    await f.controller.handle('toggleChunk', { id: failedIds[0], checked: true });
    await f.controller.handle('retryFailed');
    assert.deepEqual(f.starts[1].options.ids, [failedIds[0]]);
    f.controller.destroy();
});

test('手动修改输出保留上一版，保存错误传回 UI，不误报成功', async () => {
    const f = await fixture();
    const id = f.run.chunks[0].id;
    const chunk = await f.repo.getChunk(f.run.id, id);
    await f.repo.saveChunk(f.run.id, { ...chunk, status: 'failed', output: '旧输出' });
    await f.controller.handle('saveChunk', { id, output: '修正后的任意格式' });
    const saved = await f.repo.getChunk(f.run.id, id);
    assert.equal(saved.previousOutput, '旧输出');
    assert.equal(saved.output, '修正后的任意格式');
    assert.equal(saved.status, 'done');
    assert.equal(saved.manual, true);
    await assert.rejects(f.controller.handle('saveChunk', { id, output: '' }), /输出为空/);
    assert.equal((await f.repo.getChunk(f.run.id, id)).output, '修正后的任意格式');
    assert.equal(f.controller.state.busy, false);
    f.controller.destroy();
});

test('项目选择与筛选保持隔离，返回列表不影响正在执行队列', async () => {
    const f = await fixture();
    const second = await f.repo.createProject({ title: '项目乙', sourceText: '乙的小说' });
    await f.controller.handle('toggleChunk', { id: f.run.chunks[0].id, checked: true });
    await f.controller.handle('openProject', { id: second.id });
    assert.equal(f.controller.state.project.id, second.id);
    assert.equal(f.controller.state.run, null);
    assert.deepEqual(f.controller.state.selectedIds, []);
    await f.controller.handle('backProjects');
    assert.equal(f.controller.state.project, null);
    assert.equal(f.controller.state.projects.length, 2);
    f.controller.destroy();
});
