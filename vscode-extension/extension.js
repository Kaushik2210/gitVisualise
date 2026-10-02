'use strict';
// gitvisualise for VS Code: open the architecture tour of the workspace beside your code, and jump from any component
// straight to the file and line it came from. It reuses the CLI in skills/repo-architecture (no second implementation):
// the tour is generated into the extension's own storage, so nothing is written into your repository.
const vscode = require('vscode');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { resolveInside, lineRange, prepareWebviewHtml, randomNonce, findComponent } = require('./lib.js');

/** The bundled CLI (after `npm run prepare` in this folder), or the one next to this extension when developing in the repository. */
function cliPath(context) {
  const candidates = [
    path.join(context.extensionPath, 'skill', 'scripts', 'gitvisualise.mjs'),
    path.join(context.extensionPath, '..', 'skills', 'repo-architecture', 'scripts', 'gitvisualise.mjs'),
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function run(cli, args, output) {
  return new Promise((resolve, reject) => {
    // The editor's own Node runtime: no separate Node installation is needed.
    const child = spawn(process.execPath, [cli, ...args], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    const sink = (d) => { text += d; output.append(String(d)); };
    child.stdout.on('data', sink);
    child.stderr.on('data', sink);
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(text) : reject(new Error(text.trim().split('\n').pop() || `exit code ${code}`))));
  });
}

async function generateTour(context, folder, output) {
  const cli = cliPath(context);
  if (!cli) throw new Error('The gitvisualise CLI is missing. Run "npm run prepare" in the vscode-extension folder, or open the gitvisualise repository.');
  const id = crypto.createHash('sha1').update(folder.uri.fsPath).digest('hex').slice(0, 12);
  const out = path.join(context.globalStorageUri.fsPath, 'tours', id);
  fs.mkdirSync(out, { recursive: true });
  const ignore = vscode.workspace.getConfiguration('gitvisualise').get('ignore', '');
  const args = ['all', folder.uri.fsPath, '--out', out, '--no-pin', '--force', ...(ignore ? ['--ignore', ignore] : [])];
  await run(cli, args, output);
  return out;
}

const panels = new Map(); // workspace folder path -> panel
const tours = new Map(); // workspace folder path -> { dir, ready, pending }: where the tour was generated, and whether its page is listening
let lastSelection = null; // the component id most recently sent to a tour page (read by the Extension Host test)

async function openTour(context, output, opts = {}) {
  const folder = (vscode.workspace.workspaceFolders || [])[0];
  if (!folder) { vscode.window.showWarningMessage('gitvisualise: open a folder first.'); return null; }
  const key = folder.uri.fsPath;
  let tourDir;
  try {
    tourDir = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'gitvisualise: analysing the workspace' }, () => generateTour(context, folder, output));
  } catch (e) {
    output.show(true);
    vscode.window.showErrorMessage(`gitvisualise: ${e.message}`);
    return null;
  }
  let panel = panels.get(key);
  if (!panel) {
    panel = vscode.window.createWebviewPanel('gitvisualise.tour', `Architecture: ${folder.name}`, vscode.ViewColumn.Beside, {
      enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.file(tourDir)],
    });
    panels.set(key, panel);
    panel.onDidDispose(() => { panels.delete(key); tours.delete(key); }, null, context.subscriptions);
    panel.webview.onDidReceiveMessage((msg) => {
      // the page says it is listening once it has drawn the diagram; a selection requested before that is delivered now
      if (msg && msg.type === 'ready') { const t = tours.get(key); if (t) { t.ready = true; flushSelection(panel, t); } return; }
      return handleMessage(msg, folder);
    }, null, context.subscriptions);
  }
  tours.set(key, { dir: tourDir, ready: false, pending: tours.get(key)?.pending || null });
  const html = fs.readFileSync(path.join(tourDir, 'index.html'), 'utf8');
  const nonce = randomNonce();
  panel.webview.html = prepareWebviewHtml(html, {
    cspSource: panel.webview.cspSource, nonce,
    asUri: (file) => panel.webview.asWebviewUri(vscode.Uri.file(path.join(tourDir, file))).toString(),
  });
  if (!opts.background) panel.reveal(vscode.ViewColumn.Beside, true);
  return panel;
}

function flushSelection(panel, tour) {
  if (!tour.pending) return;
  const id = tour.pending;
  tour.pending = null;
  lastSelection = id;
  panel.webview.postMessage({ gvSelect: id });
}

/** The component of the open tour that contains the active file; null when nothing points at it. Pure apart from reading architecture.json. */
function componentFor(tourDir, relPath, line) {
  let arch;
  try { arch = JSON.parse(fs.readFileSync(path.join(tourDir, 'architecture.json'), 'utf8')); } catch { return null; }
  return findComponent(arch, relPath, line);
}

/** "Where am I?": reveals and selects, in the tour, the component that contains the active editor's file. */
async function whereAmI(context, output) {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== 'file') { vscode.window.showInformationMessage('gitvisualise: open a file from the workspace first.'); return null; }
  const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
  if (!folder) { vscode.window.showInformationMessage('gitvisualise: this file is not inside the open workspace.'); return null; }
  const key = folder.uri.fsPath;
  let panel = panels.get(key);
  if (!panel) { panel = await openTour(context, output, { background: true }); if (!panel) return null; }
  const tour = tours.get(key);
  const rel = path.relative(folder.uri.fsPath, editor.document.uri.fsPath).split(path.sep).join('/');
  const node = componentFor(tour.dir, rel, editor.selection.active.line + 1);
  if (!node) { vscode.window.showInformationMessage(`gitvisualise: no component in the tour points at ${rel}. It may be ignored, a test, or not analysed.`); return null; }
  panel.reveal(vscode.ViewColumn.Beside, true);
  tour.pending = node.id;
  if (tour.ready) flushSelection(panel, tour);
  return node.id;
}

/** Messages from the webview are untrusted: only a well-formed "open" for a path inside the workspace does anything. */
async function handleMessage(msg, folder) {
  if (!msg || msg.type !== 'open') return;
  const abs = resolveInside(folder.uri.fsPath, msg.path);
  if (!abs) return;
  const uri = vscode.Uri.file(abs);
  const stat = await vscode.workspace.fs.stat(uri).catch(() => null);
  if (!stat) return;
  if (stat.type & vscode.FileType.Directory) { await vscode.commands.executeCommand('revealInExplorer', uri); return; }
  const range = lineRange(msg.lines);
  const selection = range ? new vscode.Range(range[0] - 1, 0, range[1] - 1, 0) : undefined;
  await vscode.window.showTextDocument(uri, { selection, viewColumn: vscode.ViewColumn.One, preserveFocus: false });
}

function activate(context) {
  const output = vscode.window.createOutputChannel('gitvisualise');
  context.subscriptions.push(
    output,
    vscode.commands.registerCommand('gitvisualise.openTour', () => openTour(context, output)),
    vscode.commands.registerCommand('gitvisualise.refreshTour', () => openTour(context, output, { background: true })),
    vscode.commands.registerCommand('gitvisualise.whereAmI', () => whereAmI(context, output)),
    // exposed so the integration test can drive the extension without clicking through the UI
    vscode.commands.registerCommand('gitvisualise._panelCount', () => panels.size),
    vscode.commands.registerCommand('gitvisualise._lastSelection', () => lastSelection),
  );
}

function deactivate() {}

module.exports = { activate, deactivate, __test: { handleMessage, componentFor } };
