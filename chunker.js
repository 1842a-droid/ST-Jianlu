const chapterPattern = /^(?:第[零〇一二三四五六七八九十百千万两\d]+[章节卷回部篇][^\r\n]{0,65}|chapter\s+[\divxlc]+[^\r\n]{0,65}|序章[^\r\n]{0,60}|楔子[^\r\n]{0,60}|尾声[^\r\n]{0,60})/gim;

function boundary(text, index, direction = -1) {
    if (index > 0 && index < text.length) {
        const before = text.charCodeAt(index - 1);
        const after = text.charCodeAt(index);
        if (before >= 0xD800 && before <= 0xDBFF && after >= 0xDC00 && after <= 0xDFFF) return index + direction;
    }
    return index;
}

/** Return ranges into the original string; no manuscript copies are retained. */
export function splitText(text, { size = 6000, overlap = 200, start = 0, end = text.length } = {}) {
    if (typeof text !== 'string') throw new TypeError('原文必须是文本');
    size = Math.floor(Number(size));
    overlap = Math.floor(Number(overlap));
    if (!Number.isFinite(size) || size < 2) throw new Error('分块长度至少为 2');
    if (!Number.isFinite(overlap) || overlap < 0 || overlap >= size) throw new Error('重叠长度须小于分块长度');
    start = Number(start); end = Number(end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) throw new Error('原文范围无效');
    start = boundary(text, Math.max(0, Math.min(text.length, Math.floor(start))), -1);
    end = boundary(text, Math.max(0, Math.min(text.length, Math.floor(end))), 1);
    if (end <= start) return [];

    const chapters = [];
    chapterPattern.lastIndex = 0;
    let match;
    while ((match = chapterPattern.exec(text))) {
        if (match.index > end) break;
        chapters.push({ start: match.index, label: match[0].trim() });
    }
    const ranges = [];
    let cursor = start, chapterIndex = -1;
    while (cursor < end) {
        while (chapterIndex + 1 < chapters.length && chapters[chapterIndex + 1].start <= cursor) chapterIndex++;
        let cut = boundary(text, Math.min(cursor + size, end), -1);
        if (cut <= cursor) cut = boundary(text, Math.min(cursor + size + 1, end), 1);
        if (cut < end) {
            const minimum = cursor + Math.max(2, Math.floor(size * 0.65));
            let nextChapter = chapterIndex + 1, chapterCut = -1;
            while (nextChapter < chapters.length && chapters[nextChapter].start <= cut) {
                if (chapters[nextChapter].start >= minimum) chapterCut = chapters[nextChapter].start;
                nextChapter++;
            }
            if (chapterCut > cursor) cut = chapterCut;
            else {
                const paragraph = text.lastIndexOf('\n\n', cut - 1);
                const newline = paragraph >= minimum ? paragraph + 2 : text.lastIndexOf('\n', cut - 1) + 1;
                if (newline >= minimum && newline <= cut) cut = newline;
            }
        }
        cut = boundary(text, cut, -1);
        if (cut <= cursor) throw new Error('无法安全切分原文');
        const preview = text.slice(cursor, Math.min(cut, cursor + 45)).replace(/\s+/g, ' ').trim();
        const chapter = chapterIndex >= 0 ? chapters[chapterIndex].label : '';
        ranges.push({ index: ranges.length, label: chapter || preview || `片段 ${ranges.length + 1}`, start: cursor, end: cut });
        if (cut >= end) break;
        // Tiny paragraphs or large overlaps must still advance at least one code point.
        const next = Math.max(cursor + 1, cut - overlap);
        cursor = boundary(text, next, 1);
        if (cursor > cut) cursor = cut;
    }
    return ranges;
}
