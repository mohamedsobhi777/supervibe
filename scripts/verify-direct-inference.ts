#!/usr/bin/env bun
/**
 * One-off live check that the gateway-less direct path works end to end, mirroring
 * what core.ts does for the default OpenAI config: OpenAI client pointed at
 * api.openai.com, OPENAI_API_KEY, the bare model id (no "provider/" prefix), and
 * NO temperature/penalty params (gpt-5 reasoning models reject non-defaults). A
 * 200 with content proves the key + endpoint + model name line up.
 *
 * Run with: bun --env-file=.env.local scripts/verify-direct-inference.ts
 */
import OpenAI from 'openai';

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
	console.error('OPENAI_API_KEY missing from env (add it to .env.local)');
	process.exit(1);
}

const baseURL = 'https://api.openai.com/v1/';
// core.ts strips everything up to the first "/" for direct mode; "openai/gpt-5-mini" -> "gpt-5-mini".
const modelId = 'openai/gpt-5-mini';
const model = modelId.slice(modelId.indexOf('/') + 1);

const client = new OpenAI({ apiKey, baseURL });

try {
	const res = await client.chat.completions.create({
		model,
		messages: [{ role: 'user', content: 'Reply with exactly the word: OK' }],
		max_completion_tokens: 16,
		// No temperature/frequency_penalty: gpt-5 reasoning models only accept defaults.
	});
	const text = res.choices?.[0]?.message?.content ?? '';
	console.log(`baseURL=${baseURL}`);
	console.log(`model=${model}`);
	console.log(`status=200 content=${JSON.stringify(text)}`);
	process.exit(0);
} catch (error) {
	console.error(`DIRECT CALL FAILED: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(2);
}
