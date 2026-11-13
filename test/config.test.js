import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG, envNumber } from '../src/config.js';

const NAME = 'TP_TEST_ENV_NUMBER';

/** Lit `envNumber` avec la variable réglée à `raw` (ou absente), sans laisser de trace. */
function read(raw, fallback, min) {
  if (raw === undefined) delete process.env[NAME];
  else process.env[NAME] = raw;
  try {
    return envNumber(NAME, fallback, min);
  } finally {
    delete process.env[NAME];
  }
}

test('envNumber lit un nombre valide', () => {
  assert.equal(read('8', 3), 8);
  assert.equal(read(' 12 ', 3), 12);
  assert.equal(read('0', 3), 0);
  assert.equal(read('1.5', 3), 1.5);
});

test('envNumber garde le défaut sans avertir quand la variable est absente ou vide', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  assert.equal(read(undefined, 3), 3);
  assert.equal(read('', 3), 3);
  assert.equal(read('   ', 3), 3);
  assert.equal(warn.mock.callCount(), 0);
});

test('envNumber garde le défaut et avertit quand la valeur est inutilisable', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  assert.equal(read('abc', 3), 3);
  assert.equal(read('-1', 3), 3);
  assert.equal(read('0', 3, 1), 3);
  assert.equal(read('Infinity', 3), 3);
  assert.equal(warn.mock.callCount(), 4);
});

test('CONFIG : toutes les bornes numériques sont des nombres finis', () => {
  for (const [name, value] of Object.entries(CONFIG)) {
    if (typeof value === 'number') assert.ok(Number.isFinite(value), name);
  }
  assert.ok(CONFIG.maxConcurrency >= 1);
});
