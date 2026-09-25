import { DOMParser, type Element as XmlElement } from '@xmldom/xmldom';

export type MavenBatchCandidateIdentity = {
  candidateId: string;
  filePath: string;
  qualifiedTestClassName: string;
};

export type MavenBatchCandidateStatus =
  | 'PASSED'
  | 'COMPILE_FAILED'
  | 'TEST_FAILED'
  | 'UNPROVEN';

export type MavenBatchCandidateAttribution = {
  candidateId: string;
  status: MavenBatchCandidateStatus;
  diagnostic: string;
};

export type MavenBatchAttributionResult = {
  ambiguous: boolean;
  attributedFailureCandidateIds: string[];
  results: Record<string, MavenBatchCandidateAttribution>;
};

type SurefireArtifact = {
  fileName: string;
  content: string;
};

const MAX_SUREFIRE_CONSOLE_DIAGNOSTIC_LENGTH = 2_000;
const SUREFIRE_DIAGNOSTIC_PATTERN = /\.(?:dump|dumpstream)$/i;

/** Attributes shared Maven evidence only when it names a managed candidate. */
export class MavenBatchDiagnosticAttributionService {
  attributeCompile(input: {
    candidates: readonly MavenBatchCandidateIdentity[];
    stdout: string;
    stderr: string;
  }): MavenBatchAttributionResult {
    const output = [input.stdout, input.stderr].filter(Boolean).join('\n');
    const diagnostics = this.compileDiagnosticBlocks(output);
    const attributed = new Map<string, string[]>();

    for (const diagnostic of diagnostics) {
      const matches = input.candidates.filter((candidate) =>
        diagnostic.normalizedPath === normalizeWindowsPath(candidate.filePath)
      );
      if (matches.length === 1) {
        const candidateId = matches[0].candidateId;
        const current = attributed.get(candidateId) ?? [];
        current.push(diagnostic.text);
        attributed.set(candidateId, current);
      }
    }

    if (attributed.size === 0) {
      const classMatches = input.candidates.filter((candidate) =>
        containsQualifiedClassName(output, candidate.qualifiedTestClassName)
      );
      if (classMatches.length === 1) {
        attributed.set(classMatches[0].candidateId, [output.trim()]);
      }
    }

    const results = initialResults(input.candidates);
    for (const [candidateId, messages] of attributed) {
      results[candidateId] = {
        candidateId,
        status: 'COMPILE_FAILED',
        diagnostic: messages.filter(Boolean).join('\n')
      };
    }
    return {
      ambiguous: attributed.size === 0,
      attributedFailureCandidateIds: input.candidates
        .map((candidate) => candidate.candidateId)
        .filter((candidateId) => attributed.has(candidateId)),
      results
    };
  }

  attributeSurefire(input: {
    candidates: readonly MavenBatchCandidateIdentity[];
    artifacts: readonly SurefireArtifact[];
    stdout: string;
    stderr: string;
  }): MavenBatchAttributionResult {
    const cases = new Map<string, {
      seen: number;
      failed: string[];
      skipped: string[];
    }>();

    for (const artifact of input.artifacts) {
      if (!/^TEST-.+\.xml$/i.test(artifact.fileName)) continue;
      if (/<!DOCTYPE|<!ENTITY/i.test(artifact.content)) continue;
      const document = new DOMParser({
        onError: () => {}
      }).parseFromString(artifact.content, 'application/xml');
      const testCases = document.getElementsByTagName('testcase');
      for (let index = 0; index < testCases.length; index += 1) {
        const testCase = testCases.item(index);
        const className = testCase?.getAttribute('classname')?.trim();
        if (!testCase || !className) continue;
        const aggregate = cases.get(className) ?? { seen: 0, failed: [], skipped: [] };
        aggregate.seen += 1;
        for (const tagName of ['failure', 'error'] as const) {
          const failures = testCase.getElementsByTagName(tagName);
          for (let failureIndex = 0; failureIndex < failures.length; failureIndex += 1) {
            const failure = failures.item(failureIndex);
            if (!failure) continue;
            aggregate.failed.push(formatXmlDiagnostic(failure));
          }
        }
        const skipped = testCase.getElementsByTagName('skipped');
        for (let skippedIndex = 0; skippedIndex < skipped.length; skippedIndex += 1) {
          const item = skipped.item(skippedIndex);
          if (item) aggregate.skipped.push(formatXmlDiagnostic(item));
        }
        cases.set(className, aggregate);
      }
    }

    const results = initialResults(input.candidates);
    const attributedFailureCandidateIds: string[] = [];
    for (const candidate of input.candidates) {
      const aggregate = cases.get(candidate.qualifiedTestClassName);
      if (!aggregate || aggregate.seen === 0) continue;
      if (aggregate.failed.length > 0) {
        results[candidate.candidateId] = {
          candidateId: candidate.candidateId,
          status: 'TEST_FAILED',
          diagnostic: aggregate.failed.join('\n')
        };
        attributedFailureCandidateIds.push(candidate.candidateId);
      } else if (aggregate.skipped.length === 0) {
        results[candidate.candidateId] = {
          candidateId: candidate.candidateId,
          status: 'PASSED',
          diagnostic: ''
        };
      } else {
        results[candidate.candidateId] = {
          candidateId: candidate.candidateId,
          status: 'UNPROVEN',
          diagnostic: aggregate.skipped.join('\n')
        };
      }
    }

    const consoleOutput = [input.stdout, input.stderr].filter(Boolean).join('\n');
    for (const candidate of input.candidates) {
      if (results[candidate.candidateId].status !== 'UNPROVEN') continue;
      const diagnostic = explicitSurefireConsoleFailure(
        consoleOutput,
        candidate.qualifiedTestClassName
      );
      if (!diagnostic) continue;
      results[candidate.candidateId] = {
        candidateId: candidate.candidateId,
        status: 'TEST_FAILED',
        diagnostic
      };
      attributedFailureCandidateIds.push(candidate.candidateId);
    }

    for (const artifact of input.artifacts) {
      if (!SUREFIRE_DIAGNOSTIC_PATTERN.test(artifact.fileName)) continue;
      const matchingCandidates = input.candidates.filter((candidate) =>
        containsQualifiedClassName(artifact.content, candidate.qualifiedTestClassName)
      );
      if (matchingCandidates.length !== 1) continue;
      const candidate = matchingCandidates[0];
      if (results[candidate.candidateId].status !== 'UNPROVEN') continue;
      results[candidate.candidateId] = {
        candidateId: candidate.candidateId,
        status: 'TEST_FAILED',
        diagnostic: boundedArtifactDiagnostic(
          artifact.content,
          candidate.qualifiedTestClassName
        )
      };
      attributedFailureCandidateIds.push(candidate.candidateId);
    }

    return {
      ambiguous: false,
      attributedFailureCandidateIds,
      results
    };
  }

  private compileDiagnosticBlocks(output: string): Array<{
    normalizedPath: string;
    text: string;
  }> {
    const lines = output.split(/\r?\n/);
    const starts: Array<{ index: number; path: string }> = [];
    const pattern = /(?:^|\s)\/?([A-Za-z]:[\\/][^\r\n]*?\.java):\[(?:\d+),(?:\d+)\]/i;
    for (let index = 0; index < lines.length; index += 1) {
      const match = lines[index].match(pattern);
      if (match) starts.push({ index, path: match[1] });
    }
    return starts.map((start, index) => ({
      normalizedPath: normalizeWindowsPath(start.path),
      text: lines.slice(start.index, starts[index + 1]?.index ?? lines.length)
        .join('\n')
        .trim()
    }));
  }
}

function initialResults(
  candidates: readonly MavenBatchCandidateIdentity[]
): Record<string, MavenBatchCandidateAttribution> {
  return Object.fromEntries(candidates.map((candidate) => [candidate.candidateId, {
    candidateId: candidate.candidateId,
    status: 'UNPROVEN' as const,
    diagnostic: ''
  }]));
}

function explicitSurefireConsoleFailure(
  output: string,
  qualifiedTestClassName: string
): string | null {
  if (!output.trim()) return null;
  const lines = output.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const payload = mavenConsolePayload(lines[index]);
    const marker = /^(?:Crashed|Timed out) tests:\s*(.*)$/i.exec(payload);
    if (!marker) continue;
    if (consoleClassListContains(marker[1], qualifiedTestClassName)) {
      return boundedConsoleDiagnostic(lines, index, index);
    }
    const searchEnd = Math.min(lines.length, index + 12);
    for (let cursor = index + 1; cursor < searchEnd; cursor += 1) {
      const candidateLine = mavenConsolePayload(lines[cursor]);
      if (!consoleClassListContains(candidateLine, qualifiedTestClassName)) continue;
      return boundedConsoleDiagnostic(lines, index, cursor);
    }
  }

  return null;
}

function mavenConsolePayload(line: string): string {
  return line.replace(/^\s*\[[A-Z]+\]\s*/, '').trim();
}

function consoleClassListContains(value: string, qualifiedTestClassName: string): boolean {
  return value.split(/[\s,]+/).some((item) => item === qualifiedTestClassName);
}

function boundedConsoleDiagnostic(
  lines: readonly string[],
  firstEvidenceLine: number,
  lastEvidenceLine: number
): string {
  const first = Math.max(0, firstEvidenceLine - 4);
  const last = Math.min(lines.length, lastEvidenceLine + 5);
  const diagnostic = lines.slice(first, last).join('\n').trim();
  if (diagnostic.length <= MAX_SUREFIRE_CONSOLE_DIAGNOSTIC_LENGTH) {
    return diagnostic;
  }
  return lines
    .slice(firstEvidenceLine, lastEvidenceLine + 1)
    .join('\n')
    .trim()
    .slice(0, MAX_SUREFIRE_CONSOLE_DIAGNOSTIC_LENGTH);
}

function boundedArtifactDiagnostic(
  content: string,
  qualifiedTestClassName: string
): string {
  const lines = content.split(/\r?\n/);
  const candidateLine = lines.findIndex((line) =>
    containsQualifiedClassName(line, qualifiedTestClassName)
  );
  if (candidateLine < 0) return '';
  const first = Math.max(0, candidateLine - 20);
  const last = Math.min(lines.length, candidateLine + 6);
  const diagnostic = lines.slice(first, last).join('\n').trim();
  if (diagnostic.length <= MAX_SUREFIRE_CONSOLE_DIAGNOSTIC_LENGTH) {
    return diagnostic;
  }
  return diagnostic.slice(0, MAX_SUREFIRE_CONSOLE_DIAGNOSTIC_LENGTH);
}

function normalizeWindowsPath(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/').toLowerCase();
}

function containsQualifiedClassName(output: string, qualifiedClassName: string): boolean {
  const escaped = qualifiedClassName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9_$])${escaped}([^A-Za-z0-9_$]|$)`).test(output);
}

function formatXmlDiagnostic(node: XmlElement): string {
  return [node.getAttribute('message')?.trim(), node.textContent?.trim()]
    .filter((item): item is string => Boolean(item))
    .join('\n');
}
