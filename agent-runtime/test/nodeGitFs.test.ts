import { afterAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitVersionControl } from 'worker/agents/git';
import { createNodeGitFs, resolveWithin } from '../src/nodeGitFs';

const tmpBase = mkdtempSync(join(tmpdir(), 'vibesdk-node-git-fs-'));
afterAll(() => rmSync(tmpBase, { recursive: true, force: true }));

describe('createNodeGitFs', () => {
    describe('path-traversal guard', () => {
        it('rejects a virtual path that escapes baseDir via ../..', () => {
            const fs = createNodeGitFs(tmpBase);
            expect(fs.readFile('/../../etc/passwd')).rejects.toThrow();
        });

        it('rejects a virtual path containing an embedded ..', () => {
            const fs = createNodeGitFs(tmpBase);
            expect(fs.readFile('/foo/../../bar')).rejects.toThrow();
        });

        it('resolveWithin throws synchronously for traversal attempts', () => {
            expect(() => resolveWithin(tmpBase, '/../outside')).toThrow();
        });

        it('resolveWithin allows a plain virtual absolute path to resolve inside baseDir', () => {
            const resolved = resolveWithin(tmpBase, '/index.js');
            expect(resolved.startsWith(tmpBase)).toBe(true);
            expect(resolved.endsWith('index.js')).toBe(true);
        });
    });

    describe('symlink target guard', () => {
        it('rejects a symlink whose relative target escapes baseDir', () => {
            const symlinkBase = mkdtempSync(join(tmpdir(), 'vibesdk-node-git-fs-symlink-'));
            const fs = createNodeGitFs(symlinkBase);
            // Link lives at /link inside symlinkBase; a target of
            // '../../../etc/passwd' resolves (relative to the link's own
            // directory, i.e. symlinkBase itself) well outside symlinkBase.
            expect(fs.symlink('../../../etc/passwd', '/link')).rejects.toThrow(/Symlink target rejected/);
        });

        it('rejects a symlink whose absolute target points outside baseDir', () => {
            const symlinkBase = mkdtempSync(join(tmpdir(), 'vibesdk-node-git-fs-symlink-'));
            const fs = createNodeGitFs(symlinkBase);
            expect(fs.symlink('/etc/passwd', '/link')).rejects.toThrow(/Symlink target rejected/);
        });

        it('allows a symlink whose relative target stays within baseDir', async () => {
            const symlinkBase = mkdtempSync(join(tmpdir(), 'vibesdk-node-git-fs-symlink-'));
            writeFileSync(join(symlinkBase, 'real.txt'), 'hello');
            const fs = createNodeGitFs(symlinkBase);

            await fs.symlink('real.txt', '/link');

            expect(existsSync(join(symlinkBase, 'link'))).toBe(true);
            expect(readFileSync(join(symlinkBase, 'link'), 'utf8')).toBe('hello');
        });

        it('allows a symlink target nested in a subdirectory whose ".." segments stay within baseDir', async () => {
            const symlinkBase = mkdtempSync(join(tmpdir(), 'vibesdk-node-git-fs-symlink-'));
            mkdirSync(join(symlinkBase, 'sub'), { recursive: true });
            writeFileSync(join(symlinkBase, 'real.txt'), 'nested-ok');
            const fs = createNodeGitFs(symlinkBase);

            // Link lives at /sub/link; target '../real.txt' resolves relative
            // to /sub (the link's own directory) back to baseDir/real.txt,
            // which is still inside baseDir.
            await fs.symlink('../real.txt', '/sub/link');

            expect(readFileSync(join(symlinkBase, 'sub', 'link'), 'utf8')).toBe('nested-ok');
        });
    });

    describe('end-to-end through GitVersionControl on a real disk', () => {
        const repoDir = join(tmpBase, 'repo');
        // The rebasing adapter maps the virtual root '/' onto repoDir; isomorphic-git's
        // internal recursive mkdir stops as soon as it computes a virtual parent of '/'
        // (it assumes the filesystem root always exists, true for the SQLite-backed
        // default), so the real repoDir itself must pre-exist -- same precondition a
        // real `git init <path>` has for its parent directory.
        mkdirSync(repoDir, { recursive: true });
        const gitFs = createNodeGitFs(repoDir);
        // GitVersionControl only touches `sql` when no fs override is supplied (see git.ts
        // constructor); passing an override means the SQL executor is never invoked.
        const git = new GitVersionControl(null as never, { fs: gitFs });

        it('init() succeeds and creates .git on the real disk', async () => {
            await git.init();
            expect(existsSync(join(repoDir, '.git'))).toBe(true);
            expect(existsSync(join(repoDir, '.git', 'HEAD'))).toBe(true);
        });

        it('commit() records a commit reachable via getHead()', async () => {
            expect(await git.getHead()).toBeNull();

            const oid = await git.commit(
                [{ filePath: 'hello.txt', fileContents: 'hello from node fs\n' }],
                'initial commit',
            );

            expect(oid).not.toBeNull();
            expect(await git.getHead()).toBe(oid);
        });

        it('committed file content is readable back from the real disk', () => {
            const onDisk = readFileSync(join(repoDir, 'hello.txt'), 'utf8');
            expect(onDisk).toBe('hello from node fs\n');
        });

        it('log() reflects the commit history', async () => {
            const history = await git.log();
            expect(history.length).toBe(1);
            expect(history[0].message.trim()).toBe('initial commit');
        });
    });
});
