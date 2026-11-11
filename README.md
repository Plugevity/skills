# Plugevity skills

Agent skills for choosing, maintaining and publishing WordPress plugins that last.

For site owners and agencies, from public WordPress.org data, with every answer explained:

- **Can I rely on this plugin?** ([`plugin-vetting`](skills/plugin-vetting/SKILL.md))
- **Which plugins on this site need attention?** ([`site-plugin-audit`](skills/site-plugin-audit/SKILL.md))
- **Has this plugin changed hands?** ([`plugin-ownership-check`](skills/plugin-ownership-check/SKILL.md))

For plugin authors:

- **What happens to my plugin if I stop or sell it?** ([`plugin-continuity-plan`](skills/plugin-continuity-plan/SKILL.md))
- **Does my readme answer what people search for?** ([`wporg-readme-search`](skills/wporg-readme-search/SKILL.md))

The first two use the scoring method of the [Plugevity Health Score](https://plugevity.com/plugins/health-score/)
WordPress plugin: last release, closure on WordPress.org, "tested up to", support replies and
ownership changes, calibrated on 31 real plugins. See [the method](skills/plugin-vetting/references/method.md).

## Install

With the [skills CLI](https://www.npmjs.com/package/skills), for any agent that supports Agent Skills:

```bash
npx skills add plugevity/skills
# or one skill
npx skills add plugevity/skills --skill plugin-vetting
```

Or copy a folder from `skills/` into your agent's skills directory.

## Example

Ask your agent "audit the plugins on this site". It runs `wp plugin list` (read-only) and the
bundled script, then writes a plan. The script's table, here with fictional plugins:

| Plugin | Score | Grade | Why |
| --- | --- | --- | --- |
| Demo Gallery (`demo-gallery`) | 0 | Closed | Closed on WordPress.org on 2026-04-07 (reason: Security Issue). It gets no more updates from WordPress.org. Look for a replacement. Inactive on the site. |
| Demo Slider (`demo-slider`) | 30 | At risk | No release for 3 years 5 months (last: 2023-06-02). Tested up to WordPress 6.2.2; the latest is 7.1. |
| Acme Backup Pro (`demo-backup`) | - | Not checked | A different product uses this slug on WordPress.org, so it was not checked. |
| Demo Forms (`demo-forms`) | 100 | Healthy | Update available on the site: 5.0.9 -> 5.1.0. |

You can also run the script yourself (Node 18+, no dependencies):

```bash
node skills/plugin-vetting/scripts/vet.mjs contact-form-7 https://wordpress.org/plugins/classic-editor/
wp plugin list --format=json --fields=name,title,status,version,update_version \
  | node skills/site-plugin-audit/scripts/vet.mjs --wp-cli - --save plugin-owners.json
```

## What they do not do

- They read and report. They never update, deactivate or delete a plugin.
- A handover between committers is not proof of a sale, and a sale is not proof of harm.
- A score is a maintenance signal, not a security audit or a code review.
- Premium and custom plugins have no public data, so they are shown as "Not checked".
- An ownership change is only visible when you keep the snapshot from an earlier run.

## Privacy

The scripts send plugin slugs to `api.wordpress.org` (and, for the ownership check, read the
public SVN log at `plugins.svn.wordpress.org`) and nowhere else. Nothing is sent to
Plugevity. (The `npx skills` installer has its own anonymous install counts; set
`DISABLE_TELEMETRY=1` to turn them off.)

## Development

```bash
npm test        # offline tests with fictional fixtures
npm run sync    # copy the script from plugin-vetting to site-plugin-audit after a change
```

Behavior evals for the skills are in [`evals/evals.json`](evals/evals.json).

## License

MIT. Made by [Plugevity](https://plugevity.com), free WordPress plugins built to last.
