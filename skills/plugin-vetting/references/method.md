# Scoring method

The same rules as the [Plugevity Health Score](https://plugevity.com/plugins/health-score/)
WordPress plugin, so a result here matches what the plugin shows inside WordPress.

## Data

One request per plugin to the public WordPress.org Plugins API:

```
https://api.wordpress.org/plugins/info/1.2/?action=plugin_information&request[slug]=<slug>
```

Fields used: `last_updated`, `tested`, `support_threads`, `support_threads_resolved` (last
two months), `author_profile` (owner), `contributors`, and for closed plugins `closed_date`
and `reason_text`. The latest WordPress version comes from
`https://api.wordpress.org/core/version-check/1.7/`.

## Score

Start at 100, subtract, clamp to 0-100.

| Signal | Deduction |
|---|---|
| Closed on WordPress.org | score 0, grade "Closed" (overrides everything) |
| Last release more than 2 years ago | -45 |
| Last release more than 1 year ago | -25 |
| Last release more than 6 months ago | -10 |
| "Tested up to" 3 or more `x.y` releases behind the latest WordPress | -25 |
| "Tested up to" 2 releases behind | -10 |
| 10 or more support threads in two months and under 20% resolved | -10 |
| Owner changed since the saved snapshot | -30 |
| Contributors changed, owner the same | -10 |

Grades: 80-100 Healthy, 50-79 Watch, 0-49 At risk, plus Closed and Not checked.

## Why these weights

- One release behind is not a deduction. Most maintained plugins lag a new WordPress release
  for weeks, and WordPress.org itself only warns at three.
- The number of contributors is not scored. Company accounts often list one.
- Support threads are marked resolved by the people who open them, so only a large sample
  with almost nothing resolved counts.
- Weights were checked against 31 real plugins (large, small-but-alive and stale) on
  2026-11-04: 28 healthy, 2 watch, 1 at risk, with no false warnings on maintained plugins.

## Limits

- Premium plugins and plugins updated from outside WordPress.org have no public data. They
  are "Not checked", never scored.
- A small, finished plugin can be fine after a year without a release. The score says
  "look closer", not "remove".
- Ownership changes are invisible without an earlier snapshot to compare with.
