import { describe, expect, it } from 'bun:test';
import { normalizeRelativePath, resolveWithin } from '../src/pathSafety';

describe('resolveWithin', () => {
    it('resolves a plain relative path inside baseDir', () => {
        const resolved = resolveWithin('/tmp/foo', 'index.js');
        expect(resolved).toBe('/tmp/foo/index.js');
    });

    it('resolves a leading-slash path as instance-relative, not host-absolute', () => {
        const resolved = resolveWithin('/tmp/foo', '/index.js');
        expect(resolved).toBe('/tmp/foo/index.js');
    });

    it('returns baseDir itself for the exact-base case (empty relative path)', () => {
        const resolved = resolveWithin('/tmp/foo', '');
        expect(resolved).toBe('/tmp/foo');
    });

    it('returns baseDir itself when the requested path is just "."', () => {
        const resolved = resolveWithin('/tmp/foo', '.');
        expect(resolved).toBe('/tmp/foo');
    });

    it('rejects a "../" escape', () => {
        expect(() => resolveWithin('/tmp/foo', '../bar')).toThrow(/Path traversal rejected/);
    });

    it('rejects an embedded ".." that nets outside baseDir', () => {
        expect(() => resolveWithin('/tmp/foo', 'a/../../bar')).toThrow(/Path traversal rejected/);
    });

    it('rejects deep "../../.." traversal', () => {
        expect(() => resolveWithin('/tmp/foo', '../../../etc/passwd')).toThrow(/Path traversal rejected/);
    });

    it('rejects absolute-path reinjection disguised as a virtual path', () => {
        // Leading slashes are stripped, so this must resolve as
        // /tmp/foo/etc/passwd, not /etc/passwd.
        const resolved = resolveWithin('/tmp/foo', '/etc/passwd');
        expect(resolved).toBe('/tmp/foo/etc/passwd');
    });

    it('rejects a sibling directory that merely shares baseDir as a string prefix', () => {
        // /tmp/foobar is NOT inside /tmp/foo even though the string "/tmp/foo"
        // is a prefix of "/tmp/foobar" -- the trailing-separator check in
        // resolveWithin exists specifically to catch this case.
        expect(() => resolveWithin('/tmp/foo', '../foobar/evil')).toThrow(/Path traversal rejected/);
    });

    it('allows a nested subdirectory path', () => {
        const resolved = resolveWithin('/tmp/foo', 'src/components/Widget.tsx');
        expect(resolved).toBe('/tmp/foo/src/components/Widget.tsx');
    });
});

describe('normalizeRelativePath', () => {
    it('leaves a plain relative path unchanged', () => {
        expect(normalizeRelativePath('package.json')).toBe('package.json');
    });

    it('strips a leading "./"', () => {
        expect(normalizeRelativePath('./package.json')).toBe('package.json');
    });

    it('strips a leading "/"', () => {
        expect(normalizeRelativePath('/package.json')).toBe('package.json');
    });

    it('normalizes a nested path with a leading "./"', () => {
        expect(normalizeRelativePath('./src/index.ts')).toBe('src/index.ts');
    });

    it('collapses redundant "." segments', () => {
        expect(normalizeRelativePath('src/./index.ts')).toBe('src/index.ts');
    });

    it('produces the same canonical form for aliased equivalents of the same file', () => {
        const variants = ['secrets.env', './secrets.env', '/secrets.env'];
        const normalized = variants.map((path) => normalizeRelativePath(path));
        expect(new Set(normalized).size).toBe(1);
        expect(normalized[0]).toBe('secrets.env');
    });

    it('throws for a path that escapes via ".."', () => {
        expect(() => normalizeRelativePath('../outside')).toThrow();
    });
});
