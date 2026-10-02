# gitvisualise for VS Code

See how your workspace works without leaving the editor: an animated, narrated architecture tour beside your code, and one click from any component to the exact file and line it came from.

- **gitvisualise: Open architecture tour** analyses the open folder and shows the tour in a panel beside your editor.
- **gitvisualise: Refresh architecture tour** rebuilds it after you change code.
- **gitvisualise: Show this file in the architecture tour** ("where am I?", also in the editor's right-click menu and on <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>G</kbd>, <kbd>Cmd</kbd>+<kbd>Alt</kbd>+<kbd>G</kbd> on a Mac) finds the component that contains the file you are editing and selects it in the tour. It uses each component's sources, so it only says what the tour already points at: the component whose lines hold your cursor, otherwise one that names the file, otherwise one for the folder around it. If nothing points at the file (it is ignored, a test, or not analysed) it says so instead of guessing.
- In the component details, **Open in editor** jumps to the file and line the component points at.

It is the same engine as the website, the CLI and the GitHub Action: every box and arrow links to real code, and nothing is drawn that cannot be pointed at.

## Private by design

- The analysis runs **locally**, using the editor's own Node runtime. Nothing is uploaded.
- The tour is generated into the extension's storage folder, **not into your repository**.
- The webview runs under a strict Content-Security-Policy: no network, no remote code, scripts only by nonce.
- The webview is treated as untrusted (it renders text from your repository). The only thing it can ask the editor to do is open a file, and the path must be a plain relative path to an existing file inside the workspace: `..`, absolute paths, URLs and symlinks that leave the workspace are refused.

## Settings

| Setting | Meaning |
|---|---|
| `gitvisualise.ignore` | Comma-separated paths to leave out of the analysis, for example `vendor,generated` |

## Try it from this repository

1. Open the `vscode-extension` folder (or the whole repository) in VS Code.
2. Press <kbd>F5</kbd> (the "Run gitvisualise extension" launch configuration). A second window opens.
3. In that window open any folder, press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> and run **gitvisualise: Open architecture tour**.

While developing inside this repository the extension uses the CLI in `../skills/repo-architecture`. To use it anywhere, package it:

```bash
cd vscode-extension
npm run prepare                  # copies the CLI and the viewer into ./skill
npx @vscode/vsce package         # produces gitvisualise-0.1.0.vsix
code --install-extension gitvisualise-0.1.0.vsix
```

## Tests

- `npm test` at the repository root runs the unit tests for the helpers (path safety, webview preparation).
- `npm run e2e` at the repository root runs the tour under the webview's Content-Security-Policy in headless Chrome and checks that **Open in editor** posts the right file and line, that the page announces itself with `ready`, and that a `gvSelect` message selects a component (the "where am I?" path).
- `npm test` **in this folder** starts a real VS Code, loads the extension in its Extension Host against a throwaway workspace, opens the tour, jumps to a file and line, runs **Show this file in the architecture tour** on the open file and checks which component it selected, and confirms that hostile messages open nothing. It needs a desktop VS Code (set `VSCODE_EXEC` if it is not found) and is not part of CI.

## Publishing (maintainers)

Releases are made by [`.github/workflows/vscode-extension.yml`](../.github/workflows/vscode-extension.yml):

1. Bump `version` in `vscode-extension/package.json` and merge.
2. Push a tag `vscode-v<version>` (for example `vscode-v0.2.0`). The tag must match the version or the workflow stops.
3. The workflow runs the unit tests, bundles the engine, builds `gitvisualise-<version>.vsix`, creates (or reuses) a GitHub release of the same name and attaches the file, then publishes it.

Pull requests that touch the extension build the same `.vsix` and keep it as a workflow artifact, so packaging problems show up before a release.

Publishing needs two **repository secrets** (Settings → Secrets and variables → Actions). They are read only by the `publish` job and are never printed:

| Secret | What it is | Where to get it |
|---|---|---|
| `VSCE_PAT` | A personal access token with the *Marketplace → Manage* scope for the `kaushik2210` publisher | [Azure DevOps](https://dev.azure.com) (publisher management: <https://marketplace.visualstudio.com/manage>) |
| `OVSX_PAT` | An Open VSX access token (for VSCodium and other editors) | <https://open-vsx.org/user-settings/tokens> |

Without a secret the matching step is skipped with a notice (the workflow does not fail), so the `.vsix` and the GitHub release still happen. Packaging by hand: `cd vscode-extension && npm run package`. The icon is drawn by `node scripts/make-icon.mjs`.

## Status

This is version 0.1.0: it works and is tested as above. Publishing to the Marketplace and Open VSX is set up (see above) and starts as soon as a maintainer adds the two secrets and pushes a `vscode-v*` tag. Issues and pull requests are welcome, see the [roadmap](../ROADMAP.md).
