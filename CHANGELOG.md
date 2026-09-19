# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

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

[1.0.1]: https://github.com/Kaushik2210/gitVisualise/releases/tag/v1.0.1
[1.0.0]: https://github.com/Kaushik2210/gitVisualise/releases/tag/v1.0.0
