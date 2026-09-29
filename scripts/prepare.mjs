/**
 * prepare.mjs — npm `prepack` hook (runs before `npm pack` / `npm publish`).
 *
 * Rebuilds `lib/client.js` from `src/` so the packed artifact always matches the
 * sources it is packed from; the published `files` set carries that built
 * artifact, never the build inputs. It is deliberately **not** an install-time
 * hook: consumers install a pre-built `lib/client.js`, so nothing may have to
 * run a build — and a command naming `scripts/` would not even resolve inside
 * the tarball, since `scripts/` is not packed. The source check below **fails
 * loudly** when the build inputs are absent: a silent skip would cheerfully pack
 * a missing or stale `lib/client.js`, which is worse than refusing to pack.
 */

import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hasSource = existsSync(resolve(root, 'src', 'client.js')) &&
  existsSync(resolve(root, 'scripts', 'build-client.mjs'));

if (hasSource) {
  const r = spawnSync(process.execPath, [resolve(root, 'scripts', 'build-client.mjs')], {
    cwd: root, stdio: 'inherit',
  });
  process.exit(r.status ?? 1);
}
console.error('prepack: client sources are absent — refusing to pack; `lib/client.js` would be missing or stale');
process.exit(1);
