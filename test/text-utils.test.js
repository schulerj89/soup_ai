import test from 'node:test';
import assert from 'node:assert/strict';
import { splitTelegramText, truncateText } from '../src/utils/text.js';

test('truncateText coerces nullish values and leaves exact-length text unchanged', () => {
  assert.equal(truncateText(null, 10), '');
  assert.equal(truncateText(undefined, 10), '');
  assert.equal(truncateText('hello', 5), 'hello');
});

test('truncateText appends a truncation marker once text exceeds the limit', () => {
  assert.equal(truncateText('hello world', 5), 'hello\n...[truncated]');
});

test('splitTelegramText returns a single empty chunk for blank input', () => {
  assert.deepEqual(splitTelegramText('   \n\t  '), ['']);
});

test('splitTelegramText prefers newline boundaries before spaces', () => {
  assert.deepEqual(splitTelegramText('alpha\nbeta gamma', 10), ['alpha', 'beta gamma']);
});

test('splitTelegramText falls back to spaces when no suitable newline exists', () => {
  assert.deepEqual(splitTelegramText('alpha beta gamma', 10), ['alpha beta', 'gamma']);
});

test('splitTelegramText hard-splits long tokens when no separator is available', () => {
  assert.deepEqual(splitTelegramText('abcdefghijk', 5), ['abcde', 'fghij', 'k']);
});
