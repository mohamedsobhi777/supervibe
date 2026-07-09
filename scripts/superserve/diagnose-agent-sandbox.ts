#!/usr/bin/env bun
/**
 * Diagnostic for the standalone agent sandbox: finds the newest agent sandbox
 * (metadata.vibesdk_kind === 'agent'), connects, and dumps what's needed to see
 * why a preview is 502-ing — the agent process log, running processes, and
 * whether the generated app's dev server is actually listening on port 8080.
 *
 * Usage: bun --env-file=.env.local scripts/superserve/diagnose-agent-sandbox.ts [sandboxId]
 */
import { Sandbox } from '@superserve/sdk';

const apiKey = process.env.SUPERSERVE_API_KEY;
if (!apiKey) {
	console.error('SUPERSERVE_API_KEY missing');
	process.exit(1);
}
const baseUrl = process.env.SUPERSERVE_BASE_URL || undefined;
const explicitId = process.argv[2];

async function main(): Promise<void> {
	let sandboxId = explicitId;

	if (!sandboxId) {
		const all = await Sandbox.list({ apiKey, baseUrl });
		const agents = all
			.filter((s) => s.metadata?.vibesdk_kind === 'agent')
			.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
		console.log(`Found ${agents.length} agent sandbox(es):`);
		for (const s of agents.slice(0, 6)) {
			console.log(`  ${s.id}  status=${s.status}  session=${s.metadata?.vibesdk_session ?? '?'}  created=${s.createdAt.toISOString()}`);
		}
		if (agents.length === 0) {
			console.log('No agent sandbox found (retry a generation, then re-run this).');
			return;
		}
		sandboxId = agents[0].id;
	}

	console.log(`\n=== Connecting to ${sandboxId} ===`);
	const sandbox = await Sandbox.connect(sandboxId, { apiKey, baseUrl });

	const run = async (label: string, cmd: string): Promise<void> => {
		console.log(`\n----- ${label} (${cmd}) -----`);
		try {
			const r = await sandbox.commands.run(cmd, { timeoutMs: 15_000 });
			if (r.stdout.trim()) console.log(r.stdout.trim());
			if (r.stderr.trim()) console.log(`[stderr] ${r.stderr.trim()}`);
			console.log(`[exit ${r.exitCode}]`);
		} catch (error) {
			console.log(`[failed] ${error instanceof Error ? error.message : String(error)}`);
		}
	};

	await run('agent.log (last 120 lines)', 'tail -n 120 /workspace/agent.log 2>&1 || echo "(no agent.log)"');
	await run('processes', 'ps aux | grep -E "bun|vite|node" | grep -v grep || echo "(none)"');
	await run('port 8080 listener', "(ss -ltnp 2>/dev/null || netstat -ltnp 2>/dev/null) | grep 8080 || echo '(nothing on 8080)'");
	await run('generated workspace', 'ls -la /workspace 2>&1 | head -30');
}

main().catch((error: unknown) => {
	console.error('diagnose failed:', error instanceof Error ? error.message : String(error));
	process.exit(2);
});
