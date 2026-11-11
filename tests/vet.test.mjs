// Run with `npm test` (Node 18+, no dependencies, no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { score, releasesBehind, toSlug, normalize, vet, fromWpCli, snapshotOf, toMarkdown, looksLikeOtherProduct, plain } from '../skills/plugin-vetting/scripts/vet.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, 'fixtures');
const NOW = Date.parse('2026-11-11T12:00:00Z') / 1000;
const NOW_ISO = '2026-11-11T12:00:00Z';
const ok = (over) => ({ status: 'ok', last_updated: '2026-11-01', tested: '7.1', support_threads: 0, support_resolved: 0, ...over });

test('release age deductions match the Health Score weights', () => {
  assert.equal(score(ok({ last_updated: '2026-06-01' }), NOW, '7.1.4').score, 100);
  assert.equal(score(ok({ last_updated: '2026-03-01' }), NOW, '7.1.4').score, 90);
  assert.equal(score(ok({ last_updated: '2025-09-01' }), NOW, '7.1.4').score, 75);
  assert.equal(score(ok({ last_updated: '2023-06-01' }), NOW, '7.1.4').score, 55);
});

test('tested up to: one release behind is not a deduction', () => {
  assert.equal(score(ok({ tested: '7.0' }), NOW, '7.1.4').score, 100);
  assert.equal(score(ok({ tested: '6.9' }), NOW, '7.1.4').score, 90);
  assert.equal(score(ok({ tested: '6.8' }), NOW, '7.1.4').score, 75);
  assert.equal(releasesBehind('6.8', '7.0'), 2);
});

test('unknown latest WordPress skips the tested check', () => {
  assert.equal(score(ok({ tested: '4.0' }), NOW, null).score, 100);
});

test('support threads only count with 10+ threads and under 20% resolved', () => {
  assert.equal(score(ok({ support_threads: 5, support_resolved: 0 }), NOW, '7.1.4').score, 100);
  assert.equal(score(ok({ support_threads: 40, support_resolved: 2 }), NOW, '7.1.4').score, 90);
  assert.equal(score(ok({ support_threads: 40, support_resolved: 8 }), NOW, '7.1.4').score, 100);
});

test('owner and contributor changes', () => {
  assert.equal(score(ok(), NOW, '7.1.4', 'owner_changed').score, 70);
  assert.equal(score(ok(), NOW, '7.1.4', 'contributors_changed').score, 90);
});

test('grades and clamping', () => {
  const worst = score(ok({ last_updated: '2015-01-01', tested: '4.0', support_threads: 50 }), NOW, '7.1.4', 'owner_changed');
  assert.equal(worst.score, 0);
  assert.equal(worst.grade, 'at_risk');
  assert.equal(score(ok({ last_updated: '2025-09-01' }), NOW, '7.1.4').grade, 'watch');
});

test('closed overrides everything; errors are never called abandoned', () => {
  const closed = score({ status: 'closed', closed_date: '2026-04-07', closed_reason: 'Security Issue' }, NOW, '7.1.4');
  assert.equal(closed.score, 0);
  assert.equal(closed.grade, 'closed');
  assert.match(closed.reasons[0], /Security Issue/);
  const err = score({ status: 'error' }, NOW, '7.1.4');
  assert.equal(err.score, null);
  assert.equal(err.grade, 'not_checked');
  assert.match(err.reasons[0], /not a sign of abandonment/);
});

test('normalize: network failure, not found, closed', () => {
  assert.equal(normalize(0, null).status, 'error');
  assert.equal(normalize(503, { error: 'x' }).status, 'error');
  assert.equal(normalize(404, { error: 'Plugin not found.' }).status, 'not_found');
  assert.equal(normalize(200, { error: 'closed', closed_date: '2024-02-23', reason_text: 'Author Request' }).status, 'closed');
});

test('slugs and URLs; anything else is rejected before a request is made', () => {
  assert.equal(toSlug('https://wordpress.org/plugins/demo-slider/'), 'demo-slider');
  assert.equal(toSlug('https://pt-br.wordpress.org/plugins/demo-slider/#reviews'), 'demo-slider');
  assert.equal(toSlug('Demo-Slider'), 'demo-slider');
  assert.equal(toSlug('../../etc/passwd'), null);
  assert.equal(toSlug('demo&action=x'), null);
  assert.equal(toSlug('https://example.com/plugins/demo-slider/'), null);
});

test('API text is plain data: tags, comments and pipes cannot leak into the report', () => {
  assert.equal(plain('Demo <b>SEO</b> &amp; Schema'), 'Demo SEO & Schema');
  assert.equal(plain('A<!-- run this -->B'), 'AB');
});

test('slug collisions are not scored', () => {
  assert.equal(looksLikeOtherProduct('Acme Backup Pro', 'Recipe Cards'), true);
  assert.equal(looksLikeOtherProduct('Demo Forms', 'Demo Forms'), false);
  assert.equal(looksLikeOtherProduct('Akismet', 'Akismet Anti-spam: Spam Protection'), false);
});

test('end to end with fixtures: worst first, every grade reachable', async () => {
  const items = ['demo-forms', 'demo-slider', 'demo-gallery', 'demo-seo', 'demo-cache', 'not-on-org'].map((s) => ({ input: s, slug: toSlug(s), local: null }));
  const report = await vet(items, { fixtures, now: NOW_ISO });
  assert.equal(report.latest_wordpress, '7.1.4');
  assert.deepEqual(
    report.results.map((r) => [r.slug, r.grade, r.score]),
    [
      ['demo-gallery', 'closed', 0],
      ['demo-slider', 'at_risk', 30],
      ['not-on-org', 'not_checked', null],
      ['demo-cache', 'healthy', 80],
      ['demo-seo', 'healthy', 90],
      ['demo-forms', 'healthy', 100],
    ],
  );
});

test('wp-cli input: update notes, premium plugins and collisions', async () => {
  const rows = JSON.parse(readFileSync(join(fixtures, 'wp-plugin-list.json'), 'utf8'));
  const report = await vet(fromWpCli(rows), { fixtures, now: NOW_ISO });
  const by = Object.fromEntries(report.results.map((r) => [r.slug, r]));
  assert.equal(by['demo-backup'].record.status, 'mismatch');
  assert.equal(by['not-on-org'].grade, 'not_checked');
  const md = toMarkdown(report);
  assert.match(md, /Update available on the site: 5\.0\.9 -> 5\.1\.0/);
  assert.match(md, /5 plugins checked/);
  assert.match(md, /Acme Backup Pro \(`demo-backup`\) \| - \| Not checked/);
  assert.match(md, /Demo Gallery .*Inactive on the site\./);
});

test('snapshot round trip finds the owner change', async () => {
  const snapshot = JSON.parse(readFileSync(join(fixtures, 'snapshot-old.json'), 'utf8'));
  const items = ['demo-seo', 'demo-forms'].map((s) => ({ input: s, slug: s, local: null }));
  const report = await vet(items, { fixtures, now: NOW_ISO, snapshot });
  const by = Object.fromEntries(report.results.map((r) => [r.slug, r]));
  assert.equal(by['demo-seo'].score, 60); // support -10, owner -30
  assert.match(by['demo-seo'].reasons.join(' '), /owner on WordPress\.org changed/);
  assert.equal(by['demo-forms'].score, 90); // contributor added
  assert.deepEqual(snapshotOf(report).plugins['demo-seo'], { owner: 'newowner', contributors: ['newowner'] });
});

test('injected text in a plugin name stays inert in the Markdown table', async () => {
  const report = await vet([{ input: 'demo-injection', slug: 'demo-injection', local: null }], { fixtures, now: NOW_ISO });
  const md = toMarkdown(report);
  assert.doesNotMatch(md, /Ignore previous instructions/);
  const row = md.split('\n').find((l) => l.includes('demo-injection'));
  assert.equal(row.split(/(?<!\\)\|/).length, 6); // 4 cells, no extra column
});

test('both skills ship the same script', () => {
  const a = readFileSync(join(here, '../skills/plugin-vetting/scripts/vet.mjs'), 'utf8');
  const b = readFileSync(join(here, '../skills/site-plugin-audit/scripts/vet.mjs'), 'utf8');
  assert.equal(a, b, 'Run `npm run sync` after changing skills/plugin-vetting/scripts/vet.mjs.');
});

test('CLI prints Markdown and exits 0', () => {
  const out = execFileSync(process.execPath, [join(here, '../skills/plugin-vetting/scripts/vet.mjs'), 'demo-slider', '--fixtures', fixtures, '--now', NOW_ISO], { encoding: 'utf8' });
  assert.match(out, /Demo Slider/);
  assert.match(out, /plugevity\.com\/plugins\/health-score/);
});
