import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JsonlDecoder } from '../jsonl.js';

// Code points referenced below, named instead of typed literally in comments: this file
// deliberately avoids writing them as prose, because both are themselves JS *source* line
// terminators outside of string/template literals — a stray literal one inside a `//`
// comment truncates the comment early and the remainder becomes a syntax error, and one
// inside a /regex literal/ breaks the regex the same way ("Invalid regular expression:
// missing /"). String and template literals are the one place they are legal unescaped, per
// the ES2019 "JSON superset" change — which is exactly the fact this test exists to check a
// decoder respects.
const LINE_SEPARATOR = ' '; // LINE SEPARATOR
const PARAGRAPH_SEPARATOR = ' '; // PARAGRAPH SEPARATOR

test('a record containing the LINE SEPARATOR code point inside a JSON string stays one record', () => {
  // That code point is a legal, unescaped character inside a JSON string. A "generic line
  // reader" (node:readline, or a regex character class covering Unicode line terminators)
  // splits on it anyway, tearing this single record into two fragments — and neither
  // fragment is valid JSON on its own. Prove the fixture actually has that property before
  // trusting the decoder to survive it.
  const raw = `{"type":"text","text":"before${LINE_SEPARATOR}after"}\n`;
  const naiveLineSplitter = new RegExp(`\\r\\n|[\\n${LINE_SEPARATOR}${PARAGRAPH_SEPARATOR}]`);
  const naiveSplit = raw.split(naiveLineSplitter).filter((s) => s !== '');
  assert.strictEqual(naiveSplit.length, 2, 'the fixture must be splittable by a non-compliant reader');
  for (const fragment of naiveSplit) {
    assert.throws(() => JSON.parse(fragment), 'each half must be invalid JSON on its own');
  }

  const decoder = new JsonlDecoder();
  const lines = decoder.push(raw);
  assert.strictEqual(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.strictEqual(parsed.text, `before${LINE_SEPARATOR}after`);
});

test('a trailing CR is stripped and the record still parses', () => {
  const decoder = new JsonlDecoder();
  const lines = decoder.push('{"a":1}\r\n');
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(lines[0], '{"a":1}');
  assert.deepEqual(JSON.parse(lines[0]), { a: 1 });
});

test('a record split across two chunk boundaries mid-string is reassembled', () => {
  const decoder = new JsonlDecoder();
  const full = '{"type":"text","text":"hello world"}\n';
  const splitAt = full.indexOf('hello'); // land the boundary inside the string value
  const firstHalf = decoder.push(full.slice(0, splitAt));
  assert.strictEqual(firstHalf.length, 0, 'nothing should complete before the newline arrives');

  const secondHalf = decoder.push(full.slice(splitAt));
  assert.strictEqual(secondHalf.length, 1);
  assert.deepEqual(JSON.parse(secondHalf[0]), { type: 'text', text: 'hello world' });
});
