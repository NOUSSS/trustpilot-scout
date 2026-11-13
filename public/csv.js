/**
 * Cellule CSV entre guillemets. Un texte qui commence par = + - @ serait lu
 * comme une formule par un tableur : une apostrophe en tête le neutralise.
 */
export function csvCell(value) {
  let text = String(value ?? '');
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

/** Lignes → CSV lisible par Excel en français : point-virgule, CRLF, BOM UTF-8. */
export const toCsv = (rows) =>
  '﻿' + rows.map((row) => row.map(csvCell).join(';')).join('\r\n');
