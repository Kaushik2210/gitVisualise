# Roadmap

Where gitvisualise is going, and where you can help. Every item is a real issue with acceptance criteria and pointers to the
exact files, grouped into milestones. Comment "I'll take this" on any of them and a maintainer will help you get started.

**Shipped:** [v1.1.0](https://github.com/Kaushik2210/gitVisualise/releases/tag/v1.1.0) added Java, Rust and Kotlin import graphs,
path aliases, monorepos, request tracing, architecture diffs, search, themes, export, and a per-commit browser cache.
See the [CHANGELOG](CHANGELOG.md).

The one rule for everything below: **nothing is guessed.** A new node, edge or view needs a source reference the validator can check.

## [v1.2: Share it anywhere](https://github.com/Kaushik2210/gitVisualise/milestone/1)

Make a tour easy to put in a README, a wiki, a pull request or a slide.

| Issue | Size |
|---|---|
| [#26](https://github.com/Kaushik2210/gitVisualise/issues/26) Export as Mermaid or PlantUML | 🟢 good first issue |
| [#27](https://github.com/Kaushik2210/gitVisualise/issues/27) "Copy README badge" button | 🟢 good first issue |
| [#28](https://github.com/Kaushik2210/gitVisualise/issues/28) Guide: publish your own tour with GitHub Pages | 🟢 good first issue |
| [#29](https://github.com/Kaushik2210/gitVisualise/issues/29) Accessibility: screen reader and keyboard only | 🟢 good first issue |
| [#7](https://github.com/Kaushik2210/gitVisualise/issues/7) A screen recording of pasting a link and playing the tour | 🟢 good first issue |
| [#24](https://github.com/Kaushik2210/gitVisualise/issues/24) GitHub Action: comment the architecture diff on pull requests | 🔴 ambitious |
| [#14](https://github.com/Kaushik2210/gitVisualise/issues/14) "Sign in with GitHub" (code is in; needs a registered app and a deployed function) | 🔴 ambitious |

## [v1.3: More languages and a faster core](https://github.com/Kaushik2210/gitVisualise/milestone/2)

More import graphs, a cleaner way to add them, and a smoother experience on large repositories.

| Issue | Size |
|---|---|
| [#36](https://github.com/Kaushik2210/gitVisualise/issues/36) `gitvisualise watch`: regenerate on change | 🟢 good first issue |
| [#21](https://github.com/Kaushik2210/gitVisualise/issues/21) Language support: C# `using` directives | 🟡 intermediate |
| [#22](https://github.com/Kaushik2210/gitVisualise/issues/22) Language support: Ruby and PHP | 🟡 intermediate |
| [#30](https://github.com/Kaushik2210/gitVisualise/issues/30) Language support: C and C++ `#include` | 🟡 intermediate |
| [#31](https://github.com/Kaushik2210/gitVisualise/issues/31) Language support: Dart and Flutter | 🟡 intermediate |
| [#32](https://github.com/Kaushik2210/gitVisualise/issues/32) Refactor: a common language plug-in interface | 🟡 intermediate |
| [#33](https://github.com/Kaushik2210/gitVisualise/issues/33) Viewer: collapse and expand groups | 🟡 intermediate |
| [#34](https://github.com/Kaushik2210/gitVisualise/issues/34) Run the analysis in a Web Worker | 🟡 intermediate |
| [#35](https://github.com/Kaushik2210/gitVisualise/issues/35) Browser end-to-end smoke test | 🟡 intermediate |
| [#23](https://github.com/Kaushik2210/gitVisualise/issues/23) Request tracing: base URLs, OpenAPI and GraphQL | 🔴 ambitious |

## [v2.0: New views](https://github.com/Kaushik2210/gitVisualise/milestone/3)

Beyond imports. These need a design discussion in the issue before any code.

| Issue | Size |
|---|---|
| [#37](https://github.com/Kaushik2210/gitVisualise/issues/37) Data-model view: SQL, Prisma and ORMs | 🔴 ambitious |
| [#38](https://github.com/Kaushik2210/gitVisualise/issues/38) Infrastructure view: Docker Compose, Kubernetes, Terraform | 🔴 ambitious |
| [#39](https://github.com/Kaushik2210/gitVisualise/issues/39) Optional AI narration with your own API key | 🔴 ambitious |
| [#40](https://github.com/Kaushik2210/gitVisualise/issues/40) VS Code extension | 🔴 ambitious |

## Have a different idea?

Open a [discussion](https://github.com/Kaushik2210/gitVisualise/discussions/categories/ideas) or an issue. The scanner, the data
format and the viewer are small and readable on purpose, and [CONTRIBUTING.md](CONTRIBUTING.md) explains the four ground rules and how to add a language.
