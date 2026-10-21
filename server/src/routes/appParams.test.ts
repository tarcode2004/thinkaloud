import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-params-'));
const { withAppParams } = await import('./participant.ts');

test('variant launch params merge into the app URL', () => {
  assert.equal(withAppParams('http://app-x.localhost:4001/', ''), 'http://app-x.localhost:4001/');
  assert.equal(withAppParams('http://app-x.localhost:4001/', 'flags=summaryCard:1'), 'http://app-x.localhost:4001/?flags=summaryCard%3A1');
  assert.equal(withAppParams('http://h/a/app_1/?x=1', 'x=2&y=3'), 'http://h/a/app_1/?x=2&y=3');
});
