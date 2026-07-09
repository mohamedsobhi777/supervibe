#!/usr/bin/env node
/**
 * Builds (or rebuilds) the SuperServe template that runs the standalone agent
 * process (agent-runtime/src/main.ts) and the generated app's dev server. The
 * name is runtime-oriented (`bun-agent-runtime`), not platform-tied. This
 * template clones the re-platform repo, installs Node + bun, and runs
 * `bun install` once at build time so `boot-agent-sandbox.ts` only has to
 * start the already-installed agent process.
 *
 * `Template.create` builds fully server-side from a base image + shell
 * steps; there is no COPY/upload of local files, so the repo is cloned from
 * a reachable git remote at a pinned ref instead.
 *
 * Required env:
 *   SUPERSERVE_API_KEY   - SuperServe control-plane API key (required)
 * Optional env:
 *   SUPERSERVE_AGENT_TEMPLATE - template name (default: bun-agent-runtime)
 *   SUPERSERVE_BASE_URL       - SuperServe API base URL override
 *   AGENT_TEMPLATE_REPO       - git remote to clone (default: the re-platform fork)
 *   AGENT_TEMPLATE_REF        - branch/tag to clone (default: main)
 *   GIT_CLONE_TOKEN           - read-only token for a PRIVATE repo (scrubbed from the image)
 *
 * This is a manual/staging tool: it creates a real SuperServe template
 * against the live control plane and is never run in tests or CI.
 *
 * Example invocation:
 *   SUPERSERVE_API_KEY=ss_live_... GIT_CLONE_TOKEN=github_pat_... bun run scripts/superserve/build-agent-template.ts
 */

import { Template, type BuildLogEvent } from '@superserve/sdk';

// Runtime-oriented name (bun/node container running the agent + generated app
// dev server) — not tied to the platform.
const TEMPLATE_NAME = process.env.SUPERSERVE_AGENT_TEMPLATE ?? 'bun-agent-runtime';
// The re-platform's `agent-runtime/` code lives in this fork; the original
// `cloudflare/vibesdk` has the old Durable-Object code. Override via env.
const AGENT_REPO = process.env.AGENT_TEMPLATE_REPO ?? process.env.VIBESDK_REPO ?? 'https://github.com/mohamedsobhi777/vibesdk-anywhere';
const AGENT_REF = process.env.AGENT_TEMPLATE_REF ?? process.env.VIBESDK_REF ?? 'main';
// Optional read-only token to clone a PRIVATE repo at build time. Injected
// only into the clone URL and scrubbed together with `.git` before the image
// is finalized, so it never persists in the template image (it may still
// appear in the build provider's build LOGS — use a scoped, rotatable token,
// or make the repo public and omit this).
const GIT_CLONE_TOKEN = process.env.GIT_CLONE_TOKEN;
const cloneUrl = GIT_CLONE_TOKEN
	? AGENT_REPO.replace('https://', `https://x-access-token:${GIT_CLONE_TOKEN}@`)
	: AGENT_REPO;
const BASE_URL = process.env.SUPERSERVE_BASE_URL || undefined;
const API_KEY = process.env.SUPERSERVE_API_KEY;

if (!API_KEY) {
	console.error('SUPERSERVE_API_KEY is required to build the SuperServe agent template');
	process.exit(1);
}

function onBuildLog(event: BuildLogEvent): void {
	console.log(`[${event.stream}] ${event.text}`);
}

async function main(apiKey: string): Promise<void> {
	try {
		const existing = await Template.connect(TEMPLATE_NAME, { apiKey, baseUrl: BASE_URL });
		console.log(`Template "${TEMPLATE_NAME}" already exists; deleting before rebuild`);
		await existing.delete();
	} catch {
		// Not found: this is the first build.
	}

	console.log(`Creating template "${TEMPLATE_NAME}" from ${AGENT_REPO}@${AGENT_REF}${GIT_CLONE_TOKEN ? ' (private, token)' : ''}`);
	const template = await Template.create({
		apiKey,
		baseUrl: BASE_URL,
		name: TEMPLATE_NAME,
		from: 'ubuntu:24.04',
		vcpu: 4,
		memoryMib: 8192,
		diskMib: 10240,
		steps: [
			{
				run: 'apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y curl ca-certificates git unzip procps',
			},
			// Node 22 (some tooling in the vibesdk tree expects node on PATH).
			{ run: 'curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs' },
			// Bun (primary runtime for the agent process and generated apps).
			{
				run: 'curl -fsSL https://bun.sh/install | bash && ln -sf /root/.bun/bin/bun /usr/local/bin/bun && ln -sf /root/.bun/bin/bunx /usr/local/bin/bunx',
			},
			// Clone the re-platform repo and install once at build time so boot
			// only has to start the agent process, not install dependencies.
			// `rm -rf .git` scrubs any clone token before the image is finalized.
			{
				run: `git clone --depth 1 --branch ${AGENT_REF} ${cloneUrl} /opt/vibesdk && cd /opt/vibesdk && bun install && rm -rf /opt/vibesdk/.git`,
			},
			{ run: 'mkdir -p /workspace' },
			{ env: { key: 'VITE_LOGGER_TYPE', value: 'json' } },
		],
		readyCmd: 'test -x /usr/local/bin/bun',
	});

	const info = await template.waitUntilReady({ onLog: onBuildLog });
	console.log(`Template ready: ${info.name} (${info.status})`);
}

main(API_KEY).catch((error: unknown) => {
	console.error('Agent template build failed:', error);
	process.exit(1);
});
