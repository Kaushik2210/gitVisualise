'use strict';
// Runs inside VS Code's Extension Host (see scripts/integration-test.mjs). Exits non-zero through a rejected promise.
const assert = require('node:assert/strict');
const path = require('node:path');
const vscode = require('vscode');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, what, ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(250); }
  throw new Error(`timed out waiting for ${what}`);
}

exports.run = async function run() {
  const ext = vscode.extensions.all.find((e) => e.id.endsWith('.gitvisualise')) || vscode.extensions.getExtension('kaushik2210.gitvisualise');
  assert.ok(ext, 'the extension is loaded');
  await ext.activate();

  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes('gitvisualise.openTour') && commands.includes('gitvisualise.refreshTour'), 'both commands are registered');

  const ws = process.env.GV_TEST_WORKSPACE;
  const norm = (p) => path.resolve(p).toLowerCase(); // Windows may report the drive letter in another case
  await waitFor(() => vscode.workspace.workspaceFolders && norm(vscode.workspace.workspaceFolders[0].uri.fsPath) === norm(ws), 'the throwaway workspace to open');

  // 1. opening the tour analyses the workspace (in the extension's own storage) and shows a webview
  await vscode.commands.executeCommand('gitvisualise.openTour');
  await waitFor(async () => (await vscode.commands.executeCommand('gitvisualise._panelCount')) === 1, 'a tour panel');
  const fs = require('node:fs');
  assert.ok(!fs.existsSync(path.join(ws, 'docs')), 'nothing was written into the workspace');

  // 2. jumping from a component to a file and line opens the editor there (the message the webview sends)
  const { __test } = require(path.join(__dirname, '..', 'extension.js'));
  await __test.handleMessage({ type: 'open', path: 'src/a.js', lines: [1, 1] }, vscode.workspace.workspaceFolders[0]);
  const editor = await waitFor(() => vscode.window.activeTextEditor, 'an editor');
  assert.equal(path.basename(editor.document.fileName), 'a.js');
  assert.equal(editor.selection.start.line, 0);

  // 3. a hostile message cannot open anything outside the workspace or anything malformed
  const before = vscode.window.activeTextEditor.document.fileName;
  for (const bad of [{ type: 'open', path: '../../etc/passwd' }, { type: 'open', path: 'C:/Windows/win.ini' }, { type: 'open', path: '/etc/hosts' }, { type: 'open', path: 'src/../../x' }, { type: 'open', path: 'nope.js' }, { type: 'run', path: 'src/main.js' }, null, 'x']) {
    await __test.handleMessage(bad, vscode.workspace.workspaceFolders[0]);
  }
  await sleep(500);
  assert.equal(vscode.window.activeTextEditor.document.fileName, before, 'nothing else was opened');

  // 4. refreshing rebuilds the same panel instead of adding one
  await vscode.commands.executeCommand('gitvisualise.refreshTour');
  await sleep(4000);
  assert.equal(await vscode.commands.executeCommand('gitvisualise._panelCount'), 1);
};
