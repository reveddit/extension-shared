# reports

A site's problem reports: the form the extension's "Report a problem" opens, what handles it at `/api/feedback`, and the inbox the developer reads them in. Synced into `src/lib/` and `test/`:

- `report.js`: reads the details the extension's link carries after `#r=` (version, browser, status summary, diagnostic log), and hides the ids in them behind stand-ins.
- `feedback-form.js`: the report page's script. With details, it shows them and lets the person hide ids or leave the details out; with none, it shows the page's hint about the extension's button. It sends a report privately, or opens a public GitHub issue with ids always hidden and the log on the clipboard.
- `feedback-handler.js`: the handler's core and the inbox. A report must come from the site's own page (or a local preview), be at most 64 KB, and have a message. A filled-in hidden field is thanked and dropped. The site's counter decides whether to keep it and whether to file it. It's kept in KV as `fb_*` and filed as an issue by the private repository's `file-report.yml` workflow, with the person's words fenced and their username and email as inline code, so nothing turns into a mention or a link. The inbox (`?key=<FEEDBACK_KEY>`) lists, marks and deletes only `fb_*` keys.
- `report-settings.js`: the settings' checks and defaults, and `formSettings`, the part the page gets.
- `test/*.test.mjs` (node's test runner): run with the repo's own settings, and here once per case in `test-cases.json`. In a repo, one also checks that `src/pages/feedback.astro` has every element the script uses.

## What each site keeps

- **Its entry**, which imports `shared.json` and calls `reportsHandler(shared.modules.reports)`: on Pages, `functions/api/feedback.js` exports `onRequestPost` and `onRequestGet`; on a Worker, the router calls `post` and `inbox`.
- **Its counter**: `{ admit(sender) }`, answering `{ ok, why, file }` for one more report from `sender`, a salted hash of the address (an IPv6 sender's /64, and one shared value for a request with no address). `why` is `'sender'` or `'site'` when it's no; `file: false` keeps a report without filing it. A counter that throws or answers nothing turns the report away with a 503. A Pages site counts per sender in KV, read then write, so two reports at once can both pass. A Worker's Durable Object counts once for the whole site, so its caps hold everywhere at once.
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

Wrong settings fail the build there (`formSettings`) and stop the handler before it takes a report (`reportsHandler`).

## Settings

In the site's `shared.json`, under `modules.reports`. An unknown setting is an error.

| Setting | Required | What |
| --- | --- | --- |
| `origin` | yes | The site's address (`https://example.com`). Reports from any other page get a 403, except from a local preview (`http://localhost`, `http://127.0.0.1`, any port). |
| `product` | yes | The extension's name: in each issue, the inbox, and the form's details line. |
| `userLabel` | yes | Whose username the form asks for, as each issue names it (`forum user`). |
| `publicRepo` | yes | The public repository, `owner/name`, whose `problem.yml` issue form "Post publicly on GitHub" opens. |
| `privateRepo` | yes | The private repository, `owner/name`, whose `file-report.yml` workflow files each report as an issue, and which the inbox links to. |
| `ids` | yes | The word for what the log's ids (`#123`) name: "where post ids are now hidden". |
| `caps` | yes | The hourly caps the site's counter keeps: `perSender`, and for a counter that counts the whole site, `keptPerHour` (past it, a report is turned away) and `filedPerHour` (past it, a report is kept but not filed). Whole numbers above 0. The core doesn't read them; the site's counter does. |
| `typeNames` | no | The names issue titles start with, for `bug`, `feature`, `question` and `other`. Defaults: Problem, Idea, Question, Feedback. |
| `messages` | no | The form's `empty` (no message) and `sent` texts. Defaults: "Please say what happened." and "Sent. Thank you!" |
| `accent` | no | The inbox's badge color, like `#1d9bf0`. |

## Environment (the site's bindings and secrets)

- `FEEDBACK`: a KV namespace, the reports (`fb_*`). A Pages site's counts go there too.
- `FEEDBACK_KEY` (secret): the inbox's key, and the salt for the senders' hashes. With none set there's no inbox.
- `GITHUB_TOKEN` (secret): a fine-grained token with Actions read and write on `privateRepo` only. Without it a report is only kept.

The private repository's workflow takes `title`, `body` and `labels` (comma-separated), on `main`.
