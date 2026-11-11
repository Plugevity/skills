#!/usr/bin/env node
// Looks for a change of hands in a WordPress.org plugin's public history.
//
// Read-only. Network calls: one GET to api.wordpress.org and one SVN log REPORT to
// plugins.svn.wordpress.org per plugin. No dependencies; needs Node 18 or later.
//
// Usage:
//   node ownership.mjs <slug|wordpress.org URL> [...] [--json]
//
// Options:
//   --json             Print JSON instead of Markdown.
//   --now <date>       Judge recency as of this date (ISO 8601). For tests.
//   --fixtures <dir>   Read <dir>/<slug>.json (API) and <dir>/<slug>.svnlog.xml. For tests.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const VERSION = '0.1.0';
const PLUGIN_API = 'https://api.wordpress.org/plugins/info/1.2/';
const SVN = 'https://plugins.svn.wordpress.org/';
const USER_AGENT = `plugevity-skills/${VERSION}`;
const TIMEOUT_MS = 60000;
const DAY = 86400;
const YEAR = 365 * DAY;
// The account that creates every new repository; never a maintainer.
const SYSTEM_ACCOUNTS = new Set(['plugin-master']);
// Owners that are WordPress.org itself: committers rotate inside the project.
const PROJECT_OWNERS = new Set(['wordpressdotorg']);
const LOG_BODY =
  '<?xml version="1.0" encoding="utf-8"?><S:log-report xmlns:S="svn:"><S:start-revision>0</S:start-revision>' +
  '<S:end-revision>-1</S:end-revision><S:limit>0</S:limit><S:path></S:path><S:revprop>svn:author</S:revprop>' +
  '<S:revprop>svn:date</S:revprop></S:log-report>';

export function toSlug(input) {
  let s = String(input || '').trim();
  const m = s.match(/^https?:\/\/(?:[a-z-]+\.)?wordpress\.org\/plugins\/([^/?#]+)/i);
  if (m) s = m[1];
  s = s.toLowerCase();
  return /^[a-z0-9][a-z0-9-]{0,199}$/.test(s) ? s : null;
}

/** Account names are data: keep only characters WordPress.org allows in a username. */
export function account(value) {
  return String(value || '')
    .replace(/[^A-Za-z0-9_.@-]/g, '')
    .slice(0, 60);
}

function plain(value) {
  return String(value ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/[\u0000-\u001f\u007f|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

// ---------------------------------------------------------------------------
// Fetching

async function request(url, init = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, headers: { 'user-agent': USER_AGENT, ...(init.headers || {}) }, signal: ctrl.signal });
    return { code: res.status, text: await res.text() };
  } catch {
    return { code: 0, text: '' };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchInfo(slug, fixtures) {
  if (fixtures) {
    try {
      return { code: 200, data: JSON.parse(readFileSync(join(fixtures, `${slug}.json`), 'utf8')) };
    } catch {
      return { code: 0, data: null };
    }
  }
  const p = new URLSearchParams({ action: 'plugin_information', 'request[slug]': slug });
  for (const f of ['sections', 'description', 'screenshots', 'versions', 'reviews', 'banners', 'icons', 'ratings', 'tags']) p.set(`request[fields][${f}]`, '0');
  const { code, text } = await request(`${PLUGIN_API}?${p}`);
  try {
    return { code, data: JSON.parse(text) };
  } catch {
    return { code, data: null };
  }
}

async function fetchLog(slug, fixtures) {
  if (fixtures) {
    try {
      return { code: 200, text: readFileSync(join(fixtures, `${slug}.svnlog.xml`), 'utf8') };
    } catch {
      return { code: 0, text: '' };
    }
  }
  return request(`${SVN}${slug}/`, { method: 'REPORT', headers: { 'content-type': 'text/xml' }, body: LOG_BODY });
}

// ---------------------------------------------------------------------------
// Analysis

/** Parses an SVN log-report into [{ rev, author, date }], oldest first. */
export function parseLog(xml) {
  const out = [];
  for (const item of String(xml).split('<S:log-item>').slice(1)) {
    const rev = item.match(/<D:version-name>(\d+)<\/D:version-name>/);
    const author = item.match(/<D:creator-displayname>([^<]*)<\/D:creator-displayname>/);
    const date = item.match(/<S:date>(\d{4}-\d{2}-\d{2})/);
    if (rev && date) out.push({ rev: Number(rev[1]), author: account(author ? author[1] : ''), date: date[1] });
  }
  return out.sort((a, b) => a.rev - b.rev);
}

/** Groups commits by account: first and last commit, count. Oldest account first. */
export function committers(commits) {
  const map = new Map();
  for (const c of commits) {
    if (!c.author) continue;
    const e = map.get(c.author) || { account: c.author, first: c.date, firstRev: c.rev, last: c.date, lastRev: c.rev, commits: 0 };
    e.last = c.date;
    e.lastRev = c.rev;
    e.commits++;
    map.set(c.author, e);
  }
  return [...map.values()].sort((a, b) => a.firstRev - b.firstRev);
}

const ts = (d) => Date.parse(`${d}T00:00:00Z`) / 1000;

/**
 * Finds handovers: an account that started committing at least a year after the
 * repository began, after which no earlier account committed again (a 30-day overlap
 * for the handover itself is allowed). `owner` is today's owner on WordPress.org.
 */
export function analyse(commits, { closedDate = '', now = Date.now() / 1000, owner = '' } = {}) {
  // After a closure the WordPress.org team commits; those commits are not the maintainer's.
  const own = commits.filter((c) => !SYSTEM_ACCOUNTS.has(c.author.toLowerCase()) && !(closedDate && c.date >= closedDate));
  const people = committers(own);
  if (people.length === 0) return { verdict: 'no_history', people, handovers: [] };

  const start = ts(people[0].first);
  const handovers = [];
  for (const p of people) {
    if (ts(p.first) - start < YEAR) continue;
    const earlier = people.filter((q) => q.firstRev < p.firstRev);
    const stillActive = earlier.filter((q) => ts(q.last) > ts(p.first) + 30 * DAY);
    if (!earlier.length || stillActive.length) continue;
    const lastBefore = earlier.reduce((m, q) => (q.lastRev > m.lastRev ? q : m));
    handovers.push({
      to: p.account,
      date: p.first,
      from: earlier.filter((q) => ts(p.first) - ts(q.last) < 2 * YEAR || q === lastBefore).map((q) => q.account),
      earlier: earlier.map((q) => q.account),
      silence_days: Math.max(0, Math.round((ts(p.first) - ts(lastBefore.last)) / DAY)),
    });
  }

  if (!handovers.length) return { verdict: people.length > 1 ? 'shared' : 'single', people, handovers };
  const last = handovers[handovers.length - 1];
  const o = owner.toLowerCase();
  if (o && (PROJECT_OWNERS.has(o) || last.earlier.some((a) => a.toLowerCase() === o))) return { verdict: 'committers_changed', people, handovers };
  return { verdict: now - ts(last.date) < 2 * YEAR ? 'recent_handover' : 'old_handover', people, handovers };
}

export async function check(slug, opts = {}) {
  const now = opts.now ? Date.parse(opts.now) / 1000 : Date.now() / 1000;
  const info = await fetchInfo(slug, opts.fixtures);
  const d = info.data && typeof info.data === 'object' ? info.data : null;
  const closed = Boolean(d && (d.closed || d.error === 'closed'));
  const notFound = Boolean(d && d.error && !closed);
  const base = {
    slug,
    name: d && d.name ? plain(d.name) : '',
    closed,
    closed_date: closed && d.closed_date ? String(d.closed_date).slice(0, 10) : '',
    closed_reason: closed ? plain(d.reason_text || d.reason || '') : '',
    owner: d && d.author_profile ? account((String(d.author_profile).match(/profiles\.wordpress\.org\/([^/]+)/) || [])[1]) : '',
    contributors: d && d.contributors && typeof d.contributors === 'object' ? Object.keys(d.contributors).map(account) : [],
    log_url: `https://plugins.trac.wordpress.org/log/${slug}/`,
  };
  if (notFound) return { ...base, verdict: 'not_found', people: [], handovers: [] };

  const log = await fetchLog(slug, opts.fixtures);
  if (log.code === 404) return { ...base, verdict: 'not_found', people: [], handovers: [] };
  if (log.code !== 200 && log.code !== 207) return { ...base, verdict: 'error', people: [], handovers: [] };
  const commits = parseLog(log.text);
  if (!commits.length) return { ...base, verdict: 'error', people: [], handovers: [] };
  return { ...base, ...analyse(commits, { closedDate: base.closed_date, now, owner: base.owner }) };
}

// ---------------------------------------------------------------------------
// Output

const HEADLINES = {
  recent_handover: 'Recent handover to new committers',
  old_handover: 'Handover to new committers, more than two years ago',
  committers_changed: 'Committers changed; today\'s owner is not new',
  shared: 'No change of hands; several committers',
  single: 'No change of hands; one committer',
  no_history: 'No maintainer commits found',
  not_found: 'Not hosted on WordPress.org',
  error: 'Could not read the history (not a sign of anything; try again later)',
};

export function toMarkdown(results) {
  const out = [];
  for (const r of results) {
    const title = r.name ? `${r.name} (\`${r.slug}\`)` : `\`${r.slug}\``;
    out.push(`### ${title}: ${HEADLINES[r.verdict]}`);
    out.push('');
    for (const h of r.handovers) {
      const gap = h.silence_days >= 180 ? ` after ${Math.round(h.silence_days / 30.44)} months without commits` : '';
      out.push(`- \`${h.to}\` started committing on ${h.date}${gap}; ${h.from.map((a) => `\`${a}\``).join(', ')} stopped.`);
    }
    if (r.owner) out.push(`- Owner on WordPress.org today: \`${r.owner}\`; contributors listed: ${r.contributors.length ? r.contributors.map((a) => `\`${a}\``).join(', ') : 'none'}.`);
    if (r.closed) out.push(`- Closed on WordPress.org${r.closed_date ? ` on ${r.closed_date}` : ''}${r.closed_reason ? ` (reason: ${r.closed_reason})` : ''}. Commits from that day on were left out.`);
    if (r.people.length) {
      out.push('');
      out.push('| Committer | First commit | Last commit | Commits |');
      out.push('| --- | --- | --- | --- |');
      for (const p of r.people) out.push(`| \`${p.account}\` | ${p.first} | ${p.last} | ${p.commits} |`);
    }
    out.push('');
    out.push(`Full history: ${r.log_url}`);
    out.push('');
  }
  out.push('Data: public WordPress.org plugin API and SVN log. A handover is normal and often fine (a team change, a company buying a plugin). It means the next update deserves a closer look, not that the plugin is unsafe.');
  return out.join('\n');
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
  if (opts.help || !opts.inputs.length) {
    console.error('Usage: node ownership.mjs <slug|URL> [...] [--json]');
    process.exit(opts.help ? 0 : 2);
  }
  const results = [];
  for (const input of opts.inputs) {
    const slug = toSlug(input);
    if (!slug) {
      console.error(`Skipped "${plain(input)}": not a WordPress.org slug or plugin URL.`);
      continue;
    }
    results.push(await check(slug, opts));
  }
  console.log(opts.json ? JSON.stringify(results, null, 2) : toMarkdown(results));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();
