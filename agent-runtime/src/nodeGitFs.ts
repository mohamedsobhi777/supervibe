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
 *
 * The containment guard (resolveWithin) lives in ./pathSafety.ts and is
 * shared with localSandbox.ts; it is re-exported here so existing imports of
 * `resolveWithin` from this module keep working unchanged.
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
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import type { GitFsPromises } from 'worker/agents/git';
import { resolveWithin } from './pathSafety';

export { resolveWithin } from './pathSafety';

/** The exact stat/lstat return shape GitFsPromises declares. */
type GitStat = Awaited<ReturnType<GitFsPromises['stat']>>;

/**
 * Reject a symlink target that would resolve outside baseDir once the
 * symlink is actually followed on disk.
 *
 * Git-managed symlink targets are conventionally relative to the symlink's
 * own directory (e.g. a link at `/a/link` pointing to `../b/file`), so the
 * target is resolved against `dirname(realLinkPath)` -- not against baseDir
 * directly -- mirroring how the OS resolves the link at read time. An
 * absolute target is resolved as-is before the same containment check, since
 * node's `symlink()` would otherwise write it to disk verbatim.
 */
function assertSymlinkTargetWithin(baseDir: string, realLinkPath: string, target: string): void {
	const resolvedBase = resolve(baseDir);
	const resolvedTarget = isAbsolute(target)
		? resolve(target)
		: resolve(dirname(realLinkPath), target);

	if (resolvedTarget !== resolvedBase && !resolvedTarget.startsWith(resolvedBase + sep)) {
		throw new Error(`Symlink target rejected: '${target}' escapes base directory`);
	}
}

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
 *   matching node's `symlink(target, path)` order directly. `path` is guarded
 *   via resolveWithin like every other method; `target` additionally passes
 *   through assertSymlinkTargetWithin (below), since a symlink whose target
 *   escapes baseDir would let later reads/writes through the link reach the
 *   real filesystem outside the checkout.
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
			assertSymlinkTargetWithin(baseDir, real, target);
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
