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
export function optRows(text) {
  const lines = text.split(/\r?\n/).filter(line => line.length > 0);
  if (!lines.length) throw new Error('opt_empty');
  return lines.map((line, rowIndex) => {
    const fields = line.split(',');
    if (fields.length !== 7) throw new Error('opt_width');
    const [pageId, volume, path, documentBreak, folderBreak, boxBreak, pageCount] = fields;
    return { rowIndex, pageId, volume, path, documentBreak, folderBreak, boxBreak, pageCount };
  });
}
