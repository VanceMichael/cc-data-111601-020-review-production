export function datRows(text) {
  const rows = []; let row = []; let value = ''; let quoted = false;
  for (let offset = 0; offset < text.length; offset++) {
    const char = text[offset];
    if (char === '\u00fe') quoted = !quoted;
    else if (char === '\u0014' && !quoted) { row.push(value); value = ''; }
    else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && text[offset + 1] === '\n') offset++;
      row.push(value); rows.push(row); row = []; value = '';
    } else value += char === '\u00ae' ? '\n' : char;
  }
  if (quoted) throw new Error('dat_quote_unclosed');
  if (row.length || value) { row.push(value); rows.push(row); }
  return rows;
}
export function inspect(bytes) {
  const rows = datRows(bytes.toString('utf8'));
  if (!rows.length || !rows[0].includes('BEGDOC')) throw new Error('dat_columns');
  if (rows.some(row => row.length !== rows[0].length)) throw new Error('dat_width');
  return { kind: 'review-load-file', columns: rows[0], rows: rows.slice(1) };
}
export function csvRows(text) {
  const rows = []; let row = []; let value = ''; let quoted = false;
  for (let offset = 0; offset < text.length; offset++) {
    const char = text[offset];
    if (quoted) {
      if (char === '"' && text[offset + 1] === '"') { value += '"'; offset++; }
      else if (char === '"') quoted = false;
      else value += char;
    } else if (char === '"' && value === '') quoted = true;
    else if (char === ',') { row.push(value); value = ''; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[offset + 1] === '\n') offset++;
      row.push(value); rows.push(row); row = []; value = '';
    } else value += char;
  }
  if (quoted) throw new Error('csv_quote_unclosed');
  if (row.length || value) { row.push(value); rows.push(row); }
  return rows;
}
export function inspectOpt(bytes) {
  const text = bytes.toString('utf8').replace(/^﻿/, '');
  const rows = csvRows(text).filter(row => row.some(field => field.trim() !== ''));
  if (!rows.length) throw new Error('opt_empty');
  const pages = rows.map((row, index) => {
    if (row.length !== 7) throw new Error('opt_width');
    const [pageId, volume, path, documentBreak, folderBreak, boxBreak, pageCount] = row.map(field => field.trim());
    if (!pageId) throw new Error('opt_page_id');
    if (!volume) throw new Error('opt_volume');
    if (!path) throw new Error('opt_path');
    if (documentBreak && documentBreak !== 'Y') throw new Error('opt_document_break');
    if (pageCount && !/^\d+$/.test(pageCount)) throw new Error('opt_page_count');
    return { index, pageId, volume, path, documentBreak: documentBreak || null,
      folderBreak: folderBreak || null, boxBreak: boxBreak || null,
      pageCount: pageCount === '' ? null : Number(pageCount) };
  });
  return { kind: 'review-opt', pages };
}
