import { describe, expect, it } from 'vitest';
import { buildBulkWriteScript, parseBulkWriteOutput } from 'worker/services/sandbox/bulkFileScript';

describe('buildBulkWriteScript', () => {
    it('emits one decode line per file with base64 round-trippable content', () => {
        const files = [
            { filePath: '/workspace/i-1/src/index.ts', fileContents: 'const x = "hello \'world\'";\n' },
            { filePath: '/workspace/i-1/README.md', fileContents: 'unicode: é—你好' },
        ];
        const script = buildBulkWriteScript(files);
        expect(script.startsWith('#!/bin/bash')).toBe(true);
        for (const { filePath, fileContents } of files) {
            const line = script.split('\n').find((l) => l.includes(filePath));
            expect(line).toBeDefined();
            const b64 = /echo '([A-Za-z0-9+/=]+)' \| base64 -d/.exec(line ?? '')?.[1] ?? '';
            const decoded = new TextDecoder().decode(
                Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)),
            );
            expect(decoded).toBe(fileContents);
        }
    });

    it('returns an empty-script guard for zero files', () => {
        expect(buildBulkWriteScript([])).toBe('#!/bin/bash');
    });
});

describe('parseBulkWriteOutput', () => {
    it('maps OK markers to success and missing markers to failure', () => {
        const files = [{ filePath: '/a/one.ts' }, { filePath: '/a/two.ts' }];
        const output = 'OK:/a/one.ts\nFAIL:/a/two.ts\n';
        expect(parseBulkWriteOutput(files, output)).toEqual([
            { file: '/a/one.ts', success: true, error: undefined },
            { file: '/a/two.ts', success: false, error: 'Write failed' },
        ]);
    });
});
