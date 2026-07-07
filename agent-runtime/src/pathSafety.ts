/**
 * Shared path-containment helpers for the standalone agent runtime.
 *
 * Both the git filesystem adapter (nodeGitFs.ts) and the local sandbox
 * service (localSandbox.ts) join caller-supplied relative paths onto a real
 * base directory before touching disk. Neither the virtual paths isomorphic-git
 * produces nor the filePath strings an agent tool call supplies can be
 * trusted: '..' segments and re-injected absolute paths must be rejected
 * before the join reaches node:fs.
 */

import { resolve, sep } from 'node:path';

/**
 * Resolve a caller-supplied path against baseDir and reject any traversal
 * that would escape it.
 *
 * Strategy: strip any leading slashes (so an absolute-looking path can never
 * be resolved as a host-absolute path), then resolve relative to baseDir.
 * Verify the result stays within baseDir before returning it. The trailing
 * separator check on the prefix comparison prevents a sibling directory that
 * merely shares baseDir as a string prefix (e.g. baseDir=/tmp/foo matching
 * /tmp/foobar) from being treated as contained.
 */
export function resolveWithin(baseDir: string, requestedPath: string): string {
    const relativePath = requestedPath.replace(/^[/\\]+/, '');
    const resolvedBase = resolve(baseDir);
    const resolved = resolve(resolvedBase, relativePath);

    if (resolved !== resolvedBase && !resolved.startsWith(resolvedBase + sep)) {
        throw new Error(`Path traversal rejected: '${requestedPath}' escapes base directory`);
    }

    return resolved;
}

/**
 * Normalize a caller-supplied relative path to a canonical instance-relative
 * form so that aliases of the same logical path compare equal: a leading
 * './' or '/' is stripped and '.'/'..' segments are collapsed, without
 * touching the real filesystem. Used to compare filePath strings against
 * donttouch_files / redacted_files entries so that 'package.json',
 * './package.json', and '/package.json' are all recognized as the same file.
 *
 * This intentionally reuses resolveWithin's traversal guard (resolving
 * against a fixed sentinel root) rather than reimplementing segment
 * collapsing, so both callers share one definition of "escapes the base."
 * A path that escapes the sentinel root throws just as it would if it were
 * about to be joined onto a real instance directory.
 */
export function normalizeRelativePath(requestedPath: string): string {
    const sentinelRoot = sep === '/' ? '/__path_safety_root__' : 'C:\\__path_safety_root__';
    const resolved = resolveWithin(sentinelRoot, requestedPath);
    const normalized = resolved.slice(sentinelRoot.length + 1);
    return sep === '/' ? normalized : normalized.split(sep).join('/');
}
