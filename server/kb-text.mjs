import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';
import { HttpError } from './bank.mjs';

export const KB_LIMITS = { documentBytes: 512 * 1024, fileBytes: 20 * 1024 * 1024, imageBytes: 6 * 1024 * 1024, documentsPerLibrary: 40, libraries: 20, chunks: 2000, chunkChars: 900, title: 100, libraryName: 40, description: 200 };

// Deterministic chunking: markdown headings become anchors, small blocks merge
// into 300–900 char chunks inside one section, oversized blocks hard-split at
// sentence boundaries. Plain text is paragraph-ordered with positional anchors.
export function parseBlocks(format, content) {
  const blocks = [];
  if (format === 'markdown') {
    let anchor = '';
    for (const line of content.split(/\r?\n/)) {
      const heading = line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
      if (heading) { anchor = heading[1].trim().slice(0, 80); continue; }
      if (line.trim()) blocks.push({ anchor, text: line.trim() });
    }
  } else {
    for (const line of content.split(/\r?\n/)) if (line.trim()) blocks.push({ anchor: '', text: line.trim() });
  }
  return blocks;
}

export function chunkDocument(format, content) {
  const blocks = parseBlocks(format, content), chunks = [];
  const splitLong = block => {
    const sentences = block.text.match(/[^。！？；\n]+[。！？；]?/g) || [block.text];
    let piece = '';
    for (const sentence of sentences) {
      // A PDF line or a formula may have no sentence punctuation at all.
      // Hard-split these spans as well, keeping embedding inputs bounded.
      if (sentence.length > KB_LIMITS.chunkChars) {
        if (piece) { chunks.push({ anchor: block.anchor, text: piece }); piece = ''; }
        for (let start = 0; start < sentence.length; start += KB_LIMITS.chunkChars) {
          const text = sentence.slice(start, start + KB_LIMITS.chunkChars);
          if (text.length === KB_LIMITS.chunkChars) chunks.push({ anchor: block.anchor, text }); else piece = text;
        }
        continue;
      }
      if (piece && piece.length + sentence.length > KB_LIMITS.chunkChars) { chunks.push({ anchor: block.anchor, text: piece }); piece = ''; }
      piece += sentence;
      if (piece.length >= KB_LIMITS.chunkChars) { chunks.push({ anchor: block.anchor, text: piece }); piece = ''; }
    }
    return piece;
  };
  let current = null;
  for (const block of blocks) {
    if (current && current.anchor === block.anchor && current.text.length + block.text.length + 1 <= KB_LIMITS.chunkChars) {
      current.text += `\n${block.text}`;
      continue;
    }
    if (current) chunks.push(current);
    current = null;
    if (block.text.length > KB_LIMITS.chunkChars) {
      const rest = splitLong(block);
      current = rest ? { anchor: block.anchor, text: rest } : null;
    } else current = { anchor: block.anchor, text: block.text };
    if (chunks.length >= KB_LIMITS.chunks) throw new HttpError(400, '文档过长，切片数量超出上限。');
  }
  if (current) chunks.push(current);
  return chunks.map((chunk, index) => ({ index, anchor: chunk.anchor || `第 ${index + 1} 段`, text: chunk.text }));
}

// Lexical retrieval over chunks: ASCII words plus Chinese character bigrams,
// ranked with BM25. Dependency-free; an embedding index can layer on later.
export function tokenize(text) {
  const tokens = [];
  for (const word of text.toLocaleLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/)) {
    if (!word) continue;
    if (/^[a-z0-9]+$/.test(word)) { tokens.push(word); continue; }
    for (let index = 0; index < word.length; index++) tokens.push(word.slice(index, index + 2));
  }
  return tokens;
}

// PDF and Word arrive as base64; extract plain text then chunk like any other
// text material. Scanned files without a text layer fail loudly with guidance.
export async function extractDocumentText(format, fileBase64) {
  const buffer = Buffer.from(fileBase64, 'base64');
  try {
    if (format === 'pdf') {
      const parser = new PDFParse({ data: buffer });
      try { return (await parser.getText()).text; } finally { await parser.destroy(); }
    }
    if (format === 'docx') return (await mammoth.extractRawText({ buffer })).value;
  } catch {
    throw new HttpError(400, `无法解析这份 ${format.toUpperCase()} 文件，请确认文件没有损坏后重试。`);
  }
  throw new HttpError(400, '暂不支持该文件格式。');
}

