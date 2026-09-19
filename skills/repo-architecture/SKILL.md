---
name: repo-architecture
description: Generate or update an interactive, animated, narrated architecture walkthrough for a repository (local path or GitHub URL). Use when the user asks to "generate an interactive architecture for this project", visualize/diagram/explain a repo's architecture, produce architecture docs for GitHub Pages, or refresh an existing docs/architecture site after code changes. Produces docs/architecture/architecture.json plus a static viewer with play/pause/step controls and voice narration. No API keys or paid services.
---

# repo-architecture

Turns a repository into `architecture.json` (the single source of truth) and a static site that renders it:
diagram, click-through source references, step-by-step flows with narration. The engine is generic; all
project knowledge lives in the JSON. Everything you write must be traceable to real files in the repo.

`<skill>` below means the directory containing this SKILL.md. The CLI is `node <skill>/scripts/gitvisualise.mjs`
(Node 18+, zero dependencies). Run `... help` for all options.

## Workflow

User says something like "Generate an interactive architecture for this project". Do these in order.

### 1. Inspect the repository (facts first)

```bash
node <skill>/scripts/gitvisualise.mjs scan <repo>          # local path (default ".") or GitHub URL / owner/repo
```

This writes `<repo>/.gitvisualise/scan.json` (for a GitHub URL it shallow-clones into `~/.gitvisualise/repos`).
Read it. It contains: language stats, manifests + dependencies, entry points (with reasons), every source file with
its imports (resolved to real files), exported symbols, doc comments, server routes (only when a server framework
is imported), API calls, and external dependencies with the manifest line that declares them.

Then **read the code that matters** — entry points, the modules with the most imports, config, routing, data
access, README. The scan tells you *what is connected*; only reading tells you *what it does*. Do not summarize
a file you have not opened.

### 2. Identify the architecture

Decide what the components are and how they interact. Guidance:

- Aim for 6–20 nodes. A node is a file, a directory/module, a service, a data store, or an external system.
  Prefer nodes that map to real paths. Group tiny files; split giant files only when they clearly hold several roles.
- Typical `kind` values: `entry`, `ui`, `api`, `service`, `data`, `util`, `config`, `external`, `module`. Any other
  string is allowed and gets its own colour. Use `external` for third-party libraries/services.
- Edges express real relationships evidenced in code: imports, calls, HTTP requests, DB queries, events, config
  reads. Put the evidencing file and line in `sources`.
- Flows are the story: e.g. "App startup", "Handling a request", "Registering for an event". 1–3 flows,
  5–12 steps each. Each step highlights nodes/edges and carries its narration.

### 3. Generate / update `architecture.json`

Start from the deterministic baseline, then improve it:

```bash
node <skill>/scripts/gitvisualise.mjs generate <repo>      # writes docs/architecture/architecture.json (merging, never clobbering)
```

The baseline (origin `"auto"`) is a factual import graph with templated narration. Upgrade it by editing
`docs/architecture/architecture.json` directly: better labels and summaries, merged/split nodes, semantic edges
(e.g. "POSTs registration to"), and real narration. **Anything you write or rewrite must set `"origin": "claude"`**
on that node/edge/flow/step so future regenerations keep it. Schema: `reference/schema.md`.

### 4. Write the narration and attach it to flow steps

Narration lives in `flows[].steps[].narration` and is what the viewer captions and speaks.

- 1–3 sentences per step, plain spoken English, present tense, ~15–45 words. It is read aloud: no tables, no
  bullet syntax, no long paths (say "the events API module", put the path in `sources`).
- Each step must tell the viewer *why this hop matters* (what data moves, what decision is made), not just
  restate an edge ("A imports B" is a failed narration).
- Each step lists the `nodes`/`edges` it highlights and 1–2 `sources` that prove the claim.
- Open with the entry point; end with an outcome. Steps should read as one continuous explanation.
- Backticks render as `code` in captions and are not spoken; use them for real file paths only, and every backticked
  path must exist (the validator checks).

### 5. Validate (mandatory)

```bash
node <skill>/scripts/gitvisualise.mjs validate <repo>
```

Errors must reach zero. The validator checks: schema; unique ids; every `sources[].path` exists (exact case) and every
`lines` range is inside the file; edges/steps reference real nodes/edges; every step has narration; file paths
mentioned in narration/summaries exist; `imports` edges point at lines that look like imports. Fix the JSON — do not
delete evidence to make it pass, and never silence a check by inventing a plausible path. Read the warnings too
(uncovered nodes, missing edge evidence, unverified URLs).

### 6. Build and verify

```bash
node <skill>/scripts/gitvisualise.mjs build <repo>         # index.html + viewer.js + viewer.css next to architecture.json
node <skill>/scripts/gitvisualise.mjs serve <repo>         # http://localhost:4173
```

Open it (Browser pane / preview tool) and check: no console errors, play/pause/next/prev/restart work, clicking a
node shows its summary and "Open Source", the narration reads well. `generate`+`build` in one go: `all`.
Report the result to the user: files written, how to serve, how to publish (`docs/` on GitHub Pages).

## Rules — do not break these

1. **Never invent components, files, endpoints, or URLs.** If you cannot point at a file/line, it does not go in.
   Uncertain? Read more code, or leave it out and say so.
2. **Preserve manual edits.** Before touching an existing `architecture.json`, read it. Items with
   `origin: "manual" | "claude"`, `locked: true`, or `locked: ["field", ...]`, and any node `position`, must not be
   overwritten by generators. When refreshing after code changes: run `generate` (it merges), then fix items
   whose sources moved or vanished, and mention what you changed. Never rewrite the whole file from scratch
   when one exists.
3. **Do not touch the application.** All output goes under the output folder (default `docs/architecture/`).
   Do not modify source files, package.json, or build config to make the docs work. Scan cache goes in
   `.gitvisualise/` (suggest adding it to `.gitignore`).
4. **No paid APIs, no keys.** Voice uses the browser's built-in speech synthesis; the viewer has no dependencies.
5. **Keep the engine generic.** Project-specific content belongs in `architecture.json`, never in `viewer/`.
6. **Only document what is there.** Tests/examples/tooling config are skipped by default (`--include
   tests,examples,tooling` adds them). If something is out of scope, say so in `project.notes`.

## Preserving edits across regenerations (how merge works)

`generate` re-scans and merges by `id`:

| Existing item | Result |
|---|---|
| `origin: "claude"` / `"manual"` or `locked: true` | kept exactly as-is |
| `locked: ["summary", ...]` | regenerated, but those fields keep your values |
| `position: {x, y}` on a node | always kept |
| `origin: "auto"` still in the repo | replaced with fresh generated version |
| `origin: "auto"` no longer in the repo | dropped (reported) |
| new in repo | added with `origin: "auto"` |

After a merge, always run `validate`: a kept item may reference a file that has since been renamed.

## The website

The same engine powers https://kaushik2210.github.io/gitVisualise/ : anyone can paste a GitHub link and get an automatic tour. If a repo
commits a curated `docs/architecture/architecture.json`, the website shows that curated tour, so finishing the skill's workflow and pushing
`docs/architecture/` is how a repo gets a narrated tour on the site.

## Remote repositories

`gitvisualise all https://github.com/owner/repo` (or `owner/repo`) clones shallowly and writes to
`./gitvisualise-out/<owner>__<repo>/`. "Open Source" links then point to that exact commit on GitHub. Use
`--ref <branch|tag>` to choose a ref and `--out <dir>` to choose the folder. For a repo you just analysed
locally, links pin to `HEAD`'s commit: make sure it is pushed, or links 404 (the CLI warns).

## Publishing on GitHub Pages

Commit `docs/architecture/` (the JSON, `index.html`, `viewer.js`, `viewer.css`, `.nojekyll`), push, then in the repo:
Settings → Pages → Source: "Deploy from a branch" → Branch `main`, folder `/docs`. The site appears at
`https://<user>.github.io/<repo>/architecture/`. The output is fully static; opening `index.html` from disk also works.

## Files in this skill

- `scripts/gitvisualise.mjs` — CLI (`scan | generate | validate | build | all | serve | install-skill`)
- `scripts/lib/` — heuristic generator, merger, Node adapters, GitHub cloning
- `scripts/lib/core/` — pure scanner, validator rules and page renderer (no Node APIs: shared with the website)
- `scripts/lib/web/github-loader.mjs` — analyses a GitHub repo from a browser (powers the website)
- `viewer/` — generic renderer + playback engine + narration (HTML/CSS/JS, no dependencies)
- `reference/schema.md` — the `architecture.json` schema with an example
