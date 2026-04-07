import test from 'node:test';
import assert from 'node:assert/strict';
import { formatCliError } from '../src/utils/cli-error.js';

test('formatCliError prefers the stack when available', () => {
  const error = new Error('boom');
  error.stack = 'Error: boom\n    at test';

  assert.equal(formatCliError(error), 'Error: boom\n    at test');
});

test('formatCliError falls back to the error message when the stack is missing', () => {
  const error = new Error('boom');
  error.stack = '';

  assert.equal(formatCliError(error), 'boom');
});

test('formatCliError stringifies non-error values', () => {
  assert.equal(formatCliError({ code: 'EFAIL' }), '[object Object]');
});
