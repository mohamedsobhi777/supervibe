#!/usr/bin/env bun
/**
 * Zips each project template under `templates-src/<name>/` into
 * `dist-templates/<name>.zip` (files at the ARCHIVE ROOT) and copies
 * `templates-src/template_catalog.json` alongside. The output is what the
 * agent fetches from TEMPLATES_BASE_URL (`{base}/template_catalog.json` +
 * `{base}/<name>.zip`).
 */
import { zipSync } from 'fflate';
import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const SRC = 'templates-src';
const OUT = 'dist-templates';
const EXCLUDE_DIRS = new Set(['node_modules', '.git', 'dist', '.next', 'coverage', '.turbo']);
const EXCLUDE_FILES = new Set(['bun.lock', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', '.DS_Store']);

function collect(dir: string, base: string, acc: Record<string, Uint8Array>): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry)) continue;
      collect(full, base, acc);
    } else {
      if (EXCLUDE_FILES.has(entry) || entry.endsWith('.log')) continue;
      const rel = relative(base, full).split(sep).join('/');
      acc[rel] = new Uint8Array(readFileSync(full));
    }
  }
}

mkdirSync(OUT, { recursive: true });
const dirs = readdirSync(SRC).filter((n) => statSync(join(SRC, n)).isDirectory());
for (const name of dirs) {
  const files: Record<string, Uint8Array> = {};
  collect(join(SRC, name), join(SRC, name), files);
  const zipped = zipSync(files, { level: 6 });
  writeFileSync(join(OUT, `${name}.zip`), zipped);
  console.log(`${name}.zip  ${zipped.length} bytes  (${Object.keys(files).length} files)`);
}
const catalog = readFileSync(join(SRC, 'template_catalog.json'));
writeFileSync(join(OUT, 'template_catalog.json'), catalog);
console.log(`template_catalog.json  ${catalog.length} bytes`);
