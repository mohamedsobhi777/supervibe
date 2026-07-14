/**
 * Builds a single bash script that writes N files via base64 heredoc lines.
 * Reduces 2N data-plane round trips to two (write script + execute), which
 * both the Cloudflare and SuperServe providers rely on for bulk writes.
 */

export function buildBulkWriteScript(
    files: Array<{ filePath: string; fileContents: string }>,
): string {
    const scriptLines = ['#!/bin/bash'];

    for (const { filePath, fileContents } of files) {
        const utf8Bytes = new TextEncoder().encode(fileContents);
        const chunkSize = 8192;
        const base64Chunks: string[] = [];

        for (let i = 0; i < utf8Bytes.length; i += chunkSize) {
            const chunk = utf8Bytes.slice(i, i + chunkSize);
            let binaryString = '';
            for (let j = 0; j < chunk.length; j++) {
                binaryString += String.fromCharCode(chunk[j]);
            }
            base64Chunks.push(btoa(binaryString));
        }

        const base64 = base64Chunks.join('');
        scriptLines.push(
            `mkdir -p "$(dirname "${filePath}")" && echo '${base64}' | base64 -d > "${filePath}" && echo "OK:${filePath}" || echo "FAIL:${filePath}"`,
        );
    }

    return scriptLines.join('\n');
}

export function parseBulkWriteOutput(
    files: Array<{ filePath: string }>,
    output: string,
): Array<{ file: string; success: boolean; error?: string }> {
    const successPaths = new Set<string>();
    for (const match of output.matchAll(/OK:(.+)/g)) {
        if (match[1]) successPaths.add(match[1]);
    }
    return files.map(({ filePath }) => ({
        file: filePath,
        success: successPaths.has(filePath),
        error: successPaths.has(filePath) ? undefined : 'Write failed',
    }));
}
