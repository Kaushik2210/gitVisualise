// Runs the extension inside a real VS Code (its Extension Host) against a throwaway workspace. It is not part of `npm test` or CI:
// it needs a desktop VS Code and opens a window briefly. Set VSCODE_EXEC to the editor executable if it is not found.
//
//   npm test    (from this folder)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ext = path.resolve(here, '..');

const candidates = [
  process.env.VSCODE_EXEC,
  'C:/Program Files/Microsoft VS Code/Code.exe',
  path.join(os.homedir(), 'AppData/Local/Programs/Microsoft VS Code/Code.exe'),
  path.join(os.homedir(), 'Documents/Microsoft VS Code/Code.exe'),
  '/usr/share/code/code', '/usr/bin/code', '/Applications/Visual Studio Code.app/Contents/MacOS/Electron',
].filter(Boolean);
const exe = candidates.find((p) => fs.existsSync(p));
if (!exe) { console.error('VS Code not found. Set VSCODE_EXEC to its executable.'); process.exit(2); }

// a small workspace to analyse
const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-vscode-ws-'));
fs.mkdirSync(path.join(ws, 'src'));
fs.writeFileSync(path.join(ws, 'package.json'), '{"name":"demo","main":"src/main.js"}');
fs.writeFileSync(path.join(ws, 'src/main.js'), "import { a } from './a.js';\nconsole.log(a);\n");
fs.writeFileSync(path.join(ws, 'src/a.js'), 'export const a = 1;\n');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-vscode-data-'));
const exts = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-vscode-exts-'));

const args = [
  `--extensionDevelopmentPath=${ext}`, `--extensionTestsPath=${path.join(ext, 'e2e', 'suite.js')}`,
  `--user-data-dir=${data}`, `--extensions-dir=${exts}`, '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-gpu',
  ws,
];
const child = spawn(exe, args, { stdio: 'inherit', env: { ...process.env, GV_TEST_WORKSPACE: ws } });
const timer = setTimeout(() => { console.error('timed out after 120 s'); child.kill(); }, 120000);
child.on('exit', (code) => {
  clearTimeout(timer);
  for (const d of [ws, data, exts]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* the editor may still hold a lock */ } }
  console.log(code === 0 ? 'VS Code integration test passed' : `VS Code integration test FAILED (exit ${code})`);
  process.exit(code === 0 ? 0 : 1);
});
