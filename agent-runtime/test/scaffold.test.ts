import { describe, expect, it } from 'bun:test';
import { AGENT_RUNTIME_VERSION } from '../src/index';

describe('scaffold', () => {
    it('package resolves and runs under bun test', () => {
        expect(AGENT_RUNTIME_VERSION).toBe('0.1.0');
    });
});
