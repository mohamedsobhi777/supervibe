/**
 * Path-rebasing node:fs/promises adapter satisfying GitFsPromises.
 *
 * GitVersionControl (worker/agents/git) builds its isomorphic-git config with
 * `dir: '/'` because it was written for a virtual SQLite filesystem rooted at
 * `/`. On a real disk under Bun, `dir: '/'` would target the machine root.
 * This adapter rebases every virtual absolute path (e.g. `/index.js`,
 * `/.git/HEAD`) onto a real base directory before delegating to
 * node:fs/promises, so GitVersionControl can run unmodified against a real
 * checkout directory.
 */

import {
	chmod as fsChmod,
	lstat as fsLstat,
	mkdir as fsMkdir,
	readdir as fsReaddir,
	readFile as fsReadFile,
	readlink as fsReadlink,
	rename as fsRename,
	rmdir as fsRmdir,
	stat as fsStat,
	symlink as fsSymlink,
	unlink as fsUnlink,
	writeFile as fsWriteFile,
} from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { resolve, sep } from 'node:path';
import type { GitFsPromises } from 'worker/agents/git';

/** The exact stat/lstat return shape GitFsPromises declares. */
type GitStat = Awaited<ReturnType<GitFsPromises['stat']>>;

/** Merge the `type` field isomorphic-git's declared stat shape expects onto a real node Stats object. */
function toGitStat(stats: Stats): GitStat {
	return {
		type: stats.isDirectory() ? 'dir' : 'file',
		mode: stats.mode,
		size: stats.size,
		mtimeMs: stats.mtimeMs,
		dev: stats.dev,
		ino: Number(stats.ino),
		uid: stats.uid,
		gid: stats.gid,
		ctime: stats.ctime,
		mtime: stats.mtime,
		ctimeMs: stats.ctimeMs,
		isFile: () => stats.isFile(),
		isDirectory: () => stats.isDirectory(),
		isSymbolicLink: () => stats.isSymbolicLink(),
	};
}

/**
 * Resolve a virtual path against baseDir and reject any traversal that would
 * escape it. Virtual paths from isomorphic-git are always absolute
 * (dir: '/'), but we do not trust that -- both '..' segments and attempts to
 * re-inject an absolute host path must be neutralized.
 *
 * Strategy: strip any leading slashes (so an absolute-looking virtual path
 * can never be resolved as a host-absolute path), then resolve relative to
 * baseDir. Verify the result stays within baseDir before returning it.
 */
export function resolveWithin(baseDir: string, virtualPath: string): string {
	const relative = virtualPath.replace(/^[/\\]+/, '');
	const resolvedBase = resolve(baseDir);
	const resolved = resolve(resolvedBase, relative);

	if (resolved !== resolvedBase && !resolved.startsWith(resolvedBase + sep)) {
		throw new Error(`Path traversal rejected: '${virtualPath}' escapes base directory`);
	}

	return resolved;
}

/**
 * Create a GitFsPromises implementation backed by the real filesystem,
 * rooted at baseDir. Every method rebases its virtual path argument(s)
 * through resolveWithin before delegating to node:fs/promises.
 *
 * Adaptation notes (methods where the node:fs/promises signature needed
 * mapping, not a 1:1 passthrough):
 * - readFile: GitFsPromises returns `Uint8Array | string`; node's readFile
 *   already returns exactly that union for the accepted options shape, so no
 *   conversion is needed, but the options are narrowed to the
 *   `{ encoding?: 'utf8' }` shape GitFsPromises declares (isomorphic-git only
 *   ever requests 'utf8' or no encoding).
 * - stat / lstat: node:fs/promises' `Stats` supplies `isFile()`,
 *   `isDirectory()`, `isSymbolicLink()`, `mode`, `size`, `mtimeMs`, `dev`,
 *   `ino`, `uid`, `gid`, `ctime`, `mtime`, `ctimeMs` directly, but GitFsPromises
 *   additionally declares a `type: 'file' | 'dir'` field that node's Stats does
 *   not have. isomorphic-git itself never reads `.type` off a stat result (it
 *   derives file-vs-tree via `.isDirectory()`), but the declared type must
 *   still be satisfied structurally, so `type` is derived here from
 *   `isDirectory()` and merged onto the returned Stats.
 * - symlink: GitFsPromises declares `(target: string, path: string) => Promise<void>`,
 *   matching node's `symlink(target, path)` order directly.
 * - mkdir: options are passed through unchanged (node supports `recursive`).
 */
export function createNodeGitFs(baseDir: string): GitFsPromises {
	return {
		async readFile(path: string, options?: { encoding?: 'utf8' }): Promise<Uint8Array | string> {
			const real = resolveWithin(baseDir, path);
			if (options?.encoding === 'utf8') {
				return await fsReadFile(real, { encoding: 'utf8' });
			}
			return await fsReadFile(real);
		},

		async writeFile(path: string, data: Uint8Array | string): Promise<void> {
			const real = resolveWithin(baseDir, path);
			await fsWriteFile(real, data);
		},

		async unlink(path: string): Promise<void> {
			const real = resolveWithin(baseDir, path);
			await fsUnlink(real);
		},

		async mkdir(path: string, options?: unknown): Promise<void> {
			const real = resolveWithin(baseDir, path);
			await fsMkdir(real, options as Parameters<typeof fsMkdir>[1]);
		},

		async readdir(path: string): Promise<string[]> {
			const real = resolveWithin(baseDir, path);
			return await fsReaddir(real);
		},

		async stat(path: string): Promise<GitStat> {
			const real = resolveWithin(baseDir, path);
			return toGitStat(await fsStat(real));
		},

		async lstat(path: string): Promise<GitStat> {
			const real = resolveWithin(baseDir, path);
			return toGitStat(await fsLstat(real));
		},

		async rmdir(path: string): Promise<void> {
			const real = resolveWithin(baseDir, path);
			await fsRmdir(real);
		},

		async symlink(target: string, path: string): Promise<void> {
			const real = resolveWithin(baseDir, path);
			await fsSymlink(target, real);
		},

		async readlink(path: string): Promise<string> {
			const real = resolveWithin(baseDir, path);
			return await fsReadlink(real, { encoding: 'utf8' });
		},

		async chmod(path: string, mode: number): Promise<void> {
			const real = resolveWithin(baseDir, path);
			await fsChmod(real, mode);
		},

		async rename(oldPath: string, newPath: string): Promise<void> {
			const realOld = resolveWithin(baseDir, oldPath);
			const realNew = resolveWithin(baseDir, newPath);
			await fsRename(realOld, realNew);
		},
	};
}
