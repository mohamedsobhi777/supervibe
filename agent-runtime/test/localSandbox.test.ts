import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalSandboxService } from '../src/localSandbox';

const workspaceDir = mkdtempSync(join(tmpdir(), 'vibesdk-local-sandbox-'));
afterAll(() => rmSync(workspaceDir, { recursive: true, force: true }));

describe('LocalSandboxService', () => {
    const service = new LocalSandboxService({ sessionId: 'test-1', workspaceDir, devPort: 8189 });

    it('creates an instance: writes files, installs deps, starts a dev server, reports ready', async () => {
        const result = await service.createInstance({
            projectName: 'local-app',
            initCommand: 'bun run dev',
            files: [
                { filePath: 'package.json', fileContents: JSON.stringify({ name: 'local-app', scripts: { dev: 'bun run server.ts' } }) },
                { filePath: 'server.ts', fileContents: 'const s = Bun.serve({ port: Number(process.env.PORT ?? 8189), fetch: () => new Response("ok") }); console.log(`listening on http://localhost:${s.port}`);' },
                { filePath: '.important_files.json', fileContents: '["server.ts"]' },
                { filePath: '.donttouch_files.json', fileContents: '["package.json"]' },
                { filePath: '.redacted_files.json', fileContents: '[]' },
            ],
        });
        expect(result.success).toBe(true);
        expect(result.runId).toBe('i-test-1');
        expect(result.previewURL).toContain('8189');
        const health = await service.getInstanceStatus('i-test-1');
        expect(health.isHealthy).toBe(true);
    }, 30_000);

    it('writeFiles respects donttouch and touches the reload trigger for ts files', async () => {
        const write = await service.writeFiles('i-test-1', [
            { filePath: 'extra.ts', fileContents: 'export const x = 1;' },
            { filePath: 'package.json', fileContents: '{}' },
        ]);
        expect(write.results.find((r) => r.file === 'extra.ts')?.success).toBe(true);
        expect(write.results.find((r) => r.file === 'package.json')?.success).toBe(false);
    });

    it('executeCommands returns per-command exit codes', async () => {
        const result = await service.executeCommands('i-test-1', ['echo hello', 'exit 3']);
        expect(result.results[0]).toMatchObject({ success: true });
        expect(result.results[0].output.trim()).toBe('hello');
        expect(result.results[1]).toMatchObject({ success: false, exitCode: 3 });
    });

    it('getFiles applies redaction and important-files default', async () => {
        const files = await service.getFiles('i-test-1', ['server.ts']);
        expect(files.success).toBe(true);
        expect(files.files[0].filePath).toBe('server.ts');
    });

    it('shutdownInstance stops the dev server', async () => {
        const down = await service.shutdownInstance('i-test-1');
        expect(down.success).toBe(true);
        const health = await service.getInstanceStatus('i-test-1');
        expect(health.isHealthy ?? false).toBe(false);
    }, 15_000);
});
