const chapterPattern = /^[\t \u3000\uFEFF]*(?:#{1,6}[\t ]*)?(?:第[零〇一二三四五六七八九十百千万亿两壹贰叁肆伍陆柒捌玖拾佰仟\d０-９]+[章节卷回部篇集]|[卷篇部章回][零〇一二三四五六七八九十百千万亿两\d０-９]+|(?:chapter|part|volume|book)\s+(?:\d+|[ivxlcdm]+\b|(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[- ](?:one|two|three|four|five|six|seven|eight|nine))?\b)|序章|序言|前言|楔子|引子|终章|尾声|后记)[^\r\n]{0,120}(?=\r?$)/gim;

function headings(text) {
    const pattern = new RegExp(chapterPattern.source, chapterPattern.flags);
    const result = [];
    let match;
    while ((match = pattern.exec(text))) result.push({ start: match.index, label: match[0].trim().replace(/^#{1,6}\s*/, '') });
    return result;
}

/** Detected section order is zero-based; the first section includes any preceding prose. */
export function findChapters(text) {
    if (typeof text !== 'string') throw new TypeError('原文必须是文本');
    const found = headings(text);
    return found.map((chapter, index) => ({
        index, start: index === 0 ? 0 : chapter.start,
        end: index + 1 < found.length ? found[index + 1].start : text.length,
        label: chapter.label,
    }));
}

function boundary(text, index, direction = -1) {
    if (index > 0 && index < text.length) {
        const before = text.charCodeAt(index - 1);
        const after = text.charCodeAt(index);
        if (before >= 0xD800 && before <= 0xDBFF && after >= 0xDC00 && after <= 0xDFFF) return index + direction;
    }
    return index;
}

/** Whole sections only: a long chapter is never silently split by character count. */
export function splitByChapters(text, { chaptersPerChunk = 1, chapterStart, chapterEnd, start = 0, end = text.length } = {}) {
    if (typeof text !== 'string') throw new TypeError('原文必须是文本');
    chaptersPerChunk = Number(chaptersPerChunk);
    if (!Number.isInteger(chaptersPerChunk) || chaptersPerChunk < 1) throw new Error('每块章节数须为正整数');
    const chapters = findChapters(text);
    if (!chapters.length) throw new Error('未识别到章节标题，请改用按字数分块');
    let selected;
    if (chapterStart !== undefined || chapterEnd !== undefined) {
        const first = chapterStart === undefined ? 1 : Number(chapterStart);
        const last = chapterEnd === undefined ? chapters.length : Number(chapterEnd);
        if (!Number.isInteger(first) || !Number.isInteger(last) || first < 1 || last > chapters.length || last < first) throw new Error(`章节范围须为 1 至 ${chapters.length}，且起始章节不得晚于结束章节`);
        selected = chapters.slice(first - 1, last);
    } else {
        start = Number(start); end = Number(end);
        if (!Number.isFinite(start) || !Number.isFinite(end)) throw new Error('原文范围无效');
        start = Math.max(0, Math.min(text.length, Math.floor(start)));
        end = Math.max(0, Math.min(text.length, Math.floor(end)));
        selected = end <= start ? [] : chapters.filter(chapter => chapter.end > start && chapter.start < end);
    }
    const ranges = [];
    for (let offset = 0; offset < selected.length; offset += chaptersPerChunk) {
        const group = selected.slice(offset, offset + chaptersPerChunk);
        const first = group[0], last = group.at(-1);
        ranges.push({
            index: ranges.length, start: first.start, end: last.end,
            label: first === last ? first.label : `${first.label} — ${last.label}`,
            chapterStart: first.index + 1, chapterEnd: last.index + 1,
        });
    }
    return ranges;
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

    const chapters = headings(text).filter(chapter => chapter.start <= end);
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
