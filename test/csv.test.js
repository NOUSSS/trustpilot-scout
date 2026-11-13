import test from 'node:test';
import assert from 'node:assert/strict';
import { csvCell, toCsv } from '../public/csv.js';

test('csvCell met entre guillemets et double les guillemets', () => {
  assert.equal(csvCell('Fnac'), '"Fnac"');
  assert.equal(csvCell('dit "bonjour"'), '"dit ""bonjour"""');
  assert.equal(csvCell(null), '""');
  assert.equal(csvCell(undefined), '""');
  assert.equal(csvCell(4.5), '"4.5"');
});

test('csvCell neutralise un texte qui serait lu comme une formule', () => {
  assert.equal(csvCell('=1+1'), '"\'=1+1"');
  assert.equal(csvCell('+33 6 00 00 00 00'), '"\'+33 6 00 00 00 00"');
  assert.equal(csvCell('-10 % promis'), '"\'-10 % promis"');
  assert.equal(csvCell('@SUM(A1)'), '"\'@SUM(A1)"');
  assert.equal(csvCell('\t=1+1'), '"\'\t=1+1"');
});

test('csvCell laisse les nombres et les textes ordinaires intacts', () => {
  assert.equal(csvCell(-5), '"-5"');
  assert.equal(csvCell('a = b'), '"a = b"');
  assert.equal(csvCell('www.fnac.com'), '"www.fnac.com"');
});

test('toCsv : BOM, point-virgule, CRLF', () => {
  assert.equal(
    toCsv([['nom', 'note'], ['=x', 4]]),
    '﻿"nom";"note"\r\n"\'=x";"4"'
  );
});
