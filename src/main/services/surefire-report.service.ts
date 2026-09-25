import { promises as fs } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DOMParser, type Element as XmlElement, type Document as XmlDocument } from '@xmldom/xmldom';

export type SurefireFailureDetail = {
  suiteName: string;
  testClassName: string;
  testName: string;
  kind: 'failure' | 'error';
  type?: string;
  message?: string;
  detail?: string;
};

export type SurefireExecutionReport = {
  reportCount: number;
  tests: number;
  failures: number;
  errors: number;
  skipped: number;
  generatedTestClassName: string;
  generatedTests: number;
  generatedSkipped: number;
  failureDetails: SurefireFailureDetail[];
};

export type SurefireReportArtifact = {
  fileName: string;
  content: string;
};

type SurefireDirectoryLayout = {
  moduleRoot: string;
  targetDirectory: string;
  currentDirectory: string;
  attemptDirectory: string;
};

const ATTEMPT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TEST_REPORT_PATTERN = /^TEST-.+\.xml$/i;
const SUREFIRE_DIAGNOSTIC_PATTERN = /\.(?:dump|dumpstream)$/i;
const JAVA_CLASS_PATTERN = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;
const MAX_REPORT_FILES = 200;
const MAX_REPORT_BYTES = 5 * 1024 * 1024;
const MAX_FAILURE_DETAILS = 20;
const MAX_FAILURE_DETAIL_LENGTH = 2_000;
const MAX_FAILURE_DETAIL_LINE_LENGTH = 480;

/**
 * 只解析 Workstation 为当前 attempt 创建的独立 Surefire 目录。
 * 该服务不依据 Maven 控制台关键词推测测试是否通过。
 */
export class SurefireReportService {
  private readonly attemptStartedAt = new Map<string, number>();

  async prepareAttempt(moduleRoot: string, attemptId: string): Promise<string> {
    if (!ATTEMPT_ID_PATTERN.test(attemptId)) {
      throw new Error('Surefire 执行标识无效。');
    }
    const root = resolve(moduleRoot);
    const rootRealPath = await fs.realpath(root);
    const currentDirectory = join(root, 'target', 'ai-unit-test', 'surefire', 'current');
    const ancestor = await nearestExisting(currentDirectory);
    const ancestorRealPath = await fs.realpath(ancestor);
    if (!this.isInside(rootRealPath, ancestorRealPath)) {
      throw new Error('Surefire 报告目录通过链接指向当前模块之外。');
    }

    await fs.mkdir(currentDirectory, { recursive: true });
    const currentRealPath = await fs.realpath(currentDirectory);
    if (!this.isInside(rootRealPath, currentRealPath)) {
      throw new Error('Surefire 报告目录通过链接指向当前模块之外。');
    }

    const attemptDirectory = join(currentDirectory, attemptId);
    try {
      await fs.mkdir(attemptDirectory);
    } catch (error) {
      if (isAlreadyExists(error)) {
        throw new Error('本轮 Surefire 报告目录已经存在。');
      }
      throw error;
    }
    const attemptRealPath = await fs.realpath(attemptDirectory);
    if (!this.isInside(currentRealPath, attemptRealPath)) {
      throw new Error('Surefire 报告目录通过链接指向本轮目录之外。');
    }
    this.attemptStartedAt.set(resolve(attemptDirectory), Date.now());
    return attemptDirectory;
  }

  async parseAttempt(
    reportDirectory: string,
    generatedTestClassName: string
  ): Promise<SurefireExecutionReport> {
    if (!JAVA_CLASS_PATTERN.test(generatedTestClassName) || generatedTestClassName.length > 512) {
      throw new Error('本轮生成测试类名无效。');
    }
    const artifacts = (await this.readAttemptArtifacts(reportDirectory))
      .filter((artifact) => TEST_REPORT_PATTERN.test(artifact.fileName));
    if (artifacts.length === 0) {
      throw new Error('未找到本轮 Surefire XML 报告，无法确认测试是否执行。');
    }

    const result: SurefireExecutionReport = {
      reportCount: artifacts.length,
      tests: 0,
      failures: 0,
      errors: 0,
      skipped: 0,
      generatedTestClassName,
      generatedTests: 0,
      generatedSkipped: 0,
      failureDetails: []
    };

    for (const artifact of artifacts) {
      const suite = this.parseSuite(artifact.content);
      result.tests += suite.tests;
      result.failures += suite.failures;
      result.errors += suite.errors;
      result.skipped += suite.skipped;
      const generatedCases = suite.testCases.filter((testCase) =>
        this.matchesGeneratedClass(testCase.testClassName, generatedTestClassName));
      if (generatedCases.length > 0) {
        result.generatedTests += generatedCases.length;
        result.generatedSkipped += generatedCases.filter((testCase) => testCase.skipped).length;
      }
      for (const failure of suite.failureDetails) {
        if (result.failureDetails.length >= MAX_FAILURE_DETAILS) break;
        result.failureDetails.push(failure);
      }
    }

    this.validateAggregate(result);
    return result;
  }

  async readAttemptArtifacts(
    reportDirectory: string
  ): Promise<SurefireReportArtifact[]> {
    const layout = this.directoryLayout(reportDirectory);
    await this.requireSafeAttemptDirectory(layout);

    const entries = await fs.readdir(
      layout.attemptDirectory,
      { withFileTypes: true }
    );
    const attemptReports = entries.filter((entry) => TEST_REPORT_PATTERN.test(entry.name));
    const attemptDiagnostics = entries.filter(
      (entry) => SUREFIRE_DIAGNOSTIC_PATTERN.test(entry.name)
    );
    const fallback = await this.currentDefaultReportEntries(layout);
    const fallbackReports = fallback.entries.filter(
      (entry) => TEST_REPORT_PATTERN.test(entry.name)
    );
    const fallbackDiagnostics = fallback.entries.filter(
      (entry) => SUREFIRE_DIAGNOSTIC_PATTERN.test(entry.name)
    );
    const sources = [{
      directory: layout.attemptDirectory,
      entries: [...attemptReports, ...attemptDiagnostics]
    }, {
      directory: fallback.directory,
      entries: attemptReports.length === 0
        ? [...fallbackReports, ...fallbackDiagnostics]
        : fallbackDiagnostics
    }].filter((source) => source.entries.length > 0);
    const matchingEntries = sources.flatMap((source) => source.entries);
    if (matchingEntries.some(
        (entry) => entry.isSymbolicLink() || !entry.isFile()
      )) {
      throw new Error('Surefire 报告与诊断文件必须是本轮目录中的普通文件。');
    }
    if (matchingEntries.length > MAX_REPORT_FILES) {
      throw new Error('本轮 Surefire XML 文件数量超过上限。');
    }

    const artifacts: SurefireReportArtifact[] = [];
    for (const source of sources) {
      for (const entry of source.entries.sort(
        (left, right) => left.name.localeCompare(right.name)
      )) {
        const reportPath = join(source.directory, entry.name);
        const stat = await fs.lstat(reportPath);
        if (!stat.isFile() || stat.isSymbolicLink()) {
          throw new Error('Surefire 报告与诊断文件必须是本轮目录中的普通文件。');
        }
        if (stat.size <= 0) {
          if (TEST_REPORT_PATTERN.test(entry.name)) {
            throw new Error('本轮 Surefire XML 报告为空。');
          }
          continue;
        }
        if (stat.size > MAX_REPORT_BYTES) {
          throw new Error('本轮 Surefire 报告或诊断文件超过体积上限。');
        }
        artifacts.push({
          fileName: entry.name,
          content: await fs.readFile(reportPath, 'utf8')
        });
      }
    }
    return artifacts;
  }

  async cleanupSession(moduleRoot: string): Promise<void> {
    const root = resolve(moduleRoot);
    const currentDirectory = join(root, 'target', 'ai-unit-test', 'surefire', 'current');
    try {
      const [rootRealPath, currentRealPath] = await Promise.all([
        fs.realpath(root),
        fs.realpath(currentDirectory)
      ]);
      if (!this.isInside(rootRealPath, currentRealPath)) {
        throw new Error('拒绝清理当前模块之外的 Surefire 报告目录。');
      }
      for (const directory of this.attemptStartedAt.keys()) {
        if (this.isInside(currentDirectory, directory)) {
          this.attemptStartedAt.delete(directory);
        }
      }
      await fs.rm(currentDirectory, { recursive: true, force: true });
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }

  private async currentDefaultReportEntries(
    layout: SurefireDirectoryLayout
  ): Promise<{ directory: string; entries: import('node:fs').Dirent[] }> {
    const directory = join(layout.targetDirectory, 'surefire-reports');
    const startedAt = this.attemptStartedAt.get(
      resolve(layout.attemptDirectory)
    ) ?? (await fs.stat(layout.attemptDirectory)).birthtimeMs;
    try {
      const directoryStat = await fs.lstat(directory);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
        throw new Error('默认 Surefire 报告目录必须是当前模块 target 下的普通目录。');
      }
      const [targetRealPath, directoryRealPath] = await Promise.all([
        fs.realpath(layout.targetDirectory),
        fs.realpath(directory)
      ]);
      if (!this.isInside(targetRealPath, directoryRealPath)) {
        throw new Error('默认 Surefire 报告目录通过链接指向当前模块 target 之外。');
      }
      const entries = await fs.readdir(directory, { withFileTypes: true });
      const currentEntries: import('node:fs').Dirent[] = [];
      for (const entry of entries) {
        if (!TEST_REPORT_PATTERN.test(entry.name)
          && !SUREFIRE_DIAGNOSTIC_PATTERN.test(entry.name)) continue;
        if (entry.isSymbolicLink() || !entry.isFile()) {
          currentEntries.push(entry);
          continue;
        }
        const stat = await fs.lstat(join(directory, entry.name));
        if (stat.mtimeMs >= startedAt - 1_000) {
          currentEntries.push(entry);
        }
      }
      return { directory, entries: currentEntries };
    } catch (error) {
      if (isMissing(error)) return { directory, entries: [] };
      throw error;
    }
  }

  private parseSuite(xml: string): {
    suiteName: string;
    tests: number;
    failures: number;
    errors: number;
    skipped: number;
    testCases: Array<{ testClassName: string; skipped: boolean }>;
    failureDetails: SurefireFailureDetail[];
  } {
    if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) {
      throw new Error('Surefire XML 禁止包含 DTD 或实体声明。');
    }
    const parseErrors: string[] = [];
    let document: XmlDocument;
    try {
      document = new DOMParser({
        onError: (_level, message) => parseErrors.push(String(message))
      }).parseFromString(xml, 'application/xml');
    } catch {
      throw new Error('无法解析本轮 Surefire XML 报告。');
    }
    const root = document.documentElement;
    const rootName = root?.localName || root?.nodeName;
    if (parseErrors.length > 0 || !root || rootName !== 'testsuite') {
      throw new Error('无法解析本轮 Surefire XML 报告。');
    }

    const suiteName = this.sanitizePublicText(this.requiredAttribute(root, 'name', 512), 512);
    const tests = this.countAttribute(root, 'tests');
    const failures = this.countAttribute(root, 'failures');
    const errors = this.countAttribute(root, 'errors');
    const skipped = this.countAttribute(root, 'skipped');
    if (failures + errors + skipped > tests) {
      throw new Error('Surefire XML 测试计数不一致。');
    }

    const parsedTestCases: Array<{ testClassName: string; skipped: boolean }> = [];
    const failureDetails: SurefireFailureDetail[] = [];
    let observedFailures = 0;
    let observedErrors = 0;
    let observedSkipped = 0;
    const testCases = root.getElementsByTagName('testcase');
    for (let index = 0; index < testCases.length; index += 1) {
      const testCase = testCases.item(index);
      if (!testCase) continue;
      const testClassName =
        this.sanitizePublicText(this.optionalAttribute(testCase, 'classname', 512), 512)
        || suiteName;
      const testName =
        this.sanitizePublicText(this.optionalAttribute(testCase, 'name', 512), 512)
        || '未知测试';
      let caseSkipped = false;
      for (let child = testCase.firstChild; child; child = child.nextSibling) {
        if (child.nodeType !== 1) continue;
        const element = child as unknown as XmlElement;
        const kindName = element.localName || element.nodeName;
        if (kindName === 'skipped') {
          caseSkipped = true;
          observedSkipped += 1;
          continue;
        }
        if (kindName !== 'failure' && kindName !== 'error') continue;
        if (kindName === 'failure') observedFailures += 1;
        else observedErrors += 1;
        if (failureDetails.length >= MAX_FAILURE_DETAILS) continue;
        const type = this.sanitizePublicText(this.optionalAttribute(element, 'type', 512), 512);
        const message = this.sanitizePublicText(this.optionalAttribute(element, 'message', 1_000), 1_000);
        const detail = this.sanitizeFailureDetail(
          element.textContent ?? '',
          testClassName
        );
        failureDetails.push({
          suiteName,
          testClassName,
          testName,
          kind: kindName,
          ...(type ? { type } : {}),
          ...(message ? { message } : {}),
          ...(detail ? { detail } : {})
        });
      }
      parsedTestCases.push({ testClassName, skipped: caseSkipped });
    }
    if (parsedTestCases.length !== tests
      || observedFailures !== failures
      || observedErrors !== errors
      || observedSkipped !== skipped) {
      throw new Error('Surefire XML 测试用例与计数字段不一致。');
    }

    return {
      suiteName,
      tests,
      failures,
      errors,
      skipped,
      testCases: parsedTestCases,
      failureDetails
    };
  }

  private validateAggregate(report: SurefireExecutionReport): void {
    const countFields = [
      report.reportCount,
      report.tests,
      report.failures,
      report.errors,
      report.skipped,
      report.generatedTests,
      report.generatedSkipped
    ];
    if (countFields.some((count) => !Number.isSafeInteger(count) || count < 0)
      || report.failures + report.errors + report.skipped > report.tests
      || report.generatedSkipped > report.generatedTests) {
      throw new Error('Surefire XML 聚合计数不一致。');
    }
    if (report.generatedTests === 0) {
      throw new Error('Surefire 报告没有执行本轮生成的测试类。');
    }
    if (report.generatedTests === report.generatedSkipped) {
      throw new Error('本轮生成的测试全部被跳过，无法确认候选有效。');
    }
  }

  private directoryLayout(reportDirectory: string): SurefireDirectoryLayout {
    const attemptDirectory = resolve(reportDirectory);
    const attemptId = basename(attemptDirectory);
    const currentDirectory = dirname(attemptDirectory);
    const surefireDirectory = dirname(currentDirectory);
    const aiUnitTestDirectory = dirname(surefireDirectory);
    const targetDirectory = dirname(aiUnitTestDirectory);
    const moduleRoot = dirname(targetDirectory);
    if (!ATTEMPT_ID_PATTERN.test(attemptId)
      || basename(currentDirectory).toLowerCase() !== 'current'
      || basename(surefireDirectory).toLowerCase() !== 'surefire'
      || basename(aiUnitTestDirectory).toLowerCase() !== 'ai-unit-test'
      || basename(targetDirectory).toLowerCase() !== 'target') {
      throw new Error('Surefire 报告目录无效。');
    }
    return { moduleRoot, targetDirectory, currentDirectory, attemptDirectory };
  }

  private async requireSafeAttemptDirectory(layout: SurefireDirectoryLayout): Promise<void> {
    try {
      const [moduleRealPath, targetRealPath, currentRealPath, attemptRealPath] = await Promise.all([
        fs.realpath(layout.moduleRoot),
        fs.realpath(layout.targetDirectory),
        fs.realpath(layout.currentDirectory),
        fs.realpath(layout.attemptDirectory)
      ]);
      if (!this.isInside(moduleRealPath, targetRealPath)
        || !this.isInside(targetRealPath, currentRealPath)
        || !this.isInside(currentRealPath, attemptRealPath)) {
        throw new Error('Surefire 报告目录通过链接指向本轮安全目录之外。');
      }
    } catch (error) {
      if (isMissing(error)) {
        throw new Error('未找到本轮 Surefire XML 报告，无法确认测试是否执行。');
      }
      throw error;
    }
  }

  private countAttribute(element: XmlElement, name: string): number {
    const value = element.getAttribute(name);
    if (value == null || !/^\d+$/.test(value)) {
      throw new Error(`Surefire XML 的 ${name} 计数字段无效。`);
    }
    const count = Number(value);
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error(`Surefire XML 的 ${name} 计数字段无效。`);
    }
    return count;
  }

  private requiredAttribute(element: XmlElement, name: string, limit: number): string {
    const value = this.optionalAttribute(element, name, limit);
    if (!value) {
      throw new Error(`Surefire XML 缺少 ${name} 字段。`);
    }
    return value;
  }

  private optionalAttribute(element: XmlElement, name: string, limit: number): string {
    const value = element.getAttribute(name)?.trim() ?? '';
    return value.slice(0, limit);
  }

  private matchesGeneratedClass(actual: string, expected: string): boolean {
    if (actual === expected || actual.startsWith(`${expected}$`)) return true;
    if (expected.includes('.')) return false;
    const simpleActual = actual.split('.').pop() ?? actual;
    return simpleActual === expected || simpleActual.startsWith(`${expected}$`);
  }

  private sanitizeFailureDetail(value: string, testClassName: string): string {
    const sanitized = this.sanitizePublicText(value, Number.MAX_SAFE_INTEGER);
    return boundedFailureDetail(
      sanitized,
      testClassName,
      MAX_FAILURE_DETAIL_LENGTH
    );
  }

  private sanitizePublicText(value: string, limit: number): string {
    return value
      .replace(/\u001b\[[0-9;]*m/g, '')
      .replace(/[A-Za-z]:[\\/][^\s\r\n]+/g, '[路径]')
      .replace(/(^|[\s("'=])\/(?:[^\s/]+\/)+[^\s:)"']*/gm, '$1[路径]')
      .replace(/\r\n/g, '\n')
      .trim()
      .slice(0, limit);
  }

  private isInside(parentPath: string, childPath: string): boolean {
    const relativePath = relative(parentPath, childPath);
    return relativePath === ''
      || (!relativePath.startsWith(`..${sep}`) && relativePath !== '..' && !isAbsolute(relativePath));
  }
}

function boundedFailureDetail(
  value: string,
  testClassName: string,
  limit: number
): string {
  if (value.length <= limit) return value;

  const lines = value.split('\n').map(boundFailureDetailLine);
  const nonEmptyIndices: number[] = [];
  const causeIndices: number[] = [];
  const generatedTestFrameIndices: number[] = [];
  const applicationFrameIndices: number[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    nonEmptyIndices.push(index);
    if (/^\s*(?:\[ERROR\]\s*)?(?:Caused by:|Suppressed:)\s+/i.test(line)) {
      causeIndices.push(index);
    }
    const owner = failureStackOwner(line);
    if (!owner) continue;
    if (owner === testClassName || owner.startsWith(`${testClassName}$`)) {
      generatedTestFrameIndices.push(index);
    }
    if (!isInfrastructureStackOwner(owner)) {
      applicationFrameIndices.push(index);
    }
  }

  const deepestCauseIndex = causeIndices.at(-1) ?? -1;
  const rootApplicationFrameIndices = applicationFrameIndices.filter(
    (index) => index > deepestCauseIndex
  );
  const priorities = uniqueIndices([
    nonEmptyIndices[0],
    causeIndices.at(-1),
    ...rootApplicationFrameIndices.slice(0, 2),
    generatedTestFrameIndices[0],
    generatedTestFrameIndices.at(-1),
    ...edgeIndices(rootApplicationFrameIndices, 12, 8),
    ...edgeIndices(causeIndices, 8, 8),
    ...edgeIndices(applicationFrameIndices, 16, 16),
    ...edgeIndices(nonEmptyIndices, 6, 8)
  ]);
  const selected = new Set<number>();
  for (const index of priorities) {
    const candidate = new Set(selected);
    candidate.add(index);
    const rendered = renderFailureDetailLines(lines, candidate);
    if (rendered.length <= limit) selected.add(index);
  }

  return renderFailureDetailLines(lines, selected);
}

function boundFailureDetailLine(line: string): string {
  const value = line.trimEnd();
  if (value.length <= MAX_FAILURE_DETAIL_LINE_LENGTH) return value;
  const marker = ' ...[line shortened]... ';
  const tailLength = 80;
  const headLength = MAX_FAILURE_DETAIL_LINE_LENGTH - marker.length - tailLength;
  return `${value.slice(0, headLength)}${marker}${value.slice(-tailLength)}`;
}

function failureStackOwner(line: string): string | null {
  const match = /^\s*(?:\[ERROR\]\s*)?at\s+(?:[A-Za-z0-9_.-]+\/)?([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.(?:[A-Za-z_$][\w$]*|<init>|<clinit>)\(/.exec(
    line
  );
  return match?.[1] ?? null;
}

function isInfrastructureStackOwner(owner: string): boolean {
  return /^(?:java|javax|jdk|sun|org\.junit|org\.mockito|org\.apache\.maven\.surefire|org\.apache\.maven\.plugin|org\.codehaus\.plexus)\./.test(
    owner
  );
}

function edgeIndices(
  values: readonly number[],
  headCount: number,
  tailCount: number
): number[] {
  return uniqueIndices([
    ...values.slice(0, headCount),
    ...values.slice(-tailCount)
  ]);
}

function uniqueIndices(values: readonly (number | undefined)[]): number[] {
  const result: number[] = [];
  const seen = new Set<number>();
  for (const value of values) {
    if (value === undefined || value < 0 || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function renderFailureDetailLines(
  lines: readonly string[],
  selected: ReadonlySet<number>
): string {
  const indices = [...selected].sort((left, right) => left - right);
  if (indices.length === 0) return '';
  const rendered: string[] = [];
  let previous = -1;
  for (const index of indices) {
    const omitted = index - previous - 1;
    if (omitted > 0) {
      rendered.push(`... [${omitted} non-key stack lines omitted] ...`);
    }
    rendered.push(lines[index]);
    previous = index;
  }
  const trailing = lines.length - previous - 1;
  if (trailing > 0) {
    rendered.push(`... [${trailing} non-key stack lines omitted] ...`);
  }
  return rendered.join('\n').trim();
}

async function nearestExisting(candidatePath: string): Promise<string> {
  let candidate = resolve(candidatePath);
  for (;;) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch (error) {
      if (!isMissing(error)) throw error;
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      candidate = parent;
    }
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}
