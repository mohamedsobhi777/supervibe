import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';

import { BaseSandboxService } from 'worker/services/sandbox/BaseSandboxService';
import type {
    BootstrapResponse,
    BootstrapStatusResponse,
    ClearErrorsResponse,
    CommandExecutionResult,
    DeploymentResult,
    ExecuteCommandsResponse,
    GetFilesResponse,
    GetInstanceResponse,
    GetLogsResponse,
    InstanceCreationRequest,
    InstanceDetails,
    ListInstancesResponse,
    RuntimeErrorResponse,
    ShutdownResponse,
    StaticAnalysisResponse,
    WriteFilesRequest,
    WriteFilesResponse,
} from 'worker/services/sandbox/sandboxTypes';
import {
    parseESLintJson,
    parseTscOutput,
    summarizeIssues,
} from 'worker/services/sandbox/staticAnalysisParsers';

import { ProcessMonitor } from '../../container/process-monitor';
import { StorageManager } from '../../container/storage';
import type { LogLine, ProcessInfo } from '../../container/types';

/**
 * Metadata persisted per instance, mirroring the Workers client's
 * `InstanceMetadata` shape (worker/services/sandbox/types.ts). Kept as a
 * local type rather than imported from that file because it currently has
 * uncommitted changes on this branch; the shape is duplicated intentionally
 * to avoid depending on dirty state.
 */
interface LocalInstanceMetadata {
    projectName: string;
    startTime: string;
    previewURL: string;
    processId?: string;
    donttouch_files: string[];
    redacted_files: string[];
    importantFiles?: string[];
}

const READINESS_PATTERNS = [
    /http:\/\/[^\s]+/,
    /ready in \d+/i,
    /Local:\s+http/i,
    /Network:\s+http/i,
    /server running/i,
    /listening on/i,
];

const DEFAULT_DEV_PORT = 8080;
const READY_TIMEOUT_MS = 10_000;
const READY_POLL_INTERVAL_MS = 250;
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
const STATIC_ANALYSIS_TIMEOUT_MS = 120_000;

export interface LocalSandboxServiceOptions {
    sessionId: string;
    workspaceDir: string;
    previewBaseUrl?: string;
    devPort?: number;
}

/**
 * Sandbox implementation for the standalone agent runtime: files live on
 * local disk, commands run via `Bun.spawn`, and the dev server is supervised
 * in-process via the same `ProcessMonitor`/`StorageManager` classes the CLI
 * container tooling uses (container/process-monitor.ts, container/storage.ts).
 * Exactly one instance is supported per service instance, matching the
 * standalone runtime's one-session-per-process model.
 */
export class LocalSandboxService extends BaseSandboxService {
    private readonly sessionId: string;
    private readonly workspaceDir: string;
    private readonly previewBaseUrl?: string;
    private readonly devPort: number;
    private readonly instanceId: string;

    private storage?: StorageManager;
    private monitor?: ProcessMonitor;
    private metadata?: LocalInstanceMetadata;

    constructor(options: LocalSandboxServiceOptions) {
        super(options.sessionId);
        this.sessionId = options.sessionId;
        this.workspaceDir = options.workspaceDir;
        this.previewBaseUrl = options.previewBaseUrl;
        this.devPort = options.devPort ?? DEFAULT_DEV_PORT;
        this.instanceId = `i-${this.sessionId}`;
    }

    async initialize(): Promise<void> {
        await mkdir(this.workspaceDir, { recursive: true });
        // ProcessMonitor's internal SimpleLogManager (container/process-monitor.ts)
        // is not path-parameterized: it derives its log file location from
        // process.env.CLI_DATA_DIR at construction time. We redirect it here,
        // process-wide, before any ProcessMonitor/StorageManager is built so
        // both land under this service's own workspace instead of the CLI's
        // default `./.data` directory.
        process.env.CLI_DATA_DIR = join(this.workspaceDir, 'data');
        await mkdir(process.env.CLI_DATA_DIR, { recursive: true });
    }

    // ==========================================
    // INSTANCE LIFECYCLE
    // ==========================================

    async createInstance(options: InstanceCreationRequest): Promise<BootstrapResponse> {
        try {
            await this.initialize();

            const instanceDir = this.instanceDir();
            await mkdir(instanceDir, { recursive: true });

            for (const file of options.files) {
                await this.writeFileToDisk(instanceDir, file.filePath, file.fileContents);
            }

            const dontTouchFiles = this.parseJsonFile(options.files, '.donttouch_files.json', []);
            const redactedFiles = this.parseJsonFile(options.files, '.redacted_files.json', []);
            const importantFiles = this.parseJsonFile(options.files, '.important_files.json', undefined);

            const installResult = await this.runCommand(instanceDir, 'bun install', INSTALL_TIMEOUT_MS);
            if (installResult.exitCode !== 0) {
                return {
                    success: false,
                    error: `Failed to install dependencies: ${installResult.stderr || installResult.stdout}`,
                };
            }

            const previewURL = this.previewBaseUrl ?? `http://localhost:${this.devPort}`;

            this.storage = new StorageManager(
                join(process.env.CLI_DATA_DIR!, 'errors.db'),
                join(process.env.CLI_DATA_DIR!, 'logs.db'),
            );

            const processInfo: ProcessInfo = {
                id: randomUUID(),
                instanceId: this.instanceId,
                command: 'sh',
                args: ['-c', options.initCommand ?? 'bun run dev'],
                cwd: instanceDir,
                restartCount: 0,
            };

            this.monitor = new ProcessMonitor(processInfo, this.storage, {
                env: { PORT: String(this.devPort), VITE_LOGGER_TYPE: 'json' },
                expectedPort: this.devPort,
            });

            const startResult = await this.monitor.start();
            if (!startResult.success) {
                return {
                    success: false,
                    error: `Failed to start dev server: ${startResult.error.message}`,
                };
            }

            this.metadata = {
                projectName: options.projectName,
                startTime: new Date().toISOString(),
                previewURL,
                processId: this.monitor.getProcessInfo().id,
                donttouch_files: dontTouchFiles,
                redacted_files: redactedFiles,
                importantFiles,
            };
            await this.persistMetadata();

            await this.waitForServerReady();

            return {
                success: true,
                runId: this.instanceId,
                previewURL,
                processId: this.monitor.getProcessInfo().id,
            };
        } catch (error) {
            return {
                success: false,
                error: `Failed to create instance: ${error instanceof Error ? error.message : 'Unknown error'}`,
            };
        }
    }

    async listAllInstances(): Promise<ListInstancesResponse> {
        if (!this.metadata) {
            return { success: true, instances: [], count: 0 };
        }

        const startTime = new Date(this.metadata.startTime);
        const uptime = Math.floor((Date.now() - startTime.getTime()) / 1000);
        const instance: InstanceDetails = {
            runId: this.instanceId,
            startTime,
            uptime,
            previewURL: this.metadata.previewURL,
            directory: this.instanceId,
            serviceDirectory: this.instanceId,
            processId: this.metadata.processId,
        };
        return { success: true, instances: [instance], count: 1 };
    }

    async getInstanceDetails(instanceId: string): Promise<GetInstanceResponse> {
        const notFound = this.ensureExists(instanceId);
        if (notFound) {
            return { success: false, error: notFound };
        }
        const metadata = this.metadata!;
        const startTime = new Date(metadata.startTime);
        const uptime = Math.floor((Date.now() - startTime.getTime()) / 1000);

        const errorsResult = await this.getInstanceErrors(instanceId);

        const instance: InstanceDetails = {
            runId: this.instanceId,
            startTime,
            uptime,
            previewURL: metadata.previewURL,
            directory: this.instanceId,
            serviceDirectory: this.instanceId,
            processId: metadata.processId,
            runtimeErrors: errorsResult.errors,
        };
        return { success: true, instance };
    }

    async getInstanceStatus(instanceId: string): Promise<BootstrapStatusResponse> {
        const notFound = this.ensureExists(instanceId);
        if (notFound) {
            return { success: false, pending: false, isHealthy: false, error: notFound };
        }
        const isHealthy = this.monitor?.getState() === 'running';
        return {
            success: true,
            pending: false,
            isHealthy,
            message: isHealthy ? 'Instance is running normally' : 'Instance may have issues',
            previewURL: this.metadata!.previewURL,
            processId: this.metadata!.processId,
        };
    }

    async shutdownInstance(instanceId: string): Promise<ShutdownResponse> {
        const notFound = this.ensureExists(instanceId);
        if (notFound) {
            return { success: false, error: notFound };
        }
        if (this.monitor) {
            await this.monitor.cleanup();
        }
        return { success: true, message: `Successfully shutdown instance ${instanceId}` };
    }

    // ==========================================
    // FILE OPERATIONS
    // ==========================================

    async writeFiles(
        instanceId: string,
        files: WriteFilesRequest['files'],
    ): Promise<WriteFilesResponse> {
        const notFound = this.ensureExists(instanceId);
        if (notFound) {
            return {
                success: false,
                results: files.map((f) => ({ file: f.filePath, success: false, error: notFound })),
                error: notFound,
            };
        }

        const instanceDir = this.instanceDir();
        const donttouch = new Set(this.metadata!.donttouch_files);
        const results: WriteFilesResponse['results'] = [];
        const writtenPaths: string[] = [];

        for (const file of files) {
            if (donttouch.has(file.filePath)) {
                results.push({
                    file: file.filePath,
                    success: false,
                    error: 'File is forbidden to be modified',
                });
                continue;
            }
            try {
                await this.writeFileToDisk(instanceDir, file.filePath, file.fileContents);
                results.push({ file: file.filePath, success: true });
                writtenPaths.push(file.filePath);
            } catch (error) {
                results.push({
                    file: file.filePath,
                    success: false,
                    error: error instanceof Error ? error.message : 'Unknown error',
                });
            }
        }

        const successCount = results.filter((r) => r.success).length;

        if (successCount > 0 && writtenPaths.some((p) => p.endsWith('.ts') || p.endsWith('.tsx'))) {
            await this.touchReloadTrigger(instanceDir);
        }

        return {
            success: true,
            results,
            message: `Successfully wrote ${successCount}/${files.length} files`,
        };
    }

    async getFiles(instanceId: string, filePaths?: string[]): Promise<GetFilesResponse> {
        const notFound = this.ensureExists(instanceId);
        if (notFound) {
            return { success: false, files: [], error: notFound };
        }

        const instanceDir = this.instanceDir();
        let paths = filePaths;
        let applyFilter = Boolean(filePaths === undefined);

        if (!paths) {
            const important = this.metadata!.importantFiles ?? [];
            paths = await this.expandImportantFiles(instanceDir, important);
            applyFilter = true;
        }

        const redactedPaths = applyFilter ? new Set(this.metadata!.redacted_files) : new Set<string>();

        const files: GetFilesResponse['files'] = [];
        const errors: NonNullable<GetFilesResponse['errors']> = [];

        for (const filePath of paths) {
            try {
                const contents = await readFile(join(instanceDir, filePath), 'utf8');
                files.push({
                    filePath,
                    fileContents: redactedPaths.has(filePath) ? '[REDACTED]' : contents,
                });
            } catch {
                errors.push({ file: filePath, error: 'Failed to read file' });
            }
        }

        return { success: true, files, errors: errors.length > 0 ? errors : undefined };
    }

    // ==========================================
    // LOGS
    // ==========================================

    async getLogs(
        instanceId: string,
        onlyRecent?: boolean,
        durationSeconds?: number,
    ): Promise<GetLogsResponse> {
        const notFound = this.ensureExists(instanceId);
        if (notFound) {
            return { success: false, logs: { stdout: '', stderr: '' }, error: notFound };
        }
        if (!this.monitor) {
            return { success: true, logs: { stdout: '', stderr: '' } };
        }

        if (onlyRecent) {
            const raw = await this.monitor.getAllLogsAndReset();
            const { stdout, stderr } = this.splitLogLines(raw);
            return { success: true, logs: { stdout, stderr } };
        }

        const cutoff = durationSeconds ? Date.now() - durationSeconds * 1000 : undefined;
        const lines = this.monitor
            .getRecentLogs(Number.MAX_SAFE_INTEGER)
            .filter((line) => !cutoff || line.timestamp.getTime() >= cutoff);
        const stdout = lines
            .filter((l) => l.stream === 'stdout')
            .map((l) => l.content)
            .join('\n');
        const stderr = lines
            .filter((l) => l.stream === 'stderr')
            .map((l) => l.content)
            .join('\n');
        return { success: true, logs: { stdout, stderr } };
    }

    // ==========================================
    // COMMAND EXECUTION
    // ==========================================

    async executeCommands(
        instanceId: string,
        commands: string[],
        timeout?: number,
    ): Promise<ExecuteCommandsResponse> {
        const notFound = this.ensureExists(instanceId);
        if (notFound) {
            return {
                success: false,
                results: commands.map((c) => ({ command: c, success: false, output: '', error: notFound })),
                error: notFound,
            };
        }

        const instanceDir = this.instanceDir();
        const results: CommandExecutionResult[] = [];

        for (const command of commands) {
            const result = await this.runCommand(
                instanceDir,
                command,
                timeout ?? DEFAULT_COMMAND_TIMEOUT_MS,
            );
            results.push({
                command,
                success: result.exitCode === 0,
                output: result.stdout,
                error: result.stderr || undefined,
                exitCode: result.exitCode,
            });
        }

        const successCount = results.filter((r) => r.success).length;
        return {
            success: true,
            results,
            message: `Executed ${successCount}/${commands.length} commands successfully`,
        };
    }

    async updateProjectName(instanceId: string, projectName: string): Promise<boolean> {
        const notFound = this.ensureExists(instanceId);
        if (notFound) {
            return false;
        }
        const instanceDir = this.instanceDir();

        try {
            await this.replaceTopLevelName(join(instanceDir, 'package.json'), projectName, 10);
        } catch {
            // package.json may not exist in every template; non-fatal.
        }
        try {
            await this.replaceFirstName(join(instanceDir, 'wrangler.jsonc'), projectName);
        } catch {
            // wrangler.jsonc may not exist in every template; non-fatal.
        }

        this.metadata!.projectName = projectName;
        await this.persistMetadata();
        return true;
    }

    // ==========================================
    // ERROR MANAGEMENT
    // ==========================================

    async getInstanceErrors(instanceId: string, clear?: boolean): Promise<RuntimeErrorResponse> {
        const notFound = this.ensureExists(instanceId);
        if (notFound) {
            return { success: false, errors: [], hasErrors: false, error: notFound };
        }
        if (!this.storage) {
            return { success: true, errors: [], hasErrors: false };
        }

        const result = this.storage.getErrors(this.instanceId);
        if (!result.success) {
            return {
                success: false,
                errors: [],
                hasErrors: false,
                error: result.error.message,
            };
        }

        if (clear) {
            this.storage.clearErrors(this.instanceId);
        }

        return { success: true, errors: result.data, hasErrors: result.data.length > 0 };
    }

    async clearInstanceErrors(instanceId: string): Promise<ClearErrorsResponse> {
        const notFound = this.ensureExists(instanceId);
        if (notFound) {
            return { success: false, error: notFound };
        }
        if (!this.storage) {
            return { success: true, message: 'Cleared 0 errors' };
        }
        const result = this.storage.clearErrors(this.instanceId);
        if (!result.success) {
            return { success: false, error: result.error.message };
        }
        return { success: true, message: `Cleared ${result.data.clearedCount} errors` };
    }

    // ==========================================
    // CODE ANALYSIS
    // ==========================================

    async runStaticAnalysisCode(instanceId: string): Promise<StaticAnalysisResponse> {
        const notFound = this.ensureExists(instanceId);
        if (notFound) {
            return {
                success: false,
                lint: { issues: [] },
                typecheck: { issues: [] },
                error: notFound,
            };
        }

        const instanceDir = this.instanceDir();

        const [lintResult, tscResult] = await Promise.allSettled([
            this.runCommand(instanceDir, 'bun run lint', STATIC_ANALYSIS_TIMEOUT_MS),
            this.runCommand(
                instanceDir,
                'bunx tsc -b --incremental --noEmit --pretty false',
                STATIC_ANALYSIS_TIMEOUT_MS,
            ),
        ]);

        const results: StaticAnalysisResponse = {
            success: true,
            lint: { issues: [], summary: { errorCount: 0, warningCount: 0, infoCount: 0 }, rawOutput: '' },
            typecheck: { issues: [], summary: { errorCount: 0, warningCount: 0, infoCount: 0 }, rawOutput: '' },
        };

        if (lintResult.status === 'fulfilled') {
            const lintIssues = parseESLintJson(lintResult.value.stdout);
            results.lint.issues = lintIssues;
            results.lint.summary = summarizeIssues(lintIssues);
            results.lint.rawOutput = `STDOUT: ${lintResult.value.stdout}\nSTDERR: ${lintResult.value.stderr}`;
        }

        if (tscResult.status === 'fulfilled') {
            const output = tscResult.value.stderr || tscResult.value.stdout;
            const typecheckIssues = parseTscOutput(output);
            results.typecheck.issues = typecheckIssues;
            results.typecheck.summary = summarizeIssues(typecheckIssues);
            results.typecheck.rawOutput = `STDOUT: ${tscResult.value.stdout}\nSTDERR: ${tscResult.value.stderr}`;
        }

        return results;
    }

    // ==========================================
    // DEPLOYMENT
    // ==========================================

    async deployToCloudflareWorkers(): Promise<DeploymentResult> {
        return {
            success: false,
            message: 'Deployment is not available from the standalone agent runtime in phase 1',
            error: 'unsupported',
        };
    }

    // ==========================================
    // INTERNAL HELPERS
    // ==========================================

    private ensureExists(instanceId: string): string | undefined {
        if (instanceId !== this.instanceId || !this.metadata) {
            return `Instance ${instanceId} not found`;
        }
        return undefined;
    }

    private instanceDir(): string {
        return join(this.workspaceDir, this.instanceId);
    }

    private metadataPath(): string {
        return join(this.workspaceDir, `${this.instanceId}-metadata.json`);
    }

    private async persistMetadata(): Promise<void> {
        await writeFile(this.metadataPath(), JSON.stringify(this.metadata, null, 2), 'utf8');
    }

    private async writeFileToDisk(instanceDir: string, filePath: string, contents: string): Promise<void> {
        const fullPath = join(instanceDir, filePath);
        await mkdir(dirname(fullPath), { recursive: true });
        await writeFile(fullPath, contents, 'utf8');
    }

    private async touchReloadTrigger(instanceDir: string): Promise<void> {
        const triggerPath = join(instanceDir, '.reload-trigger');
        const now = new Date();
        try {
            await utimes(triggerPath, now, now);
        } catch {
            await writeFile(triggerPath, '', 'utf8');
        }
    }

    private parseJsonFile(
        files: InstanceCreationRequest['files'],
        fileName: string,
        fallback: string[] | undefined,
    ): string[] {
        const match = files.find((f) => f.filePath === fileName);
        if (!match) return fallback ?? [];
        try {
            return JSON.parse(match.fileContents);
        } catch {
            return fallback ?? [];
        }
    }

    private async expandImportantFiles(instanceDir: string, important: string[]): Promise<string[]> {
        const expanded: string[] = [];
        for (const entry of important) {
            const fullPath = join(instanceDir, entry);
            try {
                const stats = await stat(fullPath);
                if (stats.isDirectory()) {
                    expanded.push(...(await this.listFilesRecursive(instanceDir, fullPath)));
                } else if (stats.isFile()) {
                    expanded.push(entry);
                }
            } catch {
                // Skip entries that no longer exist on disk.
            }
        }
        return expanded;
    }

    private async listFilesRecursive(instanceDir: string, dir: string): Promise<string[]> {
        const entries = await readdir(dir, { withFileTypes: true });
        const results: string[] = [];
        for (const entry of entries) {
            const fullPath = join(dir, entry.name);
            if (entry.isDirectory()) {
                results.push(...(await this.listFilesRecursive(instanceDir, fullPath)));
            } else if (entry.isFile()) {
                results.push(relative(instanceDir, fullPath));
            }
        }
        return results;
    }

    private splitLogLines(raw: string): { stdout: string; stderr: string } {
        const stdoutLines: string[] = [];
        const stderrLines: string[] = [];
        for (const line of raw.split('\n')) {
            if (!line) continue;
            if (line.includes('] [stderr]')) {
                stderrLines.push(line);
            } else {
                stdoutLines.push(line);
            }
        }
        return { stdout: stdoutLines.join('\n'), stderr: stderrLines.join('\n') };
    }

    private async waitForServerReady(): Promise<boolean> {
        if (!this.monitor) return false;
        const start = Date.now();
        while (Date.now() - start < READY_TIMEOUT_MS) {
            const recent = this.monitor.getRecentLogs(200);
            if (this.matchesReadinessPattern(recent)) {
                return true;
            }
            await new Promise((resolve) => setTimeout(resolve, READY_POLL_INTERVAL_MS));
        }
        return false;
    }

    private matchesReadinessPattern(lines: LogLine[]): boolean {
        return lines.some((line) => READINESS_PATTERNS.some((pattern) => pattern.test(line.content)));
    }

    private async replaceTopLevelName(
        filePath: string,
        projectName: string,
        maxLines: number,
    ): Promise<void> {
        const contents = await readFile(filePath, 'utf8');
        const lines = contents.split('\n');
        const nameLinePattern = /^(\s*)"name"\s*:\s*"[^"]*"/;
        for (let i = 0; i < Math.min(maxLines, lines.length); i++) {
            if (nameLinePattern.test(lines[i])) {
                lines[i] = lines[i].replace(nameLinePattern, `$1"name": "${projectName}"`);
                await writeFile(filePath, lines.join('\n'), 'utf8');
                return;
            }
        }
    }

    private async replaceFirstName(filePath: string, projectName: string): Promise<void> {
        const contents = await readFile(filePath, 'utf8');
        const namePattern = /"name"\s*:\s*"[^"]*"/;
        const updated = contents.replace(namePattern, `"name": "${projectName}"`);
        await writeFile(filePath, updated, 'utf8');
    }

    private async runCommand(
        cwd: string,
        command: string,
        timeoutMs: number,
    ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
        const proc = Bun.spawn(['sh', '-c', command], {
            cwd,
            stdout: 'pipe',
            stderr: 'pipe',
        });

        const timeout = setTimeout(() => {
            proc.kill();
        }, timeoutMs);

        try {
            const [stdout, stderr, exitCode] = await Promise.all([
                new Response(proc.stdout).text(),
                new Response(proc.stderr).text(),
                proc.exited,
            ]);
            return { exitCode, stdout, stderr };
        } finally {
            clearTimeout(timeout);
        }
    }
}
