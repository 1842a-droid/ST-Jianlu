const INDEX = 'jl-index-v1.json';
const ID_PATTERN = /^[a-zA-Z0-9_-]{1,100}$/;
const FILE_PATTERN = /^jl-[a-zA-Z0-9_.-]+\.(?:json|txt)$/;
const STATES = new Set(['pending', 'running', 'done', 'failed', 'paused', 'partial']);
const now = () => new Date().toISOString();
const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
export const newId = () => globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;

function id(value) {
    if (typeof value !== 'string' || !ID_PATTERN.test(value)) throw new Error('数据标识无效');
    return value;
}
function safeFile(name) {
    if (typeof name !== 'string' || !FILE_PATTERN.test(name)) throw new Error('文件标识无效');
    return name;
}
const projectFile = projectId => `jl-project-${id(projectId)}.json`;
const runFile = runId => `jl-run-${id(runId)}.json`;
const chunkFile = (runId, chunkId) => `jl-chunk-${id(runId)}-${id(chunkId)}.json`;

function withoutSecrets(value) {
    if (Array.isArray(value)) return value.map(withoutSecrets);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
        .filter(([key]) => !/^(?:api[_-]?key|authorization|password|access[_-]?token|refresh[_-]?token|secret|credential)$/i.test(key))
        .map(([key, item]) => [key, withoutSecrets(item)]));
    return value;
}
function projectMeta(project) {
    return { id: project.id, title: project.title, sourceName: project.sourceName, length: project.length, createdAt: project.createdAt, updatedAt: project.updatedAt, runCount: project.runs?.length || 0 };
}
function runMeta(run) {
    const counts = Object.fromEntries([...STATES].map(status => [status, 0]));
    for (const chunk of run.chunks || []) counts[chunk.status in counts ? chunk.status : 'pending']++;
    return { id: run.id, projectId: run.projectId, title: run.title, createdAt: run.createdAt, updatedAt: run.updatedAt, status: run.status, total: run.chunks.length, counts };
}
function chunkMeta(chunk) {
    return { id: chunk.id, index: chunk.index, label: chunk.label, start: chunk.start, end: chunk.end, status: chunk.status, attempts: chunk.attempts || 0, error: chunk.error || '', outputLength: String(chunk.output || '').length, finishReason: chunk.finishReason || '', updatedAt: chunk.updatedAt,
        ...(Number.isInteger(chunk.chapterStart) ? { chapterStart: chunk.chapterStart, chapterEnd: chunk.chapterEnd } : {}) };
}
function statusFor(chunks) {
    if (chunks.some(chunk => chunk.status === 'running')) return 'running';
    if (chunks.length && chunks.every(chunk => chunk.status === 'done')) return 'done';
    if (chunks.some(chunk => chunk.status === 'failed')) return 'failed';
    if (chunks.some(chunk => chunk.status === 'partial')) return 'partial';
    if (chunks.some(chunk => chunk.status === 'paused')) return 'paused';
    return 'pending';
}
function validateRange(chunk, length) {
    if (!chunk || !Number.isInteger(chunk.start) || !Number.isInteger(chunk.end) || chunk.start < 0 || chunk.end <= chunk.start || chunk.end > length) throw new Error('分块原文范围无效');
}

/** Data is saved in user-scoped SillyTavern files, not extension settings. */
export function createRepository(backend) {
    if (!backend?.read || !backend?.write || !backend?.remove) throw new Error('存储后端不可用');
    let chain = Promise.resolve();
    const serial = fn => {
        const result = chain.then(fn);
        chain = result.catch(() => {});
        return result;
    };
    const after = async fn => { await chain; return fn(); };
    const readText = name => backend.read(safeFile(name));
    const writeText = (name, text) => backend.write(safeFile(name), String(text));
    const remove = name => backend.remove(safeFile(name));
    async function readJson(name, required = true) {
        const text = await readText(name);
        if (text === null || text === undefined) {
            if (required) throw new Error(`数据文件不存在：${name}`);
            return null;
        }
        try { return JSON.parse(text); }
        catch { throw new Error(`数据文件无法解析：${name}`); }
    }
    const writeJson = (name, data) => writeText(name, JSON.stringify(withoutSecrets(data)));
    async function readIndex() {
        const data = await readJson(INDEX, false);
        if (data === null) return { version: 1, projects: [] };
        if (data.version !== 1 || !Array.isArray(data.projects)) throw new Error('项目索引格式无效');
        for (const project of data.projects) id(project.id);
        return data;
    }
    async function readProject(projectId) {
        const project = await readJson(projectFile(projectId));
        if (project.id !== projectId || !Array.isArray(project.runs) || !Array.isArray(project.sourceFiles)) throw new Error('项目数据格式无效');
        safeFile(project.sourceFile);
        if (!project.sourceFiles.includes(project.sourceFile) || !Number.isInteger(project.length) || project.length < 0 || project.sourceFiles.some(file => typeof file !== 'string' || !file.startsWith(`jl-source-${projectId}-`) || !FILE_PATTERN.test(file))) throw new Error('项目原文索引无效');
        for (const run of project.runs) id(run.id);
        return project;
    }
    async function readRun(runId) {
        const run = await readJson(runFile(runId));
        if (run.id !== runId || !Array.isArray(run.chunks) || !STATES.has(run.status) || !Number.isInteger(run.sourceLength) || run.sourceLength < 0) throw new Error('任务数据格式无效');
        id(run.projectId); safeFile(run.sourceFile);
        return run;
    }
    async function updateIndex(project, deleting = false) {
        const index = await readIndex();
        index.projects = index.projects.filter(item => item.id !== project.id);
        if (!deleting) index.projects.push(projectMeta(project));
        index.updatedAt = now();
        await writeJson(INDEX, index);
    }
    async function persistProject(project) {
        await writeJson(projectFile(project.id), project);
        await updateIndex(project);
        return copy(project);
    }
    async function persistRun(run) {
        await writeJson(runFile(run.id), run);
        const project = await readProject(run.projectId);
        const index = project.runs.findIndex(item => item.id === run.id);
        if (index < 0) project.runs.push(runMeta(run)); else project.runs[index] = runMeta(run);
        if (!project.sourceFiles.includes(run.sourceFile)) project.sourceFiles.push(run.sourceFile);
        project.updatedAt = now();
        await persistProject(project);
        return copy(run);
    }
    async function createProjectInternal({ title, sourceName = '', sourceText = '' }) {
        if (typeof sourceText !== 'string') throw new Error('小说原文必须是文本');
        const projectId = newId();
        const sourceFile = `jl-source-${projectId}-${newId()}.txt`;
        const project = { id: projectId, title: String(title || sourceName || '未命名小说').trim() || '未命名小说', sourceName: String(sourceName || ''), sourceFile, sourceFiles: [sourceFile], length: sourceText.length, createdAt: now(), updatedAt: now(), runs: [] };
        await writeText(sourceFile, sourceText);
        return persistProject(project);
    }
    async function readChunk(runId, chunkId, knownRun) {
        const run = knownRun?.id === runId ? knownRun : await readRun(runId);
        const meta = run.chunks.find(item => item.id === chunkId);
        if (!meta) throw new Error('分块不存在');
        const data = await readJson(chunkFile(runId, chunkId), false);
        if (data === null) {
            if (meta.status !== 'pending' || Number(meta.attempts || 0) !== 0) throw new Error('分块成果文件不存在');
            return { ...meta, runId, output: '', attempts: 0 };
        }
        if (data.id !== chunkId || data.runId !== runId) throw new Error('分块数据标识不匹配');
        if (!STATES.has(data.status) || data.start !== meta.start || data.end !== meta.end) throw new Error('分块数据格式无效');
        // The manifest owns display order; deleting a block need not rewrite every retained result.
        return { ...data, index: meta.index };
    }
    const api = {
        listProjects: () => after(async () => copy((await readIndex()).projects).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))),
        createProject: options => serial(() => createProjectInternal(options || {})),
        getProject: projectId => after(() => readProject(projectId)),
        updateProject: (projectId, patch) => serial(async () => {
            const project = await readProject(projectId);
            for (const key of ['title', 'settings', 'archived']) if (Object.hasOwn(patch || {}, key)) project[key] = copy(patch[key]);
            if (typeof project.title !== 'string' || !project.title.trim()) throw new Error('项目名称不能为空');
            project.updatedAt = now();
            return persistProject(project);
        }),
        getSource: projectId => after(async () => {
            const project = await readProject(projectId);
            const text = await readText(project.sourceFile);
            if (text === null || text === undefined) throw new Error('小说原文不存在');
            return text;
        }),
        readSourceFile: sourceFile => after(async () => {
            if (!/^jl-source-[a-zA-Z0-9_-]+\.txt$/.test(sourceFile)) throw new Error('原文文件标识无效');
            const text = await readText(sourceFile);
            if (text === null || text === undefined) throw new Error('任务原文不存在');
            return text;
        }),
        setSource: (projectId, text, name) => serial(async () => {
            if (typeof text !== 'string') throw new Error('小说原文必须是文本');
            const project = await readProject(projectId);
            const sourceFile = `jl-source-${projectId}-${newId()}.txt`;
            await writeText(sourceFile, text);
            project.sourceFile = sourceFile;
            project.sourceFiles.push(sourceFile);
            project.length = text.length;
            if (name !== undefined) project.sourceName = String(name);
            project.updatedAt = now();
            return persistProject(project);
        }),
        createSource: (projectId, text, name = '') => serial(async () => {
            if (typeof text !== 'string') throw new Error('输入材料必须是文本');
            const project = await readProject(projectId);
            const sourceFile = `jl-source-${projectId}-${newId()}.txt`;
            await writeText(sourceFile, text);
            project.sourceFiles.push(sourceFile);
            project.updatedAt = now();
            await persistProject(project);
            return { sourceFile, length: text.length, sourceName: String(name || '') };
        }),
        deleteProject: projectId => serial(async () => {
            const project = await readProject(projectId);
            // Remove the index last: an interrupted delete is visible and can be retried.
            for (const meta of project.runs) {
                const run = await readJson(runFile(meta.id), false);
                if (run) {
                    if (run.projectId !== projectId) throw new Error('任务归属不匹配');
                    for (const chunkId of new Set([...run.chunks.map(chunk => chunk.id), ...(run.pendingChunkDeletes || [])])) await remove(chunkFile(run.id, chunkId));
                    await remove(runFile(run.id));
                }
            }
            for (const file of new Set(project.sourceFiles)) await remove(file);
            await updateIndex(project, true);
            await remove(projectFile(projectId));
        }),
        listRuns: projectId => after(async () => copy((await readProject(projectId)).runs).sort((a, b) => b.createdAt.localeCompare(a.createdAt))),
        getRun: runId => after(() => readRun(runId)),
        saveRun: run => serial(async () => {
            const value = withoutSecrets(copy(run));
            id(value.id); id(value.projectId); safeFile(value.sourceFile);
            if (!Array.isArray(value.chunks) || !STATES.has(value.status) || !Number.isInteger(value.sourceLength) || value.sourceLength < 0) throw new Error('任务数据格式无效');
            const project = await readProject(value.projectId);
            if (!project.sourceFiles.includes(value.sourceFile)) throw new Error('任务原文不属于此项目');
            const seen = new Set();
            for (const chunk of value.chunks) {
                id(chunk.id); validateRange(chunk, value.sourceLength);
                if (seen.has(chunk.id) || !STATES.has(chunk.status)) throw new Error('分块数据格式无效');
                seen.add(chunk.id);
            }
            const old = await readJson(runFile(value.id), false);
            if (old && old.projectId !== value.projectId) throw new Error('禁止改变任务归属');
            if (old) {
                if (value.chunks.some(chunk => old.deletedChunkIds?.includes(chunk.id))) throw new Error('分块已删除，请刷新任务');
                if (old.deletedChunkIds) value.deletedChunkIds = copy(old.deletedChunkIds);
                if (old.pendingChunkDeletes) value.pendingChunkDeletes = copy(old.pendingChunkDeletes);
            }
            value.updatedAt = now();
            return persistRun(value);
        }),
        getChunk: (runId, chunkId, { run } = {}) => after(() => readChunk(runId, chunkId, run)),
        listChunks: runId => after(async () => copy((await readRun(runId)).chunks).sort((a, b) => a.index - b.index)),
        saveChunk: (runId, chunk) => serial(async () => {
            const run = await readRun(runId);
            const value = withoutSecrets(copy(chunk));
            id(value.id);
            const index = run.chunks.findIndex(item => item.id === value.id);
            if (index < 0 || (value.runId && value.runId !== runId)) throw new Error('分块归属不匹配');
            validateRange(value, run.sourceLength);
            if (value.start !== run.chunks[index].start || value.end !== run.chunks[index].end) throw new Error('禁止改变分块原文范围');
            if (!STATES.has(value.status)) throw new Error('分块状态无效');
            value.runId = runId;
            value.index = run.chunks[index].index;
            value.output = String(value.output || '');
            value.updatedAt = now();
            await writeJson(chunkFile(runId, value.id), value);
            run.chunks[index] = chunkMeta(value);
            run.status = statusFor(run.chunks);
            run.updatedAt = now();
            await persistRun(run);
            return copy(value);
        }),
        deleteChunks: (runId, ids) => serial(async () => {
            if (!Array.isArray(ids)) throw new Error('请选择要删除的分块');
            const selected = new Set(ids.map(id));
            const run = await readRun(runId);
            if (!selected.size) return copy(run);
            const deleted = new Set((run.deletedChunkIds || []).map(id));
            const pending = new Set((run.pendingChunkDeletes || []).map(id));
            const owned = new Set([...run.chunks.map(chunk => chunk.id), ...deleted, ...pending]);
            if ([...selected].some(chunkId => !owned.has(chunkId))) throw new Error('选中的分块不属于此任务');
            if (run.status === 'running' || run.chunks.some(chunk => chunk.status === 'running')) throw new Error('请先暂停任务再删除分块');
            for (const meta of run.chunks.filter(chunk => selected.has(chunk.id))) {
                const chunk = await readJson(chunkFile(runId, meta.id), false);
                if (chunk && (chunk.id !== meta.id || chunk.runId !== runId)) throw new Error('分块数据标识不匹配');
                if (chunk?.status === 'running') throw new Error('请先恢复或暂停正在处理的分块');
            }
            const live = run.chunks.filter(chunk => selected.has(chunk.id));
            for (const chunk of live) { deleted.add(chunk.id); pending.add(chunk.id); }
            if (!live.length && !pending.size) return copy(run);
            run.chunks = run.chunks.filter(chunk => !selected.has(chunk.id)).sort((a, b) => a.index - b.index).map((chunk, index) => ({ ...chunk, index }));
            run.deletedChunkIds = [...deleted];
            run.pendingChunkDeletes = [...pending];
            run.status = statusFor(run.chunks);
            run.updatedAt = now();
            // Commit references first. A failed physical cleanup can never erase a retained block.
            await persistRun(run);
            const failures = [];
            for (const chunkId of pending) {
                try { await remove(chunkFile(runId, chunkId)); }
                catch (error) { failures.push({ chunkId, error }); }
            }
            run.pendingChunkDeletes = failures.map(failure => failure.chunkId);
            await persistRun(run);
            if (failures.length) {
                const error = new Error('分块已从任务移除，部分成果文件清理失败，请重试删除');
                error.cause = failures[0].error;
                error.run = copy(run);
                error.cleanupPending = true;
                throw error;
            }
            return copy(run);
        }),
        exportProject: projectId => after(async () => {
            const project = await readProject(projectId);
            const sources = {};
            for (const file of new Set(project.sourceFiles)) {
                const text = await readText(file);
                if (text === null || text === undefined) throw new Error('备份原文文件不存在');
                sources[file] = text;
            }
            const runs = [];
            for (const meta of project.runs) {
                const run = await readRun(meta.id);
                const chunks = [];
                for (const chunk of run.chunks) chunks.push(await readChunk(run.id, chunk.id, run));
                runs.push({ run, chunks });
            }
            return withoutSecrets({ kind: 'jianlu-project', version: 1, exportedAt: now(), project, sources, runs });
        }),
        importProject: backup => serial(async () => {
            const value = copy(backup);
            if (value?.kind !== 'jianlu-project' || value.version !== 1 || !value.project || !value.sources || !Array.isArray(value.runs)) throw new Error('不是有效的笺录项目备份');
            const original = value.project;
            if (typeof original.title !== 'string' || typeof value.sources[original.sourceFile] !== 'string') throw new Error('项目备份缺少小说原文');
            const sourceNames = Object.keys(value.sources);
            const runIds = new Set(), chunkIds = new Set();
            for (const file of sourceNames) if (typeof value.sources[file] !== 'string') throw new Error('备份原文格式无效');
            for (const entry of value.runs) {
                const run = entry?.run;
                if (!run || !Array.isArray(run.chunks) || !Array.isArray(entry.chunks) || !STATES.has(run.status) || typeof value.sources[run.sourceFile] !== 'string' || run.sourceLength !== value.sources[run.sourceFile].length || runIds.has(run.id)) throw new Error('备份任务格式无效');
                runIds.add(run.id);
                const chunkMap = new Map(entry.chunks.map(item => [item.id, item]));
                if (chunkMap.size !== entry.chunks.length || chunkMap.size !== run.chunks.length) throw new Error('备份分块不完整');
                for (const meta of run.chunks) {
                    const chunk = chunkMap.get(meta.id);
                    validateRange(meta, run.sourceLength);
                    if (!chunk || chunk.runId !== run.id || chunkIds.has(`${run.id}:${chunk.id}`) || !STATES.has(chunk.status) || chunk.start !== meta.start || chunk.end !== meta.end) throw new Error('备份分块格式无效');
                    chunkIds.add(`${run.id}:${chunk.id}`);
                }
            }
            const projectId = newId();
            const sourceMap = new Map(sourceNames.map(file => [file, `jl-source-${projectId}-${newId()}.txt`]));
            const project = { id: projectId, title: original.title.trim() || '导入的小说', sourceName: String(original.sourceName || ''), sourceFile: sourceMap.get(original.sourceFile), sourceFiles: [...sourceMap.values()], length: value.sources[original.sourceFile].length, createdAt: now(), updatedAt: now(), runs: [], settings: copy(original.settings || {}) };
            for (const [oldName, newName] of sourceMap) await writeText(newName, value.sources[oldName]);
            for (const entry of value.runs) {
                const oldRun = entry.run;
                const runId = newId();
                const chunks = [];
                for (const oldChunk of [...entry.chunks].sort((a, b) => a.index - b.index)) {
                    const chunk = withoutSecrets({ ...oldChunk, id: newId(), runId, status: oldChunk.status === 'running' ? 'paused' : oldChunk.status, updatedAt: now() });
                    await writeJson(chunkFile(runId, chunk.id), chunk);
                    chunks.push(chunkMeta(chunk));
                }
                const run = withoutSecrets({ ...oldRun, id: runId, projectId, sourceFile: sourceMap.get(oldRun.sourceFile), status: oldRun.status === 'running' ? 'paused' : oldRun.status, chunks, deletedChunkIds: [], pendingChunkDeletes: [], updatedAt: now() });
                await writeJson(runFile(runId), run);
                project.runs.push(runMeta(run));
            }
            return persistProject(project);
        }),
    };
    return api;
}
