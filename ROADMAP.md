# Roadmap

Where gitvisualise is going, and where you can help. Every item is a real issue with acceptance criteria and pointers to the
exact files, grouped into milestones. Comment "I'll take this" on any of them and a maintainer will help you get started.

**Shipped so far:** every issue from v1.2 to v2.0 (see the [CHANGELOG](CHANGELOG.md)): the Swift, Scala, Kotlin, C#, Ruby, PHP, C/C++, Dart, Java and Rust import graphs, request tracing (including OpenAPI and GraphQL), data-model views (SQL, Prisma, Django), infrastructure views (Docker Compose, Kubernetes, Terraform), the minimap, diff move detection, print / PDF, the colour-blind palette, a VS Code extension, optional AI narration with your own key, and circular-dependency detection.

The one rule for everything below: **nothing is guessed.** A new node, edge or view needs a source reference the validator can check.

## [v1.4: A sharper graph](https://github.com/Kaushik2210/gitVisualise/milestone/4)

Cycles, dead-module hints and more languages: making the import graph say more, without guessing.

| Issue | Size |
|---|---|
| [#69](https://github.com/Kaushik2210/gitVisualise/issues/69) Viewer: highlight circular dependencies on the diagram | 🟢 good first issue |
| [#70](https://github.com/Kaushik2210/gitVisualise/issues/70) Cycles: treat require() inside functions as lazy | 🟡 intermediate |
| [#71](https://github.com/Kaushik2210/gitVisualise/issues/71) Tour of modules nothing imports ("possibly unused") | 🟡 intermediate |
| [#72](https://github.com/Kaushik2210/gitVisualise/issues/72) Language support: Elixir import graph | 🟡 intermediate |

## Have a different idea?

Open a [discussion](https://github.com/Kaushik2210/gitVisualise/discussions/categories/ideas) or an issue. The scanner, the data
format and the viewer are small and readable on purpose, and [CONTRIBUTING.md](CONTRIBUTING.md) explains the four ground rules and how to add a language.
