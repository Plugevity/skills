// Run with `npm test` (Node 18+, no dependencies, no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { check, parseLog, analyse, account, toMarkdown } from '../skills/plugin-ownership-check/scripts/ownership.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, 'fixtures', 'ownership');
const now = '2026-11-11T12:00:00Z';
const c = (rev, author, date) => ({ rev, author, date });

test('a buyer taking over after the original developer stopped is a recent handover', async () => {
  const r = await check('demo-sold', { fixtures, now });
  assert.equal(r.verdict, 'recent_handover');
  assert.equal(r.handovers.at(-1).to, 'newco');
  assert.deepEqual(r.handovers.at(-1).from, ['origdev']);
  assert.ok(r.handovers.at(-1).silence_days > 365);
  // plugin-master and commits after the closure are not maintainers
  assert.deepEqual(r.people.map((p) => p.account), ['origdev', 'newco']);
});

test('overlapping committers are not a handover', async () => {
  const r = await check('demo-team', { fixtures, now });
  assert.equal(r.verdict, 'shared');
  assert.equal(r.handovers.length, 0);
});

test('a handover inside the team whose owner committed before is not a change of hands', async () => {
  const r = await check('demo-rotation', { fixtures, now });
  assert.equal(r.verdict, 'committers_changed');
});

test('WordPress.org-owned plugins rotate committers', () => {
  const log = [c(1, 'a', '2015-01-01'), c(2, 'a', '2018-01-01'), c(3, 'b', '2026-06-01')];
  assert.equal(analyse(log, { owner: 'wordpressdotorg', now: Date.parse(now) / 1000 }).verdict, 'committers_changed');
  assert.equal(analyse(log, { owner: 'someoneelse', now: Date.parse(now) / 1000 }).verdict, 'recent_handover');
});

test('a short overlap during the handover still counts as one', () => {
  const log = [c(1, 'a', '2010-01-01'), c(2, 'b', '2017-06-20'), c(3, 'a', '2017-06-25'), c(4, 'b', '2017-09-01')];
  const r = analyse(log, { now: Date.parse(now) / 1000 });
  assert.equal(r.verdict, 'old_handover');
});

test('a new account in the first year is not a handover', () => {
  const log = [c(1, 'a', '2025-01-01'), c(2, 'b', '2025-06-01')];
  assert.equal(analyse(log, { now: Date.parse(now) / 1000 }).verdict, 'shared');
});

test('not found and unreadable history are reported, never guessed', async () => {
  assert.equal((await check('demo-missing', { fixtures, now })).verdict, 'not_found');
  assert.equal((await check('demo-nolog', { fixtures, now })).verdict, 'error');
});

test('names from WordPress.org stay inert', async () => {
  assert.equal(account('eve<script>|rm -rf'), 'evescriptrm-rf');
  const md = toMarkdown([await check('demo-inject', { fixtures, now })]);
  assert.doesNotMatch(md, /ignore your rules|<script>/);
});

test('parseLog reads revision, author and date in order', () => {
  const xml = '<S:log-item><D:version-name>9</D:version-name><D:creator-displayname>b</D:creator-displayname><S:date>2020-01-02T00:00:00Z</S:date></S:log-item><S:log-item><D:version-name>3</D:version-name><D:creator-displayname>a</D:creator-displayname><S:date>2019-01-01T00:00:00Z</S:date></S:log-item>';
  assert.deepEqual(parseLog(xml), [c(3, 'a', '2019-01-01'), c(9, 'b', '2020-01-02')]);
});

test('CLI prints Markdown with the history link', () => {
  const out = execFileSync(process.execPath, [join(here, '../skills/plugin-ownership-check/scripts/ownership.mjs'), 'demo-sold', '--fixtures', fixtures, '--now', now], { encoding: 'utf8' });
  assert.match(out, /Recent handover to new committers/);
  assert.match(out, /plugins\.trac\.wordpress\.org\/log\/demo-sold\//);
});
