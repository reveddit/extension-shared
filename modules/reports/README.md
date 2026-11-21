# reports

A site's problem reports: the form the extension's "Report a problem" opens, the site's Worker that handles it at `/api/feedback`, and the inbox the developer reads them in. Every site runs the same Worker; it differs only in `shared.json` and its deploy config. Synced into `src/lib/`, `worker/` and `test/`:

- `report.js`: reads the details the extension's link carries after `#r=` (version, browser, status summary, diagnostic log), and hides the ids in them behind stand-ins.
- `feedback-form.js`: the report page's script. With details, it shows them and lets the person hide ids or leave the details out; with none, it shows the page's hint about the extension's button. It sends a report privately, or opens a public GitHub issue with ids always hidden and the log on the clipboard.
- `feedback-handler.js`: the handler's core and the inbox. A report must come from the site's own page (or a local preview), be at most 64 KB, and have a message. A filled-in hidden field is thanked and dropped. The site's counter decides whether to keep it and whether to file it. It's kept in KV as `fb_*` and filed as an issue by the private repository's `file-report.yml` workflow, with the person's words fenced and their username and email as inline code, so nothing turns into a mention or a link. The inbox (`?key=<FEEDBACK_KEY>`) lists, marks and deletes only `fb_*` keys.
- `report-worker.js`: the Worker's router. The deploy config sends only `/api/*` to the Worker, and Cloudflare serves every page as a static file. `/api/feedback` takes a report (POST) or shows the inbox (GET); anything else gets a 404.
- `report-counts.js`: the hourly counting, `admitCounts`.
- `worker/index.js`: the Worker's entry, and `Limits`, the Durable Object that counts the site's reports. Every report asks the same object, one at a time, so the caps hold everywhere at once. It keeps only the current hour's counts, as salted hashes of senders, and an alarm drops them within two hours. Node can't load this file, since it imports `cloudflare:workers`; the tests load `report-worker.js` and `report-counts.js`.
- `report-settings.js`: the settings' checks and defaults, and `formSettings`, the part the page gets.
- `test/*.test.mjs` (node's test runner): run with the repo's own settings, and here once per case in `test-cases.json`. In a repo, two also check the site's own parts: that `src/pages/feedback.astro` has every element the script uses, and that `deploy/cloudflare.config.ts` gives the Worker what it needs.

## What each site keeps

- **Its page**, `src/pages/feedback.astro`: the markup, with the ids in `PAGE_IDS` (`feedback-form.js`), the hint (`fb-from-extension`) and the details box (`fb-details`) starting `hidden`, and the settings on the form:

```astro
---
import shared from '../../shared.json'
import { formSettings } from '../lib/report-settings.js'
---
<form id="fb-form" class="fb-form" novalidate data-settings={JSON.stringify(formSettings(shared.modules.reports))}>
...
<script>
  import { startReportForm } from '../lib/feedback-form.js'
  startReportForm()
</script>
```

- **Its deploy config**, `deploy/cloudflare.config.ts` for `cf deploy`: the Worker's name, the site's domain, the KV namespace's id. It points the entrypoint at `../worker/index.js`, sends `/api/*` to the Worker first (`runWorkerFirst`), serves the 404 page for a missing one, exports `Limits` as a Durable Object (SQLite storage), and binds `FEEDBACK` (KV), `LIMITS` (the Durable Object) and the two secrets. `deploy/package.json` declares `cf` and `wrangler`, whose node_modules the config's `cf/config` import resolves from.

Wrong settings fail the build (`formSettings`) and stop the Worker before it takes a report (`reportsHandler`).

## Settings

In the site's `shared.json`, under `modules.reports`. An unknown setting is an error.

| Setting | Required | What |
| --- | --- | --- |
| `origin` | yes | The site's address (`https://example.com`), which is also its deploy config's domain. Reports from any other page get a 403, except from a local preview (`http://localhost`, `http://127.0.0.1`, any port). |
| `product` | yes | The extension's name: in each issue, the inbox, and the form's details line. |
| `userLabel` | yes | Whose username the form asks for, as each issue names it (`forum user`). |
| `publicRepo` | yes | The public repository, `owner/name`, whose `problem.yml` issue form "Post publicly on GitHub" opens. |
| `privateRepo` | yes | The private repository, `owner/name`, whose `file-report.yml` workflow files each report as an issue, and which the inbox links to. |
| `ids` | yes | The word for what the log's ids (`#123`) name: "where post ids are now hidden". |
| `caps` | yes | The hourly caps: `perSender` (from one sender), `keptPerHour` (from everyone together; past it, a report is turned away) and `filedPerHour` (filed as issues from everyone together; past it, a report is kept but not filed). Whole numbers above 0. |
| `typeNames` | no | The names issue titles start with, for `bug`, `feature`, `question` and `other`. Defaults: Problem, Idea, Question, Feedback. |
| `messages` | no | The form's `empty` (no message) and `sent` texts. Defaults: "Please say what happened." and "Sent. Thank you!" |
| `accent` | no | The inbox's badge color, like `#1d9bf0`. |

## Environment (the Worker's bindings and secrets)

- `FEEDBACK`: a KV namespace, the reports (`fb_*`).
- `LIMITS`: the `Limits` Durable Object.
- `FEEDBACK_KEY` (secret): the inbox's key, and the salt for the senders' hashes. With none set there's no inbox.
- `GITHUB_TOKEN` (secret): a fine-grained token with Actions read and write on `privateRepo` only. Without it a report is only kept.

Set the secrets with `cf workers secrets update <NAME> --worker <worker>`, never in a file. The private repository's workflow takes `title`, `body` and `labels` (comma-separated), on `main`.
