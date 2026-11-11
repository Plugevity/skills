#!/usr/bin/env node
// Scores WordPress.org plugins for longevity from public WordPress.org data.
//
// Read-only. The only network calls are GET requests to api.wordpress.org.
// No dependencies; needs Node 18 or later (built-in fetch).
//
// Usage:
//   node vet.mjs <slug|wordpress.org URL> [...]
//   wp plugin list --format=json --fields=name,title,status,version,update_version | node vet.mjs --wp-cli -
//
// Options:
//   --wp-cli <file|->   Read plugins from `wp plugin list --format=json` output.
//   --json              Print JSON instead of a Markdown report.
//   --save <file>       Save an owner/contributor snapshot for a later --compare.
//   --compare <file>    Compare owners and contributors with a saved snapshot.
//   --latest-wp <ver>   Latest WordPress version (default: asked from api.wordpress.org).
//   --now <date>        Score as of this date (ISO 8601). For tests.
//   --fixtures <dir>    Read API answers from <dir>/<slug>.json and <dir>/core.json. For tests.
//
// The method mirrors the Plugevity Health Score plugin:
// https://plugevity.com/plugins/health-score/

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const VERSION = '0.1.0';
const PLUGIN_API = 'https://api.wordpress.org/plugins/info/1.2/';
const CORE_API = 'https://api.wordpress.org/core/version-check/1.7/';
const USER_AGENT = `plugevity-skills/${VERSION}`;
const TIMEOUT_MS = 15000;
const CONCURRENCY = 4;
const DAY = 86400;
const YEAR = 365 * DAY;
const METHOD_URL = 'https://plugevity.com/plugins/health-score/';

export const GRADES = {
  closed: 'Closed',
  at_risk: 'At risk',
  watch: 'Watch',
  not_checked: 'Not checked',
  healthy: 'Healthy',
};
const GRADE_ORDER = ['closed', 'at_risk', 'watch', 'not_checked', 'healthy'];

// ---------------------------------------------------------------------------
// Input

/** Returns a WordPress.org slug from a slug or a plugin URL, or null. */
export function toSlug(input) {
  let s = String(input || '').trim();
  const m = s.match(/^https?:\/\/(?:[a-z-]+\.)?wordpress\.org\/plugins\/([^/?#]+)/i);
  if (m) s = m[1];
  s = s.toLowerCase();
  return /^[a-z0-9][a-z0-9-]{0,199}$/.test(s) ? s : null;
}

/** Normalizes `wp plugin list --format=json` rows. */
export function fromWpCli(rows) {
  if (!Array.isArray(rows)) throw new Error('Expected a JSON array from `wp plugin list --format=json`.');
  return rows
    .filter((r) => r && typeof r === 'object' && r.name)
    .map((r) => ({
      input: String(r.name),
      slug: toSlug(r.name),
      local: {
        title: r.title ? plain(r.title) : '',
        status: r.status ? String(r.status) : '',
        version: r.version ? String(r.version) : '',
        update_version: r.update_version ? String(r.update_version) : '',
      },
    }));
}

// ---------------------------------------------------------------------------
// Fetching

async function getJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { 'user-agent': USER_AGENT, accept: 'application/json' }, signal: ctrl.signal });
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    return { code: res.status, data };
  } catch {
    return { code: 0, data: null };
  } finally {
    clearTimeout(timer);
  }
}

function pluginUrl(slug) {
  const p = new URLSearchParams();
  p.set('action', 'plugin_information');
  p.set('request[slug]', slug);
  for (const f of ['sections', 'description', 'screenshots', 'versions', 'reviews', 'banners', 'icons', 'ratings', 'tags']) {
    p.set(`request[fields][${f}]`, '0');
  }
  p.set('request[fields][contributors]', '1');
  return `${PLUGIN_API}?${p.toString()}`;
}

function readFixture(dir, name) {
  try {
    const raw = readFileSync(join(dir, `${name}.json`), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && 'code' in parsed && 'data' in parsed) return parsed;
    return { code: 200, data: parsed };
  } catch {
    return { code: 0, data: null };
  }
}

async function fetchPlugin(slug, fixtures) {
  return fixtures ? readFixture(fixtures, slug) : getJson(pluginUrl(slug));
}

async function fetchLatestWp(fixtures) {
  const { data } = fixtures ? readFixture(fixtures, 'core') : await getJson(CORE_API);
  const v = data && Array.isArray(data.offers) && data.offers[0] ? data.offers[0].current : null;
  return typeof v === 'string' && /^\d+\.\d+/.test(v) ? v : null;
}

// ---------------------------------------------------------------------------
// Normalizing (same rules as the Health Score WporgClient)

/** Strips tags and common entities. API text is data: it never becomes markup or instructions. */
export function plain(value) {
  return String(value ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function toDate(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  // "2017-11-28 6:18pm GMT" -> 2017-11-28
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : '';
}

function ownerFrom(data) {
  const profile = String(data.author_profile || '');
  const m = profile.match(/profiles\.wordpress\.org\/([^/]+)/);
  return m ? m[1].toLowerCase() : '';
}

/** Turns an API answer into a record with a status: ok, closed, not_found or error. */
export function normalize(code, data) {
  if (!data || typeof data !== 'object' || code === 0 || code >= 500) return { status: 'error' };
  if (data.closed || data.error === 'closed') {
    return {
      status: 'closed',
      name: plain(data.name),
      closed_date: toDate(data.closed_date),
      closed_reason: plain(data.reason_text || data.reason || ''),
    };
  }
  if (data.error || !data.slug) {
    return code === 404 || data.error ? { status: 'not_found' } : { status: 'error' };
  }
  const contributors = data.contributors && typeof data.contributors === 'object' ? Object.keys(data.contributors).map((c) => c.toLowerCase()).sort() : [];
  return {
    status: 'ok',
    name: plain(data.name),
    version: plain(data.version),
    last_updated: toDate(data.last_updated),
    tested: plain(data.tested),
    active_installs: Number.isFinite(Number(data.active_installs)) ? Number(data.active_installs) : null,
    support_threads: Number(data.support_threads) || 0,
    support_resolved: Number(data.support_threads_resolved) || 0,
    owner: ownerFrom(data),
    contributors,
  };
}

function tokens(s) {
  return new Set(
    String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(' ')
      .filter((t) => t.length >= 3 && !['the', 'and', 'for', 'plugin', 'wordpress', 'pro', 'lite'].includes(t)),
  );
}

/** True when a local plugin title and the WordPress.org name look like different products. */
export function looksLikeOtherProduct(localTitle, orgName) {
  const a = tokens(localTitle);
  const b = tokens(orgName);
  if (a.size === 0 || b.size === 0) return false;
  for (const t of a) if (b.has(t)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Scoring (same weights as the Health Score Scorer, calibrated on 31 plugins)

function releaseIndex(version) {
  const m = String(version || '').match(/^(\d+)\.(\d+)/);
  return m ? Number(m[1]) * 10 + Number(m[2]) : null;
}

export function major(version) {
  const m = String(version || '').match(/^(\d+)\.(\d+)/);
  return m ? `${m[1]}.${m[2]}` : String(version || '');
}

/** Number of x.y releases between two versions; 6.8 -> 6.9 -> 7.0 counts as two. */
export function releasesBehind(tested, latest) {
  const a = releaseIndex(tested);
  const b = releaseIndex(latest);
  if (a === null || b === null) return 0;
  return Math.max(0, b - a);
}

export function span(seconds) {
  const months = Math.floor(seconds / (30.44 * DAY));
  const y = Math.floor(months / 12);
  const m = months % 12;
  const part = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  if (y === 0) return part(Math.max(m, 1), 'month');
  return m ? `${part(y, 'year')} ${part(m, 'month')}` : part(y, 'year');
}

function notCheckedReason(status) {
  switch (status) {
    case 'not_found':
      return 'Not hosted on WordPress.org, so there is no public data to check.';
    case 'mismatch':
      return 'A different product uses this slug on WordPress.org, so it was not checked.';
    case 'invalid':
      return 'Not a valid WordPress.org slug or plugin URL.';
    default:
      return 'WordPress.org could not be reached. This is not a sign of abandonment; try again later.';
  }
}

/**
 * Scores a record. ownerEvent is '', 'owner_changed' or 'contributors_changed'.
 * Returns { score, grade, reasons }.
 */
export function score(record, nowSeconds, latestWp, ownerEvent = '') {
  if (record.status === 'closed') {
    const reasons = [];
    if (record.closed_date && record.closed_reason) reasons.push(`Closed on WordPress.org on ${record.closed_date} (reason: ${record.closed_reason}).`);
    else if (record.closed_date) reasons.push(`Closed on WordPress.org on ${record.closed_date}.`);
    else reasons.push('Closed on WordPress.org.');
    reasons.push('It gets no more updates from WordPress.org. Look for a replacement.');
    return { score: 0, grade: 'closed', reasons };
  }
  if (record.status !== 'ok') {
    return { score: null, grade: 'not_checked', reasons: [notCheckedReason(record.status)] };
  }

  let value = 100;
  const reasons = [];

  const last = record.last_updated ? Date.parse(`${record.last_updated}T00:00:00Z`) / 1000 : NaN;
  if (Number.isFinite(last) && last > 0) {
    const age = Math.max(0, nowSeconds - last);
    let d = 0;
    if (age > 2 * YEAR) d = 45;
    else if (age > YEAR) d = 25;
    else if (age > 182 * DAY) d = 10;
    if (d) {
      value -= d;
      reasons.push(`No release for ${span(age)} (last: ${record.last_updated}).`);
    }
  }

  if (latestWp) {
    const behind = releasesBehind(record.tested, latestWp);
    // One release behind is normal for weeks after every WordPress release.
    if (behind >= 3) value -= 25;
    else if (behind >= 2) value -= 10;
    if (behind >= 2) reasons.push(`Tested up to WordPress ${record.tested}; the latest is ${major(latestWp)}.`);
  }

  // Threads are marked resolved by the people who open them, so only a large
  // sample with almost nothing resolved is a signal.
  const threads = record.support_threads || 0;
  const resolved = record.support_resolved || 0;
  if (threads >= 10 && resolved / threads < 0.2) {
    value -= 10;
    reasons.push(`Only ${resolved} of ${threads} support threads resolved in the last two months.`);
  }

  if (ownerEvent === 'owner_changed') {
    value -= 30;
    reasons.push('The owner on WordPress.org changed since the last snapshot. Review the next update before installing it.');
  } else if (ownerEvent === 'contributors_changed') {
    value -= 10;
    reasons.push('The list of contributors changed since the last snapshot.');
  }

  value = Math.max(0, Math.min(100, value));
  const grade = value >= 80 ? 'healthy' : value >= 50 ? 'watch' : 'at_risk';
  return { score: value, grade, reasons };
}

/** Compares a record with a saved snapshot entry. */
export function ownerEvent(record, previous) {
  if (!previous || record.status !== 'ok') return '';
  if (previous.owner && record.owner && previous.owner !== record.owner) return 'owner_changed';
  const a = (previous.contributors || []).join(',');
  const b = (record.contributors || []).join(',');
  if (previous.contributors && a !== b) return 'contributors_changed';
  return '';
}

// ---------------------------------------------------------------------------
// Running

async function pool(items, worker) {
  const out = new Array(items.length);
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await worker(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, run));
  return out;
}

export async function vet(items, opts = {}) {
  const nowSeconds = Math.floor((opts.now ? Date.parse(opts.now) : Date.now()) / 1000);
  const latestWp = opts.latestWp || (await fetchLatestWp(opts.fixtures));
  const previous = opts.snapshot && opts.snapshot.plugins ? opts.snapshot.plugins : null;

  const results = await pool(items, async (item) => {
    let record;
    if (!item.slug) {
      record = { status: 'invalid' };
    } else {
      const { code, data } = await fetchPlugin(item.slug, opts.fixtures);
      record = normalize(code, data);
      if (record.status === 'ok' && item.local && looksLikeOtherProduct(item.local.title, record.name)) {
        record = { status: 'mismatch', name: record.name };
      }
    }
    const event = previous ? ownerEvent(record, previous[item.slug]) : '';
    const result = score(record, nowSeconds, latestWp, event);
    return { input: item.input, slug: item.slug, local: item.local || null, record, ...result };
  });

  results.sort((a, b) => GRADE_ORDER.indexOf(a.grade) - GRADE_ORDER.indexOf(b.grade) || (a.score ?? 101) - (b.score ?? 101) || String(a.slug).localeCompare(String(b.slug)));

  return {
    generated: new Date(nowSeconds * 1000).toISOString(),
    latest_wordpress: latestWp,
    method: METHOD_URL,
    compared_with_snapshot: Boolean(previous),
    results,
  };
}

export function snapshotOf(report) {
  const plugins = {};
  for (const r of report.results) {
    if (r.slug && r.record.status === 'ok') plugins[r.slug] = { owner: r.record.owner, contributors: r.record.contributors };
  }
  return { generated: report.generated, tool: `plugevity-skills/${VERSION}`, plugins };
}

function cell(s) {
  return String(s ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
}

export function toMarkdown(report) {
  const counts = {};
  for (const r of report.results) counts[r.grade] = (counts[r.grade] || 0) + 1;
  const summary = GRADE_ORDER.filter((g) => counts[g]).map((g) => `${counts[g]} ${GRADES[g].toLowerCase()}`).join(', ');
  const lines = [];
  lines.push(`**${report.results.length} plugin${report.results.length === 1 ? '' : 's'} checked:** ${summary}.`);
  lines.push('');
  lines.push('| Plugin | Score | Grade | Why |');
  lines.push('| --- | --- | --- | --- |');
  for (const r of report.results) {
    const label = r.record.status === 'ok' || r.record.status === 'closed' ? r.record.name : r.local && r.local.title;
    const name = label ? `${label} (\`${r.slug}\`)` : r.slug ? `\`${r.slug}\`` : cell(r.input);
    const why = [...r.reasons];
    if (r.local && r.local.status === 'inactive') why.push('Inactive on the site.');
    if (r.local && r.local.update_version) why.push(`Update available on the site: ${r.local.version} -> ${r.local.update_version}.`);
    lines.push(`| ${cell(name)} | ${r.score ?? '-'} | ${GRADES[r.grade]} | ${cell(why.join(' ') || 'No warning signs.')} |`);
  }
  lines.push('');
  const wp = report.latest_wordpress ? `latest WordPress ${major(report.latest_wordpress)}` : 'latest WordPress unknown, so "tested up to" was not scored';
  lines.push(`Data: public WordPress.org API, ${report.generated.slice(0, 10)}; ${wp}.${report.compared_with_snapshot ? ' Owners compared with the saved snapshot.' : ' Owner changes need a saved snapshot (--save, then --compare).'}`);
  lines.push(`Method: Plugevity Health Score signals (${report.method}). A score is a maintenance signal, not a security audit.`);
  return lines.join('\n');
}

function parseArgs(argv) {
  const opts = { inputs: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value.`);
      return argv[++i];
    };
    if (a === '--json') opts.json = true;
    else if (a === '--wp-cli') opts.wpCli = val();
    else if (a === '--save') opts.save = val();
    else if (a === '--compare') opts.compare = val();
    else if (a === '--latest-wp') opts.latestWp = val();
    else if (a === '--now') opts.now = val();
    else if (a === '--fixtures') opts.fixtures = val();
    else if (a === '-h' || a === '--help') opts.help = true;
    else if (a.startsWith('--')) throw new Error(`Unknown option ${a}.`);
    else opts.inputs.push(a);
  }
  return opts;
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  if (opts.help || (!opts.inputs.length && !opts.wpCli)) {
    console.error('Usage: node vet.mjs <slug|URL> [...] | --wp-cli <file|-> [--json] [--save file] [--compare file]');
    process.exit(opts.help ? 0 : 2);
  }

  let items = opts.inputs.map((input) => ({ input, slug: toSlug(input), local: null }));
  if (opts.wpCli) {
    const raw = readFileSync(opts.wpCli === '-' ? 0 : opts.wpCli, 'utf8');
    try {
      items = items.concat(fromWpCli(JSON.parse(raw)));
    } catch (e) {
      console.error(`Could not read the plugin list: ${e.message}`);
      process.exit(2);
    }
  }

  let snapshot = null;
  if (opts.compare) {
    try {
      snapshot = JSON.parse(readFileSync(opts.compare, 'utf8'));
    } catch {
      console.error(`No readable snapshot at ${opts.compare}; owner changes were not compared.`);
    }
  }

  const report = await vet(items, { ...opts, snapshot });
  if (opts.save) writeFileSync(opts.save, `${JSON.stringify(snapshotOf(report), null, 2)}\n`);
  console.log(opts.json ? JSON.stringify(report, null, 2) : toMarkdown(report));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();
