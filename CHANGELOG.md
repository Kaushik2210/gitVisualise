# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- **Languages:** C#, Ruby, PHP, C/C++ and Dart import graphs. Each resolves only to files that exist, and reports a third-party package only when a
  manifest (`.csproj`, `Gemfile` / gemspec, `composer.json`, `pubspec.yaml`) declares it.
- **Export:** `gitvisualise export --format mermaid|plantuml`, and Copy as Mermaid / PlantUML / README badge in the website's new Export menu.
- **Request tracing:** calls made through a client with a literal `baseURL` / `prefixUrl` (`axios.create`, `ky.extend`, `axios.defaults.baseURL`) in the same file are linked to their routes.
- **GitHub Action:** `comment-diff: true` posts one pull request comment summarising how the architecture changed (off by default).
- **Tests:** a real-browser smoke test (`npm run e2e`) that pastes a repository into the website and checks the tour is on screen, with its own CI job.
- **Website:** the analysis (scan, generate, validate) runs in a Web Worker, so large repositories no longer freeze the page; it falls back to the main thread where workers are unavailable, and Cancel terminates it.
- **Infrastructure and data-model views:** Docker Compose services (dependencies, start order, and the code each is built from) and SQL / Prisma tables with foreign keys, each with the file and lines it came from, and a tour for each. Works in the CLI and on the website.
- **CLI:** `gitvisualise watch` rebuilds the tour on every change (and on hand edits of `architecture.json`).
- **Website:** a redesigned landing page with a gallery of real tours, a feature grid and a contributor call to action.
- **Viewer:** screen reader announcements, keyboard navigation between connected components, a skip link and forced-colors support.
- **Docs:** a guide to publishing your own tour, a public roadmap, and a language plug-in contract for contributors.

### Changed
- Languages are now plug-ins registered in `core/languages.mjs`; behaviour for existing languages is unchanged.
- The validator no longer mistakes a package name that ends like a file (`Newtonsoft.Json`) for a missing file.

### Fixed
- The Java resolver no longer crashes on an import that did not come from its own parser.

## [1.1.0] - 2026-09-19

### Added
- **Languages:** Java (packages, classes, static and wildcard imports, Maven and Gradle dependencies, Spring Boot entry points) and
  Rust (`mod` and `use` resolution, workspaces, `Cargo.toml`) import graphs; Go workspaces (`go.work`).
- **Aliases:** `tsconfig`/`jsconfig` `paths`, `baseUrl` and `extends`, and simple Vite and webpack aliases, resolved to real files.
- **Monorepos:** one component per workspace package (npm, pnpm, Cargo, `go.work`), and analysis of a single folder with
  `--path <dir>`, `owner/repo:folder` or a `/tree/<ref>/<folder>` link.
- **Request tracing:** client `fetch`/`axios`/`$http`/`ky`/`got` calls are linked to the server routes that handle them (exact method and
  path-segment match, Express router mounts and Flask `methods` resolved), as `http` edges with evidence on both sides and a
  "Request: METHOD /path" tour.
- **Architecture diff:** `owner/repo@base...head` (and `gitvisualise diff <older> <newer>`) marks components and relationships added,
  removed or changed, with a generated "What changed" tour. Removed items carry evidence pinned to the older commit.
- **Viewer:** light / dark / auto theme, component search (`/`), export as SVG or PNG, swimlanes by group, directory or kind, and deep
  links to any tour step.
- **Website:** paginated repository picker, IndexedDB cache keyed by commit (private repositories only if opted in), theme
  sync, shareable step links, monorepo package chips, a "Compare..." button and optional "Sign in with GitHub" (off by default,
  see `server/github-oauth`).
- **Docs:** screenshots and an animated walkthrough in the README.

### Changed
- Cached tours are versioned, so a release that changes generator output never shows stale results.
- Python imports follow Python 3 semantics: a bare `import b` inside a package no longer resolves to a sibling module.
- The project name comes from the shallowest manifest, not the first nested package.

### Fixed
- Java packages named `samples` or `demo` under `src/main/java` are no longer mistaken for an examples folder.
- Go `require` lines and Rust `mod x;` declarations no longer produce validator warnings.

## [1.0.1] - 2026-09-19

### Fixed
- **Website:** the tour could appear blank after analysing a repository, leaving only the toolbar. The sandboxed
  frame is now created fresh for every tour, inside the already visible results view.

## [1.0.0] - 2026-09-19

First public release.

### Added
- **Website**: paste a GitHub link or pick a repository from an account, and get an interactive, narrated architecture
  tour generated entirely in the browser, with no backend. Supports deep links (`#/owner/repo`), optional tokens for
  private repositories, downloadable output, and a sandboxed player.
- **Command line** (`gitvisualise`): `scan`, `generate`, `validate`, `build`, `all`, `serve` and `install-skill`, for
  local folders and GitHub URLs. Zero dependencies.
- **Claude Code skill** (`repo-architecture`) that inspects a repository, writes grounded architecture data and
  narration, validates it, and preserves manual edits.
- **GitHub Action** that regenerates the tour in any repository's workflow.
- **Scanner** with import graphs for JavaScript/TypeScript (including JSX, Vue, Svelte), Python and Go, plus entry
  point, route and dependency detection.
- **Validator** that rejects nonexistent files, out-of-range line numbers, dangling references and invented paths in
  narration.
- **Merge** that keeps curated (`claude`, `manual`, `locked`) items across regenerations.
- **Viewer** with play, pause, step and restart controls, speed control, voice narration, a "zoom to step" camera,
  keyboard shortcuts, dark mode, a phone layout, reduced-motion support and a no-JavaScript fallback.
- A self-documenting architecture tour of this repository in `docs/architecture/`.

[1.1.0]: https://github.com/Kaushik2210/gitVisualise/releases/tag/v1.1.0
[1.0.1]: https://github.com/Kaushik2210/gitVisualise/releases/tag/v1.0.1
[1.0.0]: https://github.com/Kaushik2210/gitVisualise/releases/tag/v1.0.0
