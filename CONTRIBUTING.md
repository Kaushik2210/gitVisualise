# Contributing to gitvisualise

Thanks for wanting to help! This is a small, friendly, **zero-dependency** project, and it is deliberately easy to
hack on: a few plain Node files and one plain browser script. You do not need to be an expert. Typos, docs,
tests, a new language parser, or a wild new viewer feature are all welcome.

> **Not sure where to start?** Pick an issue labelled [good first issue](https://github.com/Kaushik2210/gitVisualise/labels/good%20first%20issue) or
> [help wanted](https://github.com/Kaushik2210/gitVisualise/labels/help%20wanted), and comment "I'll take this". Have your own idea? Open an issue or a
> [discussion](https://github.com/Kaushik2210/gitVisualise/discussions) first so we can point you at the right files.

## Ground rules (the four things that keep this project good)

1. **Grounded, never invented.** Every node, edge and narration step must be traceable to a real file (and line).
   The validator enforces it. Do not add features that guess.
2. **Zero runtime dependencies.** Node standard library only; the viewer is plain HTML/CSS/JS. If you think you need a
   package, open an issue first.
3. **The viewer is generic.** `viewer/` must never contain project-specific logic. Project knowledge lives in
   `architecture.json`.
4. **No paid APIs or keys** in the core path. Optional integrations are fine if they are opt-in.

## Setup

```bash
git clone https://github.com/Kaushik2210/gitVisualise.git gitvisualise
cd gitvisualise
node --version        # 18 or newer
npm test              # 7+ tests, ~1 second, no install step
```

Try your change on a real repo:

```bash
node skills/repo-architecture/scripts/gitvisualise.mjs all <some-repo> --out ./gv-demo
node skills/repo-architecture/scripts/gitvisualise.mjs serve <some-repo> --out ./gv-demo
```

## Where things live

| I want to... | Edit |
|---|---|
| Support a new language's imports | a new `scripts/lib/core/lang-xxx.mjs` plug-in, registered in `scripts/lib/core/languages.mjs` |
| Change how the baseline diagram is drawn up | `scripts/lib/generate.mjs` |
| Add a validation rule | `scripts/lib/core/validate-core.mjs` (+ a test) |
| Change what the site looks like or how it plays | `viewer/viewer.js`, `viewer/viewer.css`, `viewer/index.template.html` |
| Change the website (landing page, picker, progress) | `site/` (top level), then `npm run site` |
| Change how a GitHub repo is fetched in the browser | `scripts/lib/web/github-loader.mjs` (test with the fake GitHub in `test/web.test.mjs`) |
| Change the GitHub Action | `action.yml` (repo root), `scripts/pr-comment.mjs` |
| Change the VS Code extension | `vscode-extension/` (see its README for how to run it) |
| Change how Claude Code uses the tool | `SKILL.md` |
| Change the data format | `reference/schema.md` + `validate.mjs` (bump `schemaVersion` if breaking) |

(paths are under `skills/repo-architecture/` unless noted. **Logic in `scripts/lib/core/` must stay free of Node APIs** because the website runs it in the browser.)

### Adding a language (the most useful contribution)

A language is one plug-in: a plain object in its own file, registered with one line. The scanner does not know anything else about it.
Read the contract at the top of [`core/languages.mjs`](skills/repo-architecture/scripts/lib/core/languages.mjs); the short version:

```js
export const swift = {
  name: 'swift',
  exts: ['swift'],
  langNames: { swift: 'Swift' },
  packageUnit: false,                     // true when a directory/package is the natural diagram unit (Go, Java, C#)
  parse(text, ext) { return { imports: [{ spec, line, names }], package, symbols }; },
  prepare({ files, allPaths, read }) { return { state, deps, manifests, workspaces }; },   // build an index ONCE
  resolve(imp, state, file) { return { files: ['path/that/exists.swift'] }; },            // or { external: 'name' } or {}
  entry(file, state) { return file.path.endsWith('main.swift') ? 'Swift entry file' : null; },
};
```

1. Write `lang-xxx.mjs` exporting the plug-in (copy `lang-rust.mjs` or `lang-java.mjs` as a starting point). Keep it free of Node APIs: the website runs it in the browser.
2. Add it to `PLUGINS` in `core/languages.mjs`. The extension, language name and package grouping are picked up automatically.
3. **Unresolvable imports must be dropped, not guessed.** `resolve` may only return files that exist in the repository, and an `external` only when a manifest declares that dependency.
4. Add fixture tests to `test/languages.test.mjs` (a tiny throwaway repo per case, including one import that must stay unresolved). `test/plugins.test.mjs` already checks the contract for every registered plug-in.
5. If the language has a manifest (`Gemfile`, `pubspec.yaml`, ...), add its name to `MANIFEST_RE` in `scripts/lib/web/github-loader.mjs` so the website downloads it.
6. Try it on a couple of real public repositories, and add a row to the README's language table.

## Tests

`npm test` uses the built-in `node:test`. New behavior needs a test; bug fixes need a regression test. Fixtures are
created in a temp directory inside the test, not committed.

`npm run e2e` is a real-browser smoke test of the website (headless Chrome, a fake GitHub, no dependencies; needs Node 22 and Chrome or
Chromium, and `npm run site` first). CI runs it as its own job. It skips itself when Chrome is missing unless `GV_REQUIRE_CHROME=1`.

For viewer changes, please also check by hand in a browser: desktop and phone width, play/pause/next/prev/restart,
keyboard, dark mode, and `prefers-reduced-motion`. Mention what you checked in the PR.

## Pull requests

- Keep PRs focused; small is great.
- Match the surrounding style (2 spaces, single quotes, no build step).
- Update `README.md`, `SKILL.md`, or `reference/schema.md` when behavior changes.
- If you touch `site/`, `scripts/lib/core/`, `scripts/lib/web/` or `viewer/`, run `npm run site` and commit `docs/` (CI checks it).
- If you change the pipeline, regenerate this repo's own docs: `npm run docs` (curated items are preserved), and
  make sure `node skills/repo-architecture/scripts/gitvisualise.mjs validate .` still passes. If it reports stale line
  numbers, update them, or ask us.
- Fill in the PR template. Draft PRs are welcome for early feedback.

## Automation you will see

Bots keep the project tidy so maintainers can spend time on review: a welcome comment on your first issue or pull request,
automatic labels based on the files you changed, Dependabot updates for GitHub Actions, CodeQL security scanning, and a stale
check that only touches quiet issues and pull requests (anything labelled `good first issue`, `help wanted`, `ambitious`,
`security` or `bug` is exempt). `main` is protected: changes arrive through pull requests with passing checks and one review.

Documentation lives in `guides/` (long-form walkthroughs), the README and `skills/repo-architecture/reference/`. Run every command you write in a
guide on a throwaway repository first, and give every image alt text.

## Reporting bugs and ideas

Use the issue templates. The most helpful bug report includes the repo you ran it on (a link is perfect), the
command, and the output of `validate`.

## Code of conduct

Be kind. See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
