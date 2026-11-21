# extension-shared

The one copy of the code the browser extensions share. Each repo keeps a committed copy of the modules it takes (no npm package, no submodule), and `sync.mjs` writes those copies from here, so a fix lands once.

Why copies: Mozilla's reviewers rebuild from a `git archive` of the extension's repo with `yarn install --immutable`, so the code a build or a publish runs has to be in that repo, and the repos' 7-day age gate would hold each new version of a package back a week.

## Layout

- `modules/<name>/module.json` lists the module's files (`files`) and its test files for each test runner it supports (`tests`: `{"vitest": [...], "node": [...]}`). They live under `modules/<name>/files/` at the paths they get in a repo, and the sync refuses a file there that `module.json` doesn't list.
- `modules/core/` goes to every repo: the test that fails the repo's `yarn test` when a synced file is edited there, as `scripts/shared-files.test.mjs` (vitest) or `test/shared-files.test.mjs` (node's test runner).
- `targets.json` lists the repos, as paths from this folder.
- `sync.mjs` is the sync, and `tests/` tests it.

Modules so far:

- `publish`: the store publish scripts (`yarn publish:all`, one script per store, the publish log, the Chrome token refresh) and their tests. Its settings are in [modules/publish/README.md](modules/publish/README.md).
- `reports`: a site's problem reports: the report page's script, and the site's Worker (the handler for `/api/feedback`, its inbox, the Durable Object that counts reports for the whole site, and the site's videos, sent in the parts a browser asks for so they can be skipped through), with their tests (node's test runner). Each site keeps its page markup and its deploy config. Its settings are in [modules/reports/README.md](modules/reports/README.md).

## In each repo

- `shared.json` names the modules the repo takes, with their settings: `{"modules": {"publish": {...}}}`. The synced code reads its settings from there, so the files themselves are the same in every repo and name no project. Names, URLs and anything else that differs go in the settings.
- `"testRunner"` in `shared.json` says what the repo's tests run with: `"vitest"` (the default) or `"node"` (`node --test test/*.test.mjs`; Node 22 reads a bare `test/` as a file name). The repo gets core's test and each module's tests in that runner's form, and the sync refuses a module that has no tests for it.
- `shared.lock.json` is written by the sync: each synced file with its sha256. Don't edit it.
- The synced files start with `// Synced from the shared source (see shared.json): change it there, not here.`

## Changing shared code

1. Edit the module here, under `modules/<name>/files/`. To add or remove a file, change `module.json` too.
2. `yarn test` here runs the sync's tests and each module's tests. The publish tests run once per case in `modules/publish/test-cases.json`, and the reports tests (with `node --test`, from `tests/node-tests.test.mjs`) once per case in `modules/reports/test-cases.json`.
3. `yarn diff` (`node sync.mjs --diff`) shows what each repo would get, and `yarn sync` writes it. `node sync.mjs ../twisitter` syncs one repo.
4. In each repo: run its checks (`yarn test`, `yarn typecheck`), then commit there. The sync never commits.
5. `yarn check` (`node sync.mjs --check`) exits 1 while any repo differs from here.

The sync won't overwrite or remove a repo's file it didn't write as it is now: one edited there since the last sync, or one that was there before the first. It lists them and stops. Move a change worth keeping into this source, then run it again with `--force`.

## Adding a repo or a module

- A repo: give it a `shared.json` and add it to `targets.json`. With vitest, its config must pick up `scripts/**/*.test.mjs` and the modules' test paths; with node's test runner (`"testRunner": "node"`), `node --test test/*.test.mjs` runs them. Then run `node sync.mjs --force <repo>` once, since the first sync replaces any hand-made copies.
- A module: add `modules/<name>/` with `module.json` and `files/`. Code that differs between repos reads its settings from `shared.json`'s `modules.<name>`. Give it tests that run here and in each repo, listed under `tests` for the runners of the repos that take it.
