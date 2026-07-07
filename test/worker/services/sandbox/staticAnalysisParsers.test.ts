import { describe, expect, it } from 'vitest';
import {
    parseESLintJson,
    parseTscOutput,
    summarizeIssues,
} from 'worker/services/sandbox/staticAnalysisParsers';

describe('parseESLintJson', () => {
    it('flattens files/messages and maps severities', () => {
        const stdout = JSON.stringify([
            {
                filePath: 'src/App.tsx',
                messages: [
                    { message: 'Unexpected var', line: 3, column: 5, severity: 2, ruleId: 'no-var' },
                    { message: 'Prefer const', line: 9, column: 1, severity: 1, ruleId: 'prefer-const' },
                ],
            },
        ]);
        const issues = parseESLintJson(stdout);
        expect(issues).toHaveLength(2);
        expect(issues[0]).toMatchObject({
            filePath: 'src/App.tsx', line: 3, severity: 'error', ruleId: 'no-var', source: 'eslint',
        });
        expect(issues[1].severity).toBe('warning');
    });

    it('returns [] on non-JSON output', () => {
        expect(parseESLintJson('eslint blew up')).toEqual([]);
    });
});

describe('parseTscOutput', () => {
    it('parses file(line,col): error TSxxxx: message lines with continuations', () => {
        const output = [
            "src/main.ts(10,5): error TS2322: Type 'string' is not assignable",
            "  to type 'number'.",
            'src/other.ts(1,1): error TS1005: expected.',
        ].join('\n');
        const issues = parseTscOutput(output);
        expect(issues).toHaveLength(2);
        expect(issues[0]).toMatchObject({
            filePath: 'src/main.ts', line: 10, column: 5, ruleId: 'TS2322', severity: 'error', source: 'typescript',
        });
        expect(issues[0].message).toContain("to type 'number'.");
    });

    it('returns [] for empty output', () => {
        expect(parseTscOutput('')).toEqual([]);
    });
});

describe('summarizeIssues', () => {
    it('counts by severity', () => {
        const issues = parseTscOutput("a.ts(1,1): error TS1: x.\n");
        expect(summarizeIssues(issues)).toEqual({ errorCount: 1, warningCount: 0, infoCount: 0 });
    });
});
