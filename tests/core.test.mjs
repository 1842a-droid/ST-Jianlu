import test from 'node:test';
import assert from 'node:assert/strict';
import { createRepository } from '../store.js';
import { createQueue } from '../queue.js';
import { splitText, splitByChapters, findChapters } from '../chunker.js';

function memory() {
    const files = new Map();
    let fault = null;
    return {
        files,
        failWhen(predicate) { fault = predicate; },
        async read(name) { return files.get(name) ?? null; },
        async write(name, value) { if (fault?.(name, value)) throw new Error('磁盘写入失败'); files.set(name, value); },
        async remove(name) { files.delete(name); },
    };
}
function hostMock(generate = async snapshot => ({ text: `<answer>${snapshot.input}</answer>` })) {
    let version = 1;
    const captures = [];
    const calls = [];
    return {
        captures, calls,
        setVersion(value) { version = value; },
        async capture(input, options) { const value = { input, options, profile: { presetName: `预设${version}` }, messages: [{ role: 'user', content: input }] }; captures.push(value); return value; },
        async generate(snapshot, options) { calls.push(snapshot); return generate(snapshot, options); },
    };
}
async function setup(text = 'abcdefghijkl') {
    const backend = memory();
    const repo = createRepository(backend);
    const project = await repo.createProject({ title: '小说甲', sourceName: '甲.txt', sourceText: text });
    return { backend, repo, project };
}
async function until(predicate) {
    for (let index = 0; index < 200; index++) {
        if (predicate()) return;
        await new Promise(resolve => setImmediate(resolve));
    }
    throw new Error('等待条件超时');
}

test('分块覆盖全文、重叠推进且不拆开 UTF-16 代理对', () => {
    const text = '第一章 起点\n甲😀乙\n\n第二章 深处\n丙🧭丁\n第三章\n尾声';
    for (const size of [2, 4, 9, 13]) {
        const chunks = splitText(text, { size, overlap: size - 1 });
        assert.equal(chunks[0].start, 0);
        assert.equal(chunks.at(-1).end, text.length);
        for (let index = 0; index < chunks.length; index++) {
            const chunk = chunks[index];
            assert.ok(chunk.end > chunk.start);
            assert.equal(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(text.slice(chunk.start, chunk.end)), false);
            if (index) {
                assert.ok(chunk.start > chunks[index - 1].start);
                assert.ok(chunk.start <= chunks[index - 1].end);
            }
        }
    }
    assert.throws(() => splitText(text, { size: 5, overlap: 5 }), /重叠/);
    assert.deepEqual(splitText(''), []);
});

test('项目隔离；旧任务使用冻结原文；正文不进入项目元数据', async () => {
    const { repo, project, backend } = await setup();
    const host = hostMock();
    const queue = createQueue({ repo, host });
    const run = await queue.plan({ projectId: project.id, chunkSize: 4, overlap: 0 });
    const second = await repo.createProject({ title: '小说乙', sourceText: '第二部原文' });
    await repo.setSource(project.id, '修改后的原文', '新版.txt');
    await queue.run(run.id);
    assert.equal(host.captures.map(value => value.input).join(''), 'abcdefghijkl');
    assert.equal(await repo.getSource(project.id), '修改后的原文');
    assert.equal(await repo.getSource(second.id), '第二部原文');
    assert.equal((await repo.listRuns(second.id)).length, 0);
    assert.equal(backend.files.get(`jl-project-${project.id}.json`).includes('abcdefghijkl'), false);
});

test('中间失败保留其余成果；默认继续不重做失败；明确重试仅该块并有序合并', async () => {
    const { repo, project } = await setup();
    let fail = true;
    const host = hostMock(async snapshot => { if (snapshot.input === 'efgh' && fail) throw new Error('接口暂时失败'); return { text: snapshot.input.toUpperCase() }; });
    const queue = createQueue({ repo, host });
    const run = await queue.plan({ projectId: project.id, chunkSize: 4, overlap: 0 });
    await queue.run(run.id);
    assert.deepEqual((await repo.listChunks(run.id)).map(chunk => chunk.status), ['done', 'failed', 'done']);
    await queue.run(run.id);
    assert.equal(host.calls.length, 3);
    fail = false;
    host.setVersion(2);
    await queue.run(run.id, { ids: [run.chunks[1].id] });
    assert.equal(host.calls.length, 4);
    assert.equal(host.captures.length, 3);
    assert.equal(host.calls.at(-1).profile.presetName, '预设1');
    const merged = await queue.merge(run.id);
    assert.equal(merged.text, 'ABCD\n\nEFGH\n\nIJKL');
    assert.equal(merged.incomplete, false);
    await queue.run(run.id, { ids: [run.chunks[0].id], force: true, freshPreset: true });
    assert.equal(host.calls.at(-1).profile.presetName, '预设2');
});

test('非协作请求在暂停后迟到，不能覆盖暂停状态或产生新请求', async () => {
    const { repo, project } = await setup();
    let finish;
    const host = hostMock(() => new Promise(resolve => { finish = resolve; }));
    const queue = createQueue({ repo, host });
    const run = await queue.plan({ projectId: project.id, chunkSize: 4, overlap: 0 });
    const running = queue.run(run.id);
    await until(() => Boolean(finish));
    await queue.pause();
    await running;
    finish({ text: '迟到的结果' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await repo.getChunk(run.id, run.chunks[0].id)).status, 'paused');
    assert.equal((await repo.getChunk(run.id, run.chunks[0].id)).output, '');
    assert.equal(host.calls.length, 1);
    assert.equal(queue.current(), null);
});

test('单 runner 在首次异步读取前锁定，跨项目并发被拒绝', async () => {
    const { repo, project } = await setup();
    const queue = createQueue({ repo, host: hostMock() });
    const second = await repo.createProject({ title: '乙', sourceText: '另一部' });
    const firstRun = await queue.plan({ projectId: project.id, chunkSize: 4, overlap: 0 });
    const secondRun = await queue.plan({ projectId: second.id, chunkSize: 4, overlap: 0 });
    const running = queue.run(firstRun.id);
    await assert.rejects(queue.run(secondRun.id), /已有任务/);
    await running;
});

test('重启恢复 running 为 paused，保留已完成输出及实际请求', async () => {
    const { repo, project, backend } = await setup();
    const queue = createQueue({ repo, host: hostMock() });
    const run = await queue.plan({ projectId: project.id, chunkSize: 4, overlap: 0 });
    let first = await repo.getChunk(run.id, run.chunks[0].id);
    first.status = 'done'; first.output = '完成成果';
    await repo.saveChunk(run.id, first);
    const second = await repo.getChunk(run.id, run.chunks[1].id);
    second.status = 'running'; second.snapshot = { requestMessages: [{ role: 'user', content: '真实请求' }] };
    await repo.saveChunk(run.id, second);
    const restartRepo = createRepository(backend);
    await createQueue({ repo: restartRepo, host: hostMock() }).recover();
    first = await restartRepo.getChunk(run.id, first.id);
    assert.equal(first.status, 'done'); assert.equal(first.output, '完成成果');
    assert.equal((await restartRepo.getChunk(run.id, second.id)).status, 'paused');
    assert.equal((await restartRepo.getChunk(run.id, second.id)).snapshot.requestMessages[0].content, '真实请求');
});

test('持久化失败不能开始付费请求，索引损坏不当空库处理', async () => {
    const { repo, project, backend } = await setup();
    const host = hostMock();
    const queue = createQueue({ repo, host });
    const run = await queue.plan({ projectId: project.id, chunkSize: 4, overlap: 0 });
    backend.failWhen(name => name.startsWith('jl-chunk-'));
    await assert.rejects(queue.run(run.id), /磁盘写入失败/);
    assert.equal(host.calls.length, 0);
    assert.equal(queue.current(), null);
    backend.failWhen(null);
    backend.files.set('jl-index-v1.json', '损坏');
    await assert.rejects(repo.listProjects(), /无法解析/);
    backend.files.set('jl-index-v1.json', JSON.stringify({ version: 9, projects: [] }));
    await assert.rejects(repo.listProjects(), /索引格式/);
});

test('空输出失败；任意格式原样保存；截断成果保留且不自动重做', async () => {
    const { repo, project } = await setup();
    const host = hostMock(async snapshot => snapshot.input === 'abcd' ? { text: '' } : snapshot.input === 'efgh' ? { text: '{未完', finishReason: 'MAX_TOKENS' } : { text: '[]' });
    const queue = createQueue({ repo, host });
    const run = await queue.plan({ projectId: project.id, chunkSize: 4, overlap: 0 });
    await queue.run(run.id);
    const chunks = await repo.listChunks(run.id);
    assert.deepEqual(chunks.map(chunk => chunk.status), ['failed', 'partial', 'done']);
    assert.equal((await repo.getChunk(run.id, chunks[1].id)).output, '{未完');
    assert.equal((await queue.merge(run.id)).text, '[]');
    assert.equal((await queue.merge(run.id, { includePartial: true })).text, '{未完\n\n[]');
    await queue.run(run.id);
    assert.equal(host.calls.length, 3);
});

test('host 在失败时更新的实际请求快照仍保存', async () => {
    const { repo, project } = await setup('原文');
    const host = hostMock(async snapshot => { snapshot.requestMessages = [{ role: 'system', content: '实际启用条目' }, { role: 'user', content: snapshot.input }]; throw new Error('HTTP 503'); });
    const queue = createQueue({ repo, host });
    const run = await queue.plan({ projectId: project.id, chunkSize: 4, overlap: 0 });
    await queue.run(run.id);
    const chunk = await repo.getChunk(run.id, run.chunks[0].id);
    assert.equal(chunk.status, 'failed');
    assert.equal(chunk.snapshot.requestMessages[0].content, '实际启用条目');
});

test('结果或粘贴材料可作为独立任务输入，保持当前小说不变', async () => {
    const { repo, project } = await setup('小说本体');
    const host = hostMock();
    const queue = createQueue({ repo, host });
    const run = await queue.plan({ projectId: project.id, chunkSize: 100, overlap: 0, inputText: '需要复核的内容', inputName: '上次结果', sourceKind: 'result' });
    assert.equal(await repo.getSource(project.id), '小说本体');
    await queue.run(run.id);
    assert.equal(host.calls[0].input, '需要复核的内容');
    assert.equal(run.sourceKind, 'result');
    assert.equal((await repo.exportProject(project.id)).sources[run.sourceFile], '需要复核的内容');
});

test('粘贴计划不读取小说原文，无效切分或输入类型不写入孤立材料', async () => {
    const { repo, project, backend } = await setup('不应读取的小说原文');
    const reads = [];
    const originalRead = backend.read.bind(backend);
    backend.read = async name => { reads.push(name); return originalRead(name); };
    const queue = createQueue({ repo, host: hostMock() });
    await queue.plan({ projectId: project.id, inputText: '独立粘贴材料', sourceKind: 'paste', chunkSize: 4, overlap: 0 });
    assert.equal(reads.includes(project.sourceFile), false);
    const sourceCount = () => [...backend.files.keys()].filter(name => name.startsWith('jl-source-')).length;
    const before = sourceCount();
    await assert.rejects(queue.plan({ projectId: project.id, inputText: '错误分块材料', sourceKind: 'paste', chunkSize: 0, overlap: 0 }), /分块长度/);
    await assert.rejects(queue.plan({ projectId: project.id, inputText: '', sourceKind: 'paste', chunkSize: 4, overlap: 0 }), /没有可处理/);
    await assert.rejects(queue.plan({ projectId: project.id, inputText: '错误类型材料', sourceKind: 'invalid', chunkSize: 4, overlap: 0 }), /输入类型/);
    assert.equal(sourceCount(), before);
    assert.equal(reads.includes(project.sourceFile), false);
});

test('备份导入重映射全部标识、不覆盖现有数据，且不导出凭据', async () => {
    const { repo, project } = await setup('独立小说');
    const host = hostMock(async snapshot => ({ text: '任意结果', profile: { apiKey: '不应保存', presetName: snapshot.profile.presetName } }));
    const queue = createQueue({ repo, host });
    const run = await queue.plan({ projectId: project.id, chunkSize: 6, overlap: 0 });
    await queue.run(run.id);
    const backup = await repo.exportProject(project.id);
    assert.equal(JSON.stringify(backup).includes('不应保存'), false);
    const imported = await repo.importProject(backup);
    assert.notEqual(imported.id, project.id);
    assert.equal((await repo.listProjects()).length, 2);
    assert.notEqual(imported.runs[0].id, run.id);
    const importedRun = await repo.getRun(imported.runs[0].id);
    assert.notEqual(importedRun.chunks[0].id, run.chunks[0].id);
    assert.equal(importedRun.projectId, imported.id);
    assert.equal((await queue.merge(importedRun.id)).text, (await queue.merge(run.id)).text);
    assert.equal(await repo.getSource(imported.id), '独立小说');
    const broken = structuredClone(backup);
    broken.runs[0].chunks.pop();
    await assert.rejects(repo.importProject(broken), /不完整/);
    assert.equal((await repo.listProjects()).length, 2);
});

test('索引写入失败不会误报项目创建成功', async () => {
    const backend = memory();
    backend.failWhen(name => name === 'jl-index-v1.json');
    const repo = createRepository(backend);
    await assert.rejects(repo.createProject({ title: '未成功', sourceText: '文本' }), /磁盘写入失败/);
    backend.failWhen(null);
    assert.deepEqual(await repo.listProjects(), []);
});

test('成果已写入但任务元数据保存失败，恢复时保留成果而非重跑', async () => {
    const { repo, project, backend } = await setup('小说');
    const host = hostMock();
    const queue = createQueue({ repo, host });
    const run = await queue.plan({ projectId: project.id, chunkSize: 10, overlap: 0 });
    backend.failWhen(name => name === `jl-run-${run.id}.json` && host.calls.length > 0);
    await assert.rejects(queue.run(run.id), /磁盘写入失败/);
    backend.failWhen(null);
    await queue.recover(project.id);
    const recovered = await repo.getRun(run.id);
    assert.equal(recovered.status, 'done');
    assert.equal(recovered.chunks[0].status, 'done');
    await queue.run(run.id);
    assert.equal(host.calls.length, 1);
});

test('已完成块的成果文件丢失时显式报错，不伪装为空成果', async () => {
    const { repo, project, backend } = await setup('小说');
    const queue = createQueue({ repo, host: hostMock() });
    const run = await queue.plan({ projectId: project.id, chunkSize: 10, overlap: 0 });
    await queue.run(run.id);
    backend.files.delete(`jl-chunk-${run.id}-${run.chunks[0].id}.json`);
    await assert.rejects(queue.merge(run.id), /成果文件不存在/);
});

test('手动保存最后失败块为完成时同步更新任务与项目总状态', async () => {
    const { repo, project } = await setup('原文');
    const queue = createQueue({ repo, host: hostMock(async () => { throw new Error('接口失败'); }) });
    const run = await queue.plan({ projectId: project.id, chunkSize: 10, overlap: 0 });
    await queue.run(run.id);
    assert.equal((await repo.getRun(run.id)).status, 'failed');
    const chunk = await repo.getChunk(run.id, run.chunks[0].id);
    chunk.output = '手动修复的成果'; chunk.status = 'done'; chunk.manual = true;
    await repo.saveChunk(run.id, chunk);
    assert.equal((await repo.getRun(run.id)).status, 'done');
    assert.equal((await repo.listRuns(project.id))[0].status, 'done');
    assert.equal((await repo.listRuns(project.id))[0].counts.done, 1);
});

test('轻恢复跳过稳定任务的全部成果文件，显式完整审计可对齐手动半提交', async () => {
    const { repo, project, backend } = await setup('原文');
    const host = hostMock(async () => { throw new Error('模型失败'); });
    const queue = createQueue({ repo, host });
    const run = await queue.plan({ projectId: project.id, chunkSize: 10, overlap: 0 });
    await queue.run(run.id);
    const chunk = await repo.getChunk(run.id, run.chunks[0].id);
    chunk.status = 'done'; chunk.output = '手动完成';
    backend.failWhen(name => name === `jl-run-${run.id}.json`);
    await assert.rejects(repo.saveChunk(run.id, chunk), /磁盘写入失败/);
    backend.failWhen(null);
    const reads = [];
    const originalRead = backend.read.bind(backend);
    backend.read = async name => { reads.push(name); return originalRead(name); };
    await queue.recover(project.id);
    assert.equal(reads.filter(name => name.startsWith('jl-chunk-')).length, 0);
    assert.equal((await repo.getRun(run.id)).status, 'failed');
    await queue.recover(project.id, { fullAudit: true });
    assert.equal((await repo.getRun(run.id)).status, 'done');
});

test('失败索引指向实际已完成成果时，明确重试也先修复索引并跳过付费', async () => {
    const { repo, project, backend } = await setup('原文');
    const host = hostMock(async () => { throw new Error('模型失败'); });
    const queue = createQueue({ repo, host });
    const run = await queue.plan({ projectId: project.id, chunkSize: 10, overlap: 0 });
    await queue.run(run.id);
    const chunk = await repo.getChunk(run.id, run.chunks[0].id);
    chunk.status = 'done'; chunk.output = '手动完成';
    backend.failWhen(name => name === `jl-run-${run.id}.json`);
    await assert.rejects(repo.saveChunk(run.id, chunk), /磁盘写入失败/);
    backend.failWhen(null);
    assert.equal((await repo.getRun(run.id)).chunks[0].status, 'failed');
    await queue.run(run.id, { ids: [chunk.id] });
    assert.equal(host.calls.length, 1);
    assert.equal((await repo.getRun(run.id)).status, 'done');
    assert.equal((await repo.getChunk(run.id, chunk.id)).output, '手动完成');
});

test('识别紧邻标题、中文数字、英文与卷篇标题，分组不丢开头序言', () => {
    const text = '作品简介\n作者说明\n\n第998章紫剑的来由\n甲😀\n\n  第九百九十九章云起\n乙\nCHAPTER IV: The Return\n丙\n卷五归途\n丁\n第二篇新篇\n戊';
    const chapters = findChapters(text);
    assert.deepEqual(chapters.map(chapter => chapter.label), ['第998章紫剑的来由', '第九百九十九章云起', 'CHAPTER IV: The Return', '卷五归途', '第二篇新篇']);
    assert.deepEqual(chapters.map(chapter => chapter.index), [0, 1, 2, 3, 4]);
    assert.equal(chapters[0].start, 0);
    assert.equal(chapters.map(chapter => text.slice(chapter.start, chapter.end)).join(''), text);
    const groups = splitByChapters(text, { chaptersPerChunk: 2 });
    assert.deepEqual(groups.map(group => [group.chapterStart, group.chapterEnd]), [[1, 2], [3, 4], [5, 5]]);
    assert.equal(groups.map(group => text.slice(group.start, group.end)).join(''), text);
    for (let index = 1; index < groups.length; index++) assert.equal(groups[index].start, groups[index - 1].end);
    assert.equal(findChapters('Chapter One\n正文\nChapter Two The Way\n结尾').length, 2);
});

test('按识别章序号或字符范围选完整章，不暗中拆开长章节，无章节时明确报错', () => {
    const long = '第一章长章\n' + '甲'.repeat(15000) + '\n第二章续章\n乙\n第三章终章\n丙';
    const chapters = findChapters(long);
    const all = splitByChapters(long);
    assert.equal(all.length, 3);
    assert.ok(all[0].end - all[0].start > 15000);
    const selected = splitByChapters(long, { chapterStart: 2, chapterEnd: 3 });
    assert.equal(selected[0].start, chapters[1].start);
    assert.equal(selected.at(-1).end, long.length);
    const characterRange = splitByChapters(long, { start: chapters[1].start + 2, end: chapters[2].start + 2 });
    assert.deepEqual(characterRange.map(chunk => [chunk.start, chunk.end]), selected.map(chunk => [chunk.start, chunk.end]));
    assert.throws(() => splitByChapters('没有标题的正文'), /未识别到章节标题/);
    assert.throws(() => splitByChapters(long, { chaptersPerChunk: 0 }), /正整数/);
    assert.throws(() => splitByChapters(long, { chapterStart: 0 }), /章节范围/);
    assert.throws(() => splitByChapters(long, { chapterEnd: 4 }), /章节范围/);
    assert.throws(() => splitByChapters(long, { chapterStart: 3, chapterEnd: 2 }), /章节范围/);
    assert.ok(splitText('没有标题的正文', { size: 4, overlap: 0 }).length > 1);
});

test('章节计划保存方式、分组与范围，按章忽略字数重叠且兼容旧任务', async () => {
    const text = '介绍\n第998章紫剑的来由\n甲\n第999章归途\n乙\nChapter 1000 Return\n丙';
    const { repo, project } = await setup(text);
    const host = hostMock();
    const queue = createQueue({ repo, host });
    const run = await queue.plan({ projectId: project.id, splitMode: 'chapters', chaptersPerChunk: 2, chapterStart: 2, chapterEnd: 3, chunkSize: 2, overlap: 9999 });
    assert.equal(run.splitMode, 'chapters');
    assert.equal(run.chaptersPerChunk, 2);
    assert.equal(run.chapterStart, 2); assert.equal(run.chapterEnd, 3);
    assert.equal(run.chunks.length, 1); assert.equal(run.overlap, 0);
    await queue.run(run.id);
    assert.equal(host.calls[0].input, text.slice(findChapters(text)[1].start));
    assert.equal((await repo.getRun(run.id)).chunks[0].chapterStart, 2);
    const legacy = await queue.plan({ projectId: project.id, chunkSize: 15, overlap: 0 });
    delete legacy.splitMode;
    await repo.saveRun(legacy);
    await queue.run(legacy.id);
    assert.equal((await repo.getRun(legacy.id)).status, 'done');
});

test('删除所选块持久保存并重排索引，保留其余块 ID、范围和成果，备份导入一致', async () => {
    const { backend, repo, project } = await setup();
    const host = hostMock();
    const queue = createQueue({ repo, host });
    const run = await queue.plan({ projectId: project.id, chunkSize: 4, overlap: 0 });
    await queue.run(run.id);
    const lastBefore = await repo.getChunk(run.id, run.chunks[2].id);
    const deleted = run.chunks[1].id;
    const updated = await repo.deleteChunks(run.id, [deleted, deleted]);
    assert.deepEqual(updated.chunks.map(chunk => chunk.id), [run.chunks[0].id, run.chunks[2].id]);
    assert.deepEqual(updated.chunks.map(chunk => chunk.index), [0, 1]);
    assert.equal(backend.files.has(`jl-chunk-${run.id}-${deleted}.json`), false);
    const reopenedRepo = createRepository(backend);
    const reopened = await reopenedRepo.getRun(run.id);
    const last = await reopenedRepo.getChunk(run.id, lastBefore.id);
    assert.equal(last.index, 1);
    for (const key of ['id', 'start', 'end', 'label', 'output']) assert.equal(last[key], lastBefore[key]);
    assert.equal(reopened.status, 'done');
    assert.equal((await reopenedRepo.listRuns(project.id))[0].counts.done, 2);
    assert.equal(await reopenedRepo.readSourceFile(run.sourceFile), 'abcdefghijkl');
    const merge = await createQueue({ repo: reopenedRepo, host }).merge(run.id);
    assert.equal(merge.text, '<answer>abcd</answer>\n\n<answer>ijkl</answer>');
    const backup = await reopenedRepo.exportProject(project.id);
    assert.equal(backup.runs[0].chunks.length, 2);
    const imported = await reopenedRepo.importProject(backup);
    const importedRun = await reopenedRepo.getRun(imported.runs[0].id);
    assert.equal(importedRun.chunks.length, 2);
    assert.deepEqual(importedRun.chunks.map(chunk => chunk.index), [0, 1]);
    assert.ok(importedRun.chunks.every(chunk => !run.chunks.some(old => old.id === chunk.id)));
    assert.deepEqual(importedRun.pendingChunkDeletes, []);
    assert.equal((await createQueue({ repo: reopenedRepo, host }).merge(importedRun.id)).text, merge.text);
    await assert.rejects(repo.saveRun(run), /分块已删除/);
});

test('删除仅限当前任务并保护 running 状态，不影响其他任务和项目', async () => {
    const { repo, project, backend } = await setup();
    const queue = createQueue({ repo, host: hostMock() });
    const first = await queue.plan({ projectId: project.id, chunkSize: 4, overlap: 0 });
    const second = await queue.plan({ projectId: project.id, chunkSize: 6, overlap: 0 });
    const otherProject = await repo.createProject({ title: '另一部', sourceText: '别的小说正文' });
    const other = await queue.plan({ projectId: otherProject.id, chunkSize: 4, overlap: 0 });
    await assert.rejects(repo.deleteChunks(first.id, [second.chunks[0].id]), /不属于此任务/);
    await repo.deleteChunks(first.id, [first.chunks[0].id]);
    assert.equal((await repo.getRun(second.id)).chunks.length, 2);
    assert.equal((await repo.getRun(other.id)).chunks.length, other.chunks.length);
    assert.equal(await repo.getSource(otherProject.id), '别的小说正文');
    let running = await repo.getChunk(second.id, second.chunks[0].id);
    running.status = 'running';
    await repo.saveChunk(second.id, running);
    await assert.rejects(repo.deleteChunks(second.id, [running.id]), /请先暂停/);
    // Simulate a first-attempt detail file committed just before its manifest write failed.
    const stale = JSON.parse(backend.files.get(`jl-run-${second.id}.json`));
    stale.status = 'pending'; stale.chunks[0].status = 'pending';
    backend.files.set(`jl-run-${second.id}.json`, JSON.stringify(stale));
    await assert.rejects(repo.deleteChunks(second.id, [running.id]), /正在处理/);
    assert.equal((await repo.getRun(second.id)).chunks.length, 2);
});

test('删除空任务可重开和合并，旧成果不复活且没有隐式模型调用', async () => {
    const { repo, project, backend } = await setup();
    const host = hostMock();
    const queue = createQueue({ repo, host });
    const run = await queue.plan({ projectId: project.id, chunkSize: 4, overlap: 0 });
    await queue.run(run.id);
    const updated = await repo.deleteChunks(run.id, run.chunks.map(chunk => chunk.id));
    assert.deepEqual(updated.chunks, []);
    const reopened = createRepository(backend);
    const resumed = createQueue({ repo: reopened, host });
    await resumed.recover(project.id);
    const merged = await resumed.merge(run.id);
    assert.equal(merged.text, ''); assert.equal(merged.incomplete, false); assert.equal(merged.counts.total, 0);
    await resumed.run(run.id);
    assert.equal(host.calls.length, 3);
    assert.deepEqual((await reopened.exportProject(project.id)).runs[0].chunks, []);
    assert.equal(await reopened.getSource(project.id), 'abcdefghijkl');
});

test('删除先提交 manifest 再清理文件，清理失败可重试且其余成果不丢失', async () => {
    const { repo, project, backend } = await setup();
    const queue = createQueue({ repo, host: hostMock() });
    const run = await queue.plan({ projectId: project.id, chunkSize: 4, overlap: 0 });
    await queue.run(run.id);
    const deleted = run.chunks[1].id;
    const oldRemove = backend.remove.bind(backend);
    let fail = true;
    backend.remove = async name => {
        const manifest = JSON.parse(backend.files.get(`jl-run-${run.id}.json`));
        assert.equal(manifest.chunks.some(chunk => chunk.id === deleted), false);
        if (fail && name === `jl-chunk-${run.id}-${deleted}.json`) throw new Error('删除文件失败');
        return oldRemove(name);
    };
    await assert.rejects(repo.deleteChunks(run.id, [deleted]), error => error.cleanupPending === true);
    const saved = await repo.getRun(run.id);
    assert.deepEqual(saved.pendingChunkDeletes, [deleted]);
    assert.equal(saved.chunks.length, 2);
    assert.equal((await queue.merge(run.id)).counts.done, 2);
    fail = false;
    await repo.deleteChunks(run.id, [deleted]);
    assert.equal(backend.files.has(`jl-chunk-${run.id}-${deleted}.json`), false);
    assert.deepEqual((await repo.getRun(run.id)).pendingChunkDeletes, []);
});

test('删除 manifest 写入失败时不删除任何成果文件', async () => {
    const { repo, project, backend } = await setup();
    const queue = createQueue({ repo, host: hostMock() });
    const run = await queue.plan({ projectId: project.id, chunkSize: 4, overlap: 0 });
    await queue.run(run.id);
    backend.failWhen(name => name === `jl-run-${run.id}.json`);
    await assert.rejects(repo.deleteChunks(run.id, [run.chunks[1].id]), /磁盘写入失败/);
    backend.failWhen(null);
    assert.equal((await repo.getRun(run.id)).chunks.length, 3);
    for (const chunk of run.chunks) assert.equal(backend.files.has(`jl-chunk-${run.id}-${chunk.id}.json`), true);
});
