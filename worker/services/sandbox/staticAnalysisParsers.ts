import { CodeIssue, LintSeverity } from './sandboxTypes';

function mapESLintSeverity(severity: number): LintSeverity {
    switch (severity) {
        case 1: return 'warning';
        case 2: return 'error';
        default: return 'info';
    }
}

export function parseESLintJson(stdout: string): CodeIssue[] {
    const issues: CodeIssue[] = [];
    try {
        const lintData = JSON.parse(stdout) as Array<{
            filePath: string;
            messages: Array<{
                message: string;
                line?: number;
                column?: number;
                severity: number;
                ruleId?: string;
            }>;
        }>;
        for (const fileResult of lintData) {
            for (const message of fileResult.messages || []) {
                issues.push({
                    message: message.message,
                    filePath: fileResult.filePath,
                    line: message.line || 0,
                    column: message.column,
                    severity: mapESLintSeverity(message.severity),
                    ruleId: message.ruleId || '',
                    source: 'eslint',
                });
            }
        }
    } catch {
        return [];
    }
    return issues;
}

export function parseTscOutput(output: string): CodeIssue[] {
    const issues: CodeIssue[] = [];
    if (!output || output.trim() === '') {
        return issues;
    }
    let currentError: CodeIssue | null = null;
    for (const line of output.split('\n')) {
        const match = line.match(/^(.+?)\((\d+),(\d+)\): error TS(\d+): (.*)$/);
        if (match) {
            if (currentError) {
                issues.push(currentError);
            }
            currentError = {
                message: match[5].trim(),
                filePath: match[1].trim(),
                line: parseInt(match[2]),
                column: parseInt(match[3]),
                severity: 'error',
                source: 'typescript',
                ruleId: `TS${match[4]}`,
            };
        } else if (currentError && line.trim() && !line.startsWith('src/') && !line.includes(': error TS')) {
            currentError.message += ' ' + line.trim();
        }
    }
    if (currentError) {
        issues.push(currentError);
    }
    return issues;
}

export function summarizeIssues(issues: CodeIssue[]): {
    errorCount: number;
    warningCount: number;
    infoCount: number;
} {
    return {
        errorCount: issues.filter((issue) => issue.severity === 'error').length,
        warningCount: issues.filter((issue) => issue.severity === 'warning').length,
        infoCount: issues.filter((issue) => issue.severity === 'info').length,
    };
}
