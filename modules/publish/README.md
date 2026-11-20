# publish

The store publish scripts, synced into `scripts/publishing/` and `scripts/lib/env.mjs`:

- `publish-all.mjs` (`yarn publish:all`): the checks, then each store in order. A store that fails doesn't stop the others. Each store that takes the version is recorded in `.publish-status.json`, so a rerun publishes only to the stores still missing it, and skips the checks that passed (or were skipped with their flag) for this code.
- `publish-chrome.mjs`, `publish-edge.mjs`, `publish-firefox.mjs`: one store each. Each builds a fresh production artifact right before it uploads.
- `publish-log.mjs` (`yarn publish:log [N] [--json]`): prints `.publish-log.jsonl`, the record of every run (started, published, failed, aborted, unconfirmed).
- `refresh-chrome-token.mjs` (`yarn refresh:chrome`): mints a new `CHROME_REFRESH_TOKEN` into `.env`.
- `common.mjs` and `settings.mjs`: the guards and settings they share. `lib/env.mjs`: `.env` without a dependency.
- `__tests__/publish.test.mjs`: the flow end to end in scratch git repos, with a fake yarn, pbcopy, open and web-ext, and a fetch stub. In a repo it runs with that repo's settings and `.gitignore`, and also checks that `package.json` has the scripts the settings name.

Every publish refuses to start when the version has no VERSION HISTORY entry, when the extension's files have uncommitted or untracked changes, or when Node isn't the version `.nvmrc` names. It refuses other code under a version a store already has. It runs `yarn install --immutable` before each build and stops if the extension's files change while it builds. Firefox's source zip is a `git archive` of the commit built.

## Settings

In the repo's `shared.json`, under `modules.publish`. An unknown setting stops every script.

| Setting | Required | What |
| --- | --- | --- |
| `stores` | yes | Some of `chrome`, `edge`, `firefox`, in the order `publish:all` goes through them. Put Firefox last: its step only waits on AMO. |
| `showsReleaseNotes` | yes | Whether the extension shows its release notes (a popup card, say). When `false`, a reworded description isn't new code, so a store still missing the version can get it. When `true`, it is: a reworded note needs a new version, and the listing step stops before submitting if the description changes while it waits, since the uploaded package has the old note. |
| `notesGlobal` | when `showsReleaseNotes` is false | The build-time global the notes would reach the code by (`__CHANGELOG__`). A test checks nothing in `src` reads it. |
| `versionLine` | yes | How the build finds a version's VERSION HISTORY line: `version` (`0.0.7`), `date - version` (`2026/11/16 - 0.0.1`) or `either`. The note is the next line. |
| `notBuildInputs` | yes | Git pathspecs for the tracked files that aren't the extension's code (tests, scripts, docs, repo config). Everything else, the dependencies included, is what a version is made from. Include `shared.json` and `shared.lock.json` unless the build reads them. |
| `privacyFile` | no | The store privacy answers (`STORE_PRIVACY.txt`). When set, Chrome's listing step asks for the Privacy tab too and points to this file. |
| `build` | no | The yarn script that makes each store's production build. Defaults: `build-chrome`, `build-edge`, `build-firefox`. They make `chrome.zip`, `edge.zip` and `dist-firefox/`. |
| `checks` | no | What `publish:all` runs before any store, each `{ "script", "label"?, "skipFlag"?, "remember"? }`. Default: `[{ "script": "preflight" }]`. A pass is remembered for the code it passed on, so a rerun skips it; `"remember": false` runs it every time, for a check that caches itself. A check with a `skipFlag` (`--skip-signin`) can be skipped with it. |
| `clearEnv` | no | Variables that make test builds, left out of the checks' and builds' environment (`STAGING`, `DIST_DIR`). |
| `sourceZip` | no | The Firefox source zip's name. Default `source.zip`. |
| `sourceZipExcludes` | no | Pathspecs left out of the source zip (`dist-*`, `*.env*`). |
| `chromeDashboardUser` | no | The `/u/<n>/` in Chrome dashboard links, when the publisher isn't the browser's first Google account. |
| `storeCheck` | no | A command `publish:log` suggests for what each store serves now. |

## Environment (`.env`)

- Chrome: `CHROME_EXTENSION_ID`, `CHROME_CLIENT_ID`, `CHROME_CLIENT_SECRET`, `CHROME_REFRESH_TOKEN`; optional `CHROME_DASHBOARD_ID` (the publisher id in dashboard links) and `OAUTH_PORT` (the token refresh's port, 3000).
- Edge: `EDGE_PRODUCT_ID`, `EDGE_CLIENT_ID`, `EDGE_API_KEY`; optional `EDGE_API_KEY_EXPIRY`, which warns two weeks ahead and stops once it's passed.
- Firefox: `FIREFOX_JWT_ISSUER`, `FIREFOX_JWT_SECRET`; optional `FIREFOX_EXTENSION_ID` (else the built manifest's gecko id). `PUBLISH_FIREFOX_ACCEPT_EXISTING=1` records a version AMO already has when nothing here shows it was this code.

The repo's `.gitignore` should cover `.publish-status.json`, `.publish-log.jsonl`, the zips, `web-ext-artifacts/` and `.env`. The scripts never count their own files as the extension's.

## package.json scripts a repo needs

`publish:all`, `publish:chrome`, `publish:firefox`, `publish:firefox:text` (`publish-firefox.mjs --text-only`), `publish:log`, `refresh:chrome`, plus `publish:edge` when Edge is a store; the build scripts; and the checks.
