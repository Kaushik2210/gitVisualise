// A minimal Chrome DevTools Protocol client with no dependencies: launch a headless Chrome, talk to one page over a WebSocket.
// Needs Node 22 (global WebSocket). Used only by the browser smoke test, never by the shipped code.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CANDIDATES = [
  process.env.CHROME_BIN,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

export const findChrome = () => CANDIDATES.find((p) => fs.existsSync(p)) || null;

/** Starts Chrome and returns { page, close }. `page.send(method, params)` speaks CDP; `page.events` collects what the page emits. */
export async function launchPage() {
  const bin = findChrome();
  if (!bin) throw new Error('no Chrome found (set CHROME_BIN)');
  if (typeof WebSocket === 'undefined') throw new Error('this Node has no global WebSocket (use Node 22 or newer)');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-e2e-'));
  const chrome = spawn(bin, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=1280,900', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  const wsUrl = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('Chrome did not start: ' + buf.slice(-400))), 20000);
    chrome.stderr.on('data', (d) => {
      buf += d;
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    chrome.on('exit', (c) => reject(new Error('Chrome exited early with code ' + c)));
  });

  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('DevTools connection failed')); });
  let id = 0;
  const pending = new Map();
  const events = [];
  const listeners = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) { const { res, rej } = pending.get(msg.id); pending.delete(msg.id); msg.error ? rej(new Error(msg.error.message)) : res(msg.result); }
    else if (msg.method) { events.push(msg); listeners.forEach((l) => l(msg)); }
  };
  const raw = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const i = ++id;
    pending.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

  const { targetId } = await raw('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await raw('Target.attachToTarget', { targetId, flatten: true });
  const send = (method, params) => raw(method, params, sessionId);
  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
  // A sandboxed iframe without allow-same-origin (the tour frame) lives in its own process, so Chrome exposes it as a separate
  // target. Auto-attach to it so its document can be inspected like any other.
  const frames = []; // { sessionId, targetId, url }
  const seenTargets = new Set(); // every target type Chrome attached us to (iframe, worker ...)
  listeners.push((m) => {
    if (m.method === 'Target.attachedToTarget') seenTargets.add(m.params.targetInfo.type);
    if (m.method === 'Target.attachedToTarget' && m.params.targetInfo.type === 'iframe') frames.push({ sessionId: m.params.sessionId, targetId: m.params.targetInfo.targetId, url: m.params.targetInfo.url });
    if (m.method === 'Target.detachedFromTarget') { const i = frames.findIndex((f) => f.sessionId === m.params.sessionId); if (i >= 0) frames.splice(i, 1); }
  });
  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });

  const page = {
    send, events, seenTargets,
    on: (fn) => listeners.push(fn),
    /** The newest sandboxed iframe target, or null. */
    frame: () => frames[frames.length - 1] || null,
    /** Evaluate an expression inside the newest iframe target (the tour). */
    async evalFrame(expression) {
      const f = frames[frames.length - 1];
      if (!f) throw new Error('no iframe target yet');
      const r = await raw('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, f.sessionId);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    },
    /** Evaluate an expression in the page and return its value. */
    async eval(expression) {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    },
    async waitFor(fn, what, ms = 25000) {
      const end = Date.now() + ms;
      let last;
      while (Date.now() < end) { try { last = await fn(); if (last) return last; } catch (e) { last = e.message; } await new Promise((r) => setTimeout(r, 150)); }
      throw new Error(`timed out waiting for ${what}${last ? ` (last: ${JSON.stringify(last)})` : ''}`);
    },
    async screenshot(file) {
      const { data } = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(file, Buffer.from(data, 'base64'));
    },
  };
  const close = async () => {
    try { ws.close(); } catch { /* already closed */ }
    chrome.kill();
    await new Promise((r) => setTimeout(r, 200));
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* Windows may still hold a lock */ }
  };
  return { page, close };
}
