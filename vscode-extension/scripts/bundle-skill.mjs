// Copies the CLI and the viewer from skills/repo-architecture into vscode-extension/skill, so a packaged extension carries
// everything it needs (`vsce package` after `npm run prepare`). The copy is a build artifact and is not committed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, '../../skills/repo-architecture');
const dest = path.resolve(here, '../skill');
fs.rmSync(dest, { recursive: true, force: true });
for (const dir of ['scripts', 'viewer']) fs.cpSync(path.join(src, dir), path.join(dest, dir), { recursive: true });
console.log(`Bundled the CLI and viewer into ${path.relative(process.cwd(), dest) || dest}`);
