import { splitText } from './chunker.js';
import { newId } from './store.js';

const timestamp = () => new Date().toISOString();
function abortError(message = '任务已暂停') {
    const error = new Error(message);
    error.name = 'AbortError';
    return error;
}
function abortable(promise, signal) {
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
        const aborted = () => { cleanup(); reject(abortError()); };
        const cleanup = () => signal.removeEventListener('abort', aborted);
        signal.addEventListener('abort', aborted, { once: true });
        Promise.resolve(promise).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    });
}
function statusFor(chunks) {
    if (chunks.some(chunk => chunk.status === 'running')) return 'running';
    if (chunks.length && chunks.every(chunk => chunk.status === 'done')) return 'done';
    if (chunks.some(chunk => chunk.status === 'failed')) return 'failed';
    if (chunks.some(chunk => chunk.status === 'partial')) return 'partial';
    if (chunks.some(chunk => chunk.status === 'paused')) return 'paused';
    return 'pending';
}

/** A single persisted queue. Prompt content is supplied only by the host preset. */
export function createQueue({ repo, host, onChange } = {}) {
    if (!repo || !host?.capture || !host?.generate) throw new Error('任务服务不可用');
    const listeners = new Set(onChange ? [onChange] : []);
    let active = null;
    const emit = event => { for (const listener of listeners) { try { listener(event); } catch (error) { console.error('[笺录] 界面更新失败', error); } } };
    async function refresh(runId, override) {
        const run = await repo.getRun(runId);
        run.status = override || statusFor(run.chunks);
        return repo.saveRun(run);
    }
    async function execute(token, options) {
        const { runId, controller } = token;
        const { signal } = controller;
        let run = await repo.getRun(runId);
        token.projectId = run.projectId;
        const project = await repo.getProject(run.projectId);
        const source = await repo.readSourceFile(run.sourceFile);
        if (source.length !== run.sourceLength) throw new Error('任务原文长度与快照不一致');
        const selected = options.ids === undefined ? null : new Set(options.ids);
        if (selected && [...selected].some(chunkId => !run.chunks.some(chunk => chunk.id === chunkId))) throw new Error('选中的分块不属于此任务');
        const targets = [...run.chunks].sort((a, b) => a.index - b.index).filter(chunk => {
            if (selected && !selected.has(chunk.id)) return false;
            if (chunk.status === 'done') return Boolean(options.force && selected);
            if (selected) return true;
            return chunk.status === 'pending' || chunk.status === 'paused';
        });
        if (!targets.length) return refresh(runId);
        run.status = 'running';
        await repo.saveRun(run);
        emit({ kind: 'start', runId, projectId: run.projectId });
        for (const meta of targets) {
            if (signal.aborted) break;
            let chunk = await repo.getChunk(runId, meta.id);
            // A previous save can have committed this file but failed to update run metadata.
            // The detailed file is authoritative; never pay to repeat a completed chunk implicitly.
            if (chunk.status === 'done' && !(options.force && selected)) {
                await repo.saveChunk(runId, chunk);
                emit({ kind: 'chunk', runId, projectId: run.projectId, chunkId: chunk.id });
                continue;
            }
            const previousOutput = chunk.output || '';
            chunk.attempts = Number(chunk.attempts || 0) + 1;
            chunk.error = '';
            chunk.status = 'running';
            chunk.previousOutput = previousOutput;
            if (options.freshPreset) chunk.snapshot = null;
            // Save the attempt before even reading a preset; crashes retain its identity.
            chunk = await repo.saveChunk(runId, chunk);
            emit({ kind: 'chunk', runId, projectId: run.projectId, chunkId: chunk.id });
            let response, requestError = null;
            try {
                if (!chunk.snapshot) {
                    chunk.snapshot = await abortable(host.capture(source.slice(chunk.start, chunk.end), {
                        projectTitle: project.title, blockIndex: chunk.index, blockTotal: run.chunks.length, blockLabel: chunk.label,
                        rangeStart: chunk.start, rangeEnd: chunk.end, sourceKind: run.sourceKind || 'novel', sourceName: run.sourceName || '',
                    }), signal);
                }
            } catch (error) { requestError = error; }
            if (!requestError) {
                // Persist the actual instructions before the paid request is started.
                chunk = await repo.saveChunk(runId, chunk);
                if (signal.aborted) requestError = abortError();
                else {
                    const timeout = new AbortController();
                    const relay = () => timeout.abort();
                    signal.addEventListener('abort', relay, { once: true });
                    const duration = Number(run.timeoutMs || 180000);
                    let timedOut = false;
                    const timer = setTimeout(() => { timedOut = true; timeout.abort(); }, Math.max(1000, duration));
                    try {
                        response = await abortable(host.generate(chunk.snapshot, { signal: timeout.signal }), timeout.signal);
                        if (signal.aborted) throw abortError();
                    } catch (error) {
                        requestError = timedOut ? new Error(`请求超时（${Math.round(duration / 1000)} 秒）`) : error;
                    } finally {
                        clearTimeout(timer);
                        signal.removeEventListener('abort', relay);
                    }
                }
            }
            if (response?.requestMessages) chunk.snapshot = { ...chunk.snapshot, requestMessages: response.requestMessages };
            if (response?.profile) chunk.snapshot = { ...chunk.snapshot, profile: response.profile };
            if (signal.aborted || (requestError?.name === 'AbortError' && !response)) {
                chunk.status = 'paused';
                chunk.error = signal.aborted ? '' : String(requestError?.message || '请求已中断');
                chunk.output = previousOutput;
            } else if (requestError) {
                chunk.status = 'failed';
                chunk.error = String(requestError.message || requestError);
                chunk.output = previousOutput;
            } else {
                const text = typeof response === 'string' ? response : response?.text;
                if (typeof text !== 'string' || !text.trim()) {
                    chunk.status = 'failed';
                    chunk.error = '模型返回了空内容';
                    chunk.output = previousOutput;
                } else {
                    chunk.output = text;
                    chunk.finishReason = String(response?.finishReason || '');
                    chunk.status = /^(?:length|max_tokens|max_output_tokens|MAX_TOKENS)$/i.test(chunk.finishReason) ? 'partial' : 'done';
                    chunk.error = chunk.status === 'partial' ? '输出达到长度上限' : '';
                    if (response?.raw !== undefined) chunk.raw = response.raw;
                }
            }
            // host.generate may have added requestMessages to the snapshot before failing.
            await repo.saveChunk(runId, chunk);
            emit({ kind: 'chunk', runId, projectId: run.projectId, chunkId: chunk.id });
            if (signal.aborted) break;
        }
        run = await refresh(runId, signal.aborted ? 'paused' : undefined);
        emit({ kind: 'finish', runId, projectId: run.projectId });
        return run;
    }
    const api = {
        async plan({ projectId, title, chunkSize = 6000, overlap = 200, start = 0, end, inputText, inputName = '', sourceKind = 'novel', timeoutMs = 180000 }) {
            if (!['novel', 'result', 'paste'].includes(sourceKind)) throw new Error('输入类型无效');
            if (inputText !== undefined && typeof inputText !== 'string') throw new Error('输入材料必须是文本');
            const project = await repo.getProject(projectId);
            let sourceFile = project.sourceFile;
            let sourceName = project.sourceName;
            const source = inputText === undefined ? await repo.getSource(projectId) : inputText;
            const ranges = splitText(source, { size: chunkSize, overlap, start, end: end ?? source.length });
            if (!ranges.length) throw new Error('所选范围没有可处理的内容');
            if (inputText !== undefined) {
                const input = await repo.createSource(projectId, source, inputName);
                sourceFile = input.sourceFile;
                sourceName = input.sourceName;
            }
            const runId = newId();
            const run = {
                id: runId, projectId, title: String(title || `处理记录 ${new Date().toLocaleString('zh-CN')}`),
                sourceFile, sourceName, sourceKind, sourceLength: source.length, rangeStart: ranges[0].start, rangeEnd: ranges.at(-1).end,
                chunkSize: Number(chunkSize), overlap: Number(overlap), timeoutMs: Number(timeoutMs),
                createdAt: timestamp(), updatedAt: timestamp(), status: 'pending',
                chunks: ranges.map(range => ({ ...range, id: newId(), status: 'pending', attempts: 0, outputLength: 0 })),
            };
            const saved = await repo.saveRun(run);
            emit({ kind: 'plan', runId, projectId });
            return saved;
        },
        run(runId, options = {}) {
            if (active) return Promise.reject(new Error('已有任务正在处理'));
            const token = { runId, projectId: null, controller: new AbortController(), done: null };
            active = token;
            const done = execute(token, options).finally(() => { if (active === token) active = null; });
            token.done = done;
            return done;
        },
        async pause() {
            const token = active;
            if (!token) return;
            token.controller.abort();
            await token.done;
        },
        current: () => active ? { runId: active.runId, projectId: active.projectId } : null,
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        async recover(projectId, { fullAudit = false } = {}) {
            if (active) return;
            const projects = projectId ? [{ id: projectId }] : await repo.listProjects();
            for (const project of projects) {
                for (const meta of await repo.listRuns(project.id)) {
                    const run = await repo.getRun(meta.id);
                    if (!fullAudit && run.status !== 'running' && !run.chunks.some(chunk => chunk.status === 'running')) continue;
                    let changed = false;
                    for (const entry of run.chunks) {
                        const chunk = await repo.getChunk(run.id, entry.id, { run });
                        if (chunk.status === 'running') {
                            chunk.status = 'paused';
                            chunk.error = '';
                            await repo.saveChunk(run.id, chunk);
                            changed = true;
                        } else if (chunk.status !== entry.status || String(chunk.output || '').length !== entry.outputLength) {
                            await repo.saveChunk(run.id, chunk);
                            changed = true;
                        }
                    }
                    if (changed || run.status === 'running') await refresh(run.id);
                }
            }
        },
        async merge(runId, { includePartial = false } = {}) {
            const run = await repo.getRun(runId);
            const counts = { total: run.chunks.length, done: 0, partial: 0, failed: 0, pending: 0, paused: 0, running: 0 };
            const outputs = [];
            for (const meta of [...run.chunks].sort((a, b) => a.index - b.index)) {
                const chunk = await repo.getChunk(runId, meta.id, { run });
                counts[chunk.status] = (counts[chunk.status] || 0) + 1;
                if (chunk.status === 'done' || (includePartial && chunk.status === 'partial')) outputs.push(String(chunk.output || ''));
            }
            return { text: outputs.join('\n\n'), incomplete: counts.done !== counts.total, counts };
        },
    };
    return api;
}
