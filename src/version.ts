import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The package version, read from the manifest — not repeated as a literal.
 *
 * `dot --version` and the MCP `initialize` handshake each carried their own copy of the string.
 * Bumping the version updated neither, and the publish gate then failed all six bins for
 * reporting a version the package no longer had. A tool whose installer says 1.1.0 while its
 * `--version` says 1.0.0 makes every release note a guess, so there is now one source.
 *
 * Resolved by walking upward because the same module is reached from `src/` during development
 * and from `dist/` once built — different depths below the package root.
 */
function readManifest(): { name: string; version: string } {
  let dir = fileURLToPath(new URL('.', import.meta.url));
  for (let up = 0; up < 4; up++) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) {
      const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as { name?: unknown; version?: unknown };
      if (typeof parsed.name === 'string' && typeof parsed.version === 'string') return { name: parsed.name, version: parsed.version };
    }
    dir = join(dir, '..');
  }
  // Loud, not defaulted: a CLI that invents a version number is the failure this file exists to stop.
  throw new Error('no package.json with a name and version above this module — refusing to report a version');
}

export const PKG = readManifest();
export const PKG_VERSION = PKG.version;
