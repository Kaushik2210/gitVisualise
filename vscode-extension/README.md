# gitvisualise for VS Code

See how your workspace works without leaving the editor: an animated, narrated architecture tour beside your code, and one click from any component to the exact file and line it came from.

- **gitvisualise: Open architecture tour** analyses the open folder and shows the tour in a panel beside your editor.
- **gitvisualise: Refresh architecture tour** rebuilds it after you change code.
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
- `npm run e2e` at the repository root runs the tour under the webview's Content-Security-Policy in headless Chrome and checks that **Open in editor** posts the right file and line.
- `npm test` **in this folder** starts a real VS Code, loads the extension in its Extension Host against a throwaway workspace, opens the tour, jumps to a file and line, and confirms that hostile messages open nothing. It needs a desktop VS Code (set `VSCODE_EXEC` if it is not found) and is not part of CI.

## Status

This is version 0.1.0: it works and is tested as above, but it is not published to the Marketplace yet. Issues and pull requests are welcome, see the [roadmap](../ROADMAP.md).
