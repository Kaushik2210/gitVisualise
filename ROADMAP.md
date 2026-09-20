# Roadmap

Where gitvisualise is going, and where you can help. Every item is a real issue with acceptance criteria and pointers to the
exact files, grouped into milestones. Comment "I'll take this" on any of them and a maintainer will help you get started.

**Shipped so far:** [v1.1.0](https://github.com/Kaushik2210/gitVisualise/releases/tag/v1.1.0) and, since then on `main`: C#, Ruby, PHP, C/C++, Dart and Kotlin import graphs,
a common language plug-in interface, request tracing through configured base URLs, infrastructure (Docker Compose) and data-model
(SQL, Prisma) views, collapsible swimlanes, Mermaid / PlantUML export, a README badge button, accessibility for screen readers and
keyboards, `gitvisualise watch`, a Web Worker for the analysis, a pull request architecture-diff comment, a redesigned website,
optional AI narration with your own key, a VS Code extension, and a real-browser smoke test. See the [CHANGELOG](CHANGELOG.md).

The one rule for everything below: **nothing is guessed.** A new node, edge or view needs a source reference the validator can check.

## [v1.2: Share it anywhere](https://github.com/Kaushik2210/gitVisualise/milestone/1)

Export formats, embeds and docs that make a tour easy to put in a README, a wiki or a slide.

| Issue | Size |
|---|---|
| [#7](https://github.com/Kaushik2210/gitVisualise/issues/7) Add a demo GIF and screenshots to the README | 🟢 good first issue |
| [#42](https://github.com/Kaushik2210/gitVisualise/issues/42) CLI: `gitvisualise init` sets a repository up in one command | 🟢 good first issue |
| [#43](https://github.com/Kaushik2210/gitVisualise/issues/43) A community gallery of tours, added by pull request | 🟢 good first issue |
| [#44](https://github.com/Kaushik2210/gitVisualise/issues/44) Viewer: a "?" keyboard shortcuts overlay | 🟢 good first issue |
| [#45](https://github.com/Kaushik2210/gitVisualise/issues/45) Viewer: a colour-blind-safe palette option | 🟢 good first issue |
| [#46](https://github.com/Kaushik2210/gitVisualise/issues/46) Export the whole tour as a printable document | 🟡 intermediate |
| [#14](https://github.com/Kaushik2210/gitVisualise/issues/14) Sign in with GitHub to list private repositories | 🔴 ambitious |

## [v1.3: More languages and a faster core](https://github.com/Kaushik2210/gitVisualise/milestone/2)

More import graphs, a cleaner language plug-in interface, and a smoother experience on large repositories.

| Issue | Size |
|---|---|
| [#47](https://github.com/Kaushik2210/gitVisualise/issues/47) Language support: Swift import graph | 🟡 intermediate |
| [#48](https://github.com/Kaushik2210/gitVisualise/issues/48) Language support: Scala | 🟡 intermediate |
| [#49](https://github.com/Kaushik2210/gitVisualise/issues/49) Data model: read ORM models from application code | 🟡 intermediate |
| [#50](https://github.com/Kaushik2210/gitVisualise/issues/50) Request tracing: read routes from OpenAPI documents | 🟡 intermediate |
| [#51](https://github.com/Kaushik2210/gitVisualise/issues/51) Performance: process the file tree off the main thread | 🟡 intermediate |
| [#52](https://github.com/Kaushik2210/gitVisualise/issues/52) Viewer: a minimap for large diagrams | 🟡 intermediate |
| [#53](https://github.com/Kaushik2210/gitVisualise/issues/53) Diff: detect renamed and moved files | 🟡 intermediate |

## [v2.0: New views](https://github.com/Kaushik2210/gitVisualise/milestone/3)

Beyond imports: data models, infrastructure, and richer narration.

| Issue | Size |
|---|---|
| [#54](https://github.com/Kaushik2210/gitVisualise/issues/54) Infrastructure view: Kubernetes manifests | 🟡 intermediate |
| [#57](https://github.com/Kaushik2210/gitVisualise/issues/57) VS Code extension: "where am I?" and Marketplace publishing | 🟡 intermediate |
| [#55](https://github.com/Kaushik2210/gitVisualise/issues/55) Infrastructure view: Terraform resources | 🔴 ambitious |
| [#56](https://github.com/Kaushik2210/gitVisualise/issues/56) Request tracing: GraphQL operations to resolvers | 🔴 ambitious |

## Have a different idea?

Open a [discussion](https://github.com/Kaushik2210/gitVisualise/discussions/categories/ideas) or an issue. The scanner, the data
format and the viewer are small and readable on purpose, and [CONTRIBUTING.md](CONTRIBUTING.md) explains the four ground rules and how to add a language.
