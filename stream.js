function textOf(data) {
    const choice = data?.choices?.[0];
    const content = choice?.delta?.content ?? choice?.message?.content ?? choice?.text;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.filter(p => ['text', 'output_text'].includes(p.type)).map(p => p.text || '').join('');
    if (data?.type === 'content_block_delta') return data.delta?.text || '';
    if (data?.type === 'content_block_start') return data.content_block?.type === 'text' ? data.content_block.text || '' : '';
    if (typeof data?.delta?.message?.content?.text === 'string') return data.delta.message.content.text;
    if (Array.isArray(data?.candidates)) return (data.candidates[0]?.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('');
    if (Array.isArray(data?.content)) return data.content.filter(p => p.type === 'text').map(p => p.text || '').join('');
    return '';
}

/** Parse real response bytes, including split UTF-8 and SSE frames. */
export async function readCompletion(response, { signal, onProgress } = {}) {
    if (!response.ok) throw new Error(`接口请求失败 (${response.status})：${(await response.text()).slice(0, 300)}`);
    const type = response.headers?.get?.('content-type') || '';
    if (!type.includes('text/event-stream')) {
        const raw = await response.json();
        if (raw?.error) throw new Error(raw.error.message || String(raw.error));
        const text = textOf(raw);
        onProgress?.(text);
        return { text, finishReason: raw.choices?.[0]?.finish_reason || raw.stop_reason || raw.candidates?.[0]?.finishReason || '', raw };
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('当前环境不支持读取流式响应');
    const decoder = new TextDecoder();
    let buffer = '', event = [], text = '', finishReason = '', completed = false, usage;
    const consume = () => {
        if (!event.length) return;
        const payload = event.join('\n'); event = [];
        if (payload.trim() === '[DONE]') { completed = true; return; }
        let data;
        try { data = JSON.parse(payload); } catch { throw new Error('流式响应包含无效数据，已保留收到的内容'); }
        if (data.error) throw new Error(data.error.message || String(data.error));
        const delta = textOf(data);
        if (delta) { text += delta; onProgress?.(text); }
        finishReason = data.choices?.[0]?.finish_reason || data.delta?.stop_reason || data.delta?.finish_reason || data.stop_reason || data.candidates?.[0]?.finishReason || finishReason;
        usage = data.usage || usage;
        if (data.type === 'message_stop' || data.type === 'message-end') completed = true;
    };
    const line = value => {
        if (!value) consume();
        else if (value.startsWith('data:')) event.push(value.slice(5).replace(/^ /, ''));
    };
    try {
        for (;;) {
            if (signal?.aborted) throw new DOMException('已暂停', 'AbortError');
            const { done, value } = await reader.read();
            buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
            let split;
            while ((split = buffer.indexOf('\n')) >= 0) { line(buffer.slice(0, split).replace(/\r$/, '')); buffer = buffer.slice(split + 1); }
            if (done || completed) break;
        }
        if (buffer) line(buffer.replace(/\r$/, ''));
        consume();
        if (!completed && !finishReason) throw new Error('流式连接提前结束，已保留收到的内容');
        return { text, finishReason, raw: { streamed: true, finishReason, usage } };
    } finally { try { await reader.cancel(); } catch {} reader.releaseLock(); }
}
