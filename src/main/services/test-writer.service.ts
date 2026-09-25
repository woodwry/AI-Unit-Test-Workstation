import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import type { WriteGeneratedTestRequest, WriteGeneratedTestResult } from '../../shared/types';

export type PreparedGeneratedTest = {
  workspaceRoot: string;
  testFilePath: string;
  relativePath: string;
  testClassName: string;
  content: string;
  sha256: string;
  bytesWritten: number;
};

export type PreparedGeneratedReplacement = Omit<PreparedGeneratedTest, 'workspaceRoot' | 'testFilePath' | 'relativePath'>;

const MAX_GENERATED_TEST_BYTES = 1024 * 1024;
const GENERATED_TEST_EXTERNALLY_MODIFIED_MESSAGE =
  '生成测试文件已被外部修改，已停止自动替换或删除。';

export class GeneratedTestExternallyModifiedError extends Error {
  readonly code = 'GENERATED_TEST_EXTERNALLY_MODIFIED';

  constructor() {
    super(GENERATED_TEST_EXTERNALLY_MODIFIED_MESSAGE);
    this.name = 'GeneratedTestExternallyModifiedError';
  }
}

export function isGeneratedTestExternallyModifiedError(
  error: unknown
): error is GeneratedTestExternallyModifiedError {
  return error instanceof GeneratedTestExternallyModifiedError
    || (
      error instanceof Error
      && 'code' in error
      && error.code === 'GENERATED_TEST_EXTERNALLY_MODIFIED'
    );
}

export type MethodBatchTemporaryGeneratedTestInput = {
  workspaceRoot: string;
  targetFilePath: string;
  plannedRelativeTestPath: string;
  outputTestClassName: string;
  content: string;
};

export type ExistingMethodBatchTemporaryGeneratedTestInput = Omit<
  MethodBatchTemporaryGeneratedTestInput,
  'content'
>;

export class TestWriterService {
  async writeGeneratedTest(request: WriteGeneratedTestRequest): Promise<WriteGeneratedTestResult> {
    const prepared = await this.prepareGeneratedTest(request);
    return this.writePreparedGeneratedTest(prepared);
  }

  /** 只计算目标路径和最终类名，供正式文件事务在独占写盘前使用。 */
  async prepareGeneratedTest(request: WriteGeneratedTestRequest): Promise<PreparedGeneratedTest> {
    const workspaceRoot = resolve(request.workspaceRoot);
    const preferredTestFilePath = this.resolveTestPath(workspaceRoot, request.targetFilePath, request.suggestedTestPath);
    const targetClassName = basename(request.targetFilePath, '.java');
    const testFilePath = await this.resolveNonConflictingTestPath(preferredTestFilePath, targetClassName);
    this.ensureInsideWorkspace(workspaceRoot, testFilePath);
    const testClassName = basename(testFilePath, '.java');
    const content = this.rewriteTestClassName(request.content, testClassName);

    return this.toPrepared(workspaceRoot, testFilePath, testClassName, content);
  }

  /**
   * 在 Analyzer 会话建立前一次性确定测试文件身份，后续轮次不得再改用其它文件名。
   */
  async planGeneratedTestLocation(input: {
    workspaceRoot: string;
    targetFilePath: string;
  }): Promise<{
    testClassName: string;
    relativeTestPath: string;
  }> {
    const workspaceRoot = resolve(input.workspaceRoot);
    const preferredPath = this.resolveTestPath(workspaceRoot, input.targetFilePath);
    const targetClassName = basename(input.targetFilePath, '.java');
    const testFilePath = await this.resolveNonConflictingTestPath(preferredPath, targetClassName);
    this.ensureInsideWorkspace(workspaceRoot, testFilePath);
    return {
      testClassName: basename(testFilePath, '.java'),
      relativeTestPath: this.toPortableRelativePath(workspaceRoot, testFilePath)
    };
  }

  /**
   * 只使用预先规划的类名和路径准备候选；路径已占用时由首次 `wx` 明确报冲突。
   */
  async prepareGeneratedTestAtPlannedLocation(input: {
    workspaceRoot: string;
    plannedTestClassName: string;
    plannedRelativeTestPath: string;
    content: string;
  }): Promise<PreparedGeneratedTest> {
    const workspaceRoot = resolve(input.workspaceRoot);
    if (isAbsolute(input.plannedRelativeTestPath)) {
      throw new Error('计划的测试文件位置无效，请重新开始生成。');
    }
    const testFilePath = resolve(workspaceRoot, input.plannedRelativeTestPath);
    this.ensureInsideWorkspace(workspaceRoot, testFilePath);
    if (
      basename(testFilePath, '.java') !== input.plannedTestClassName
      || !testFilePath.toLowerCase().endsWith('.java')
    ) {
      throw new Error('计划的测试类名与文件位置不一致，请重新开始生成。');
    }
    const content = this.rewriteTestClassName(input.content, input.plannedTestClassName);
    return this.toPrepared(
      workspaceRoot,
      testFilePath,
      input.plannedTestClassName,
      content
    );
  }

  async prepareMethodBatchTemporaryGeneratedTest(
    input: MethodBatchTemporaryGeneratedTestInput
  ): Promise<PreparedGeneratedTest> {
    const workspaceRoot = resolve(input.workspaceRoot);
    if (isAbsolute(input.plannedRelativeTestPath)) {
      throw new Error('The planned method-test path must be workspace-relative.');
    }
    const targetClassName = basename(input.targetFilePath, '.java');
    const expectedPrefix = `${targetClassName}Tmp`;
    if (
      !new RegExp(
        `^${this.escapeRegExp(expectedPrefix)}[1-9]\\d*Test$`
      ).test(input.outputTestClassName)
    ) {
      throw new Error('The method-batch TMP test class name is invalid.');
    }
    const plannedPath = resolve(workspaceRoot, input.plannedRelativeTestPath);
    this.ensureInsideWorkspace(workspaceRoot, plannedPath);
    const testFilePath = join(
      dirname(plannedPath),
      `${input.outputTestClassName}.java`
    );
    this.ensureInsideWorkspace(workspaceRoot, testFilePath);
    const content = this.rewriteTestClassName(
      input.content,
      input.outputTestClassName
    );
    const prepared = this.toPrepared(
      workspaceRoot,
      testFilePath,
      input.outputTestClassName,
      content
    );
    if (await this.pathExists(testFilePath)) {
      throw new Error(
        `Method-batch TMP test file ${prepared.testClassName}.java already exists.`
      );
    }
    return prepared;
  }

  async inspectExistingMethodBatchTemporaryGeneratedTest(
    input: ExistingMethodBatchTemporaryGeneratedTestInput
  ): Promise<PreparedGeneratedTest | null> {
    const workspaceRoot = resolve(input.workspaceRoot);
    if (isAbsolute(input.plannedRelativeTestPath)) {
      throw new Error('The planned method-test path must be workspace-relative.');
    }
    const targetClassName = basename(input.targetFilePath, '.java');
    const expectedPrefix = `${targetClassName}Tmp`;
    if (!new RegExp(
      `^${this.escapeRegExp(expectedPrefix)}[1-9]\\d*Test$`
    ).test(input.outputTestClassName)) {
      throw new Error('The method-batch TMP test class name is invalid.');
    }
    const plannedPath = resolve(workspaceRoot, input.plannedRelativeTestPath);
    this.ensureInsideWorkspace(workspaceRoot, plannedPath);
    const testFilePath = join(dirname(plannedPath), `${input.outputTestClassName}.java`);
    this.ensureInsideWorkspace(workspaceRoot, testFilePath);
    if (!await this.pathExists(testFilePath)) return null;

    await this.ensureExistingAncestorInsideWorkspace(workspaceRoot, dirname(testFilePath));
    await this.ensureRealDirectoryInsideWorkspace(workspaceRoot, dirname(testFilePath));
    await this.ensureRealFileInsideWorkspace(workspaceRoot, testFilePath);
    const content = await fs.readFile(testFilePath);
    if (content.length <= 0 || content.length > MAX_GENERATED_TEST_BYTES) {
      throw new Error('Existing method-batch TMP test file size is invalid.');
    }
    return this.toPrepared(
      workspaceRoot,
      testFilePath,
      input.outputTestClassName,
      content.toString('utf8')
    );
  }

  /** 将已经完成最终类名改写的候选以 wx 写入，避免覆盖用户文件。 */
  async writePreparedGeneratedTest(
    prepared: PreparedGeneratedTest
  ): Promise<WriteGeneratedTestResult & { sha256: string }> {
    const workspaceRoot = resolve(prepared.workspaceRoot);
    const testFilePath = resolve(prepared.testFilePath);
    this.ensureInsideWorkspace(workspaceRoot, testFilePath);

    await this.ensureExistingAncestorInsideWorkspace(workspaceRoot, dirname(testFilePath));
    await fs.mkdir(dirname(testFilePath), { recursive: true });
    await this.ensureRealDirectoryInsideWorkspace(workspaceRoot, dirname(testFilePath));
    let created = false;
    try {
      const handle = await fs.open(testFilePath, 'wx');
      created = true;
      try {
        await handle.writeFile(prepared.content, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (created) {
        await fs.rm(testFilePath, { force: true });
      }
      throw error;
    }

    return {
      testFilePath,
      relativePath: prepared.relativePath,
      bytesWritten: prepared.bytesWritten,
      testClassName: prepared.testClassName,
      sha256: prepared.sha256
    };
  }

  /** 为同一路径的修复候选准备内容，不会因原文件存在而改用其它文件名。 */
  prepareReplacement(input: {
    workspaceRoot: string;
    filePath: string;
    content: string;
  }): PreparedGeneratedReplacement {
    const workspaceRoot = resolve(input.workspaceRoot);
    const testFilePath = resolve(input.filePath);
    this.ensureInsideWorkspace(workspaceRoot, testFilePath);
    const testClassName = basename(testFilePath, '.java');
    const content = this.rewriteTestClassName(input.content, testClassName);
    const hash = this.hash(content);
    return {
      testClassName,
      content,
      sha256: hash,
      bytesWritten: Buffer.byteLength(content, 'utf8')
    };
  }

  /** 仅当当前文件仍与预期摘要一致时原子替换，防止覆盖用户/IDE 的修改。 */
  async replacePreparedGeneratedTest(input: {
    workspaceRoot: string;
    filePath: string;
    expectedSha256: string;
    prepared: PreparedGeneratedReplacement;
  }): Promise<{ sha256: string; bytesWritten: number }> {
    return this.replaceOwnedArtifact({
      workspaceRoot: input.workspaceRoot,
      filePath: input.filePath,
      expectedSha256: input.expectedSha256,
      content: Buffer.from(input.prepared.content, 'utf8'),
      maxBytes: MAX_GENERATED_TEST_BYTES,
      conflictMessage: '生成测试文件已被外部修改，已停止自动替换或删除。'
    });
  }

  /**
   * 对工作区内、摘要仍匹配的受管文件执行有界替换。
   * 测试源码和 JaCoCo 报告共用该原语，避免出现两套不同的防覆盖规则。
   */
  async replaceOwnedArtifact(input: {
    workspaceRoot: string;
    filePath: string;
    expectedSha256: string;
    content: Buffer;
    maxBytes: number;
    conflictMessage: string;
  }): Promise<{ sha256: string; bytesWritten: number }> {
    if (!Number.isInteger(input.maxBytes) || input.maxBytes <= 0) {
      throw new Error('受管文件体积上限无效。');
    }
    if (input.content.length > input.maxBytes) {
      throw new Error('受管文件超过允许的体积上限。');
    }
    const workspaceRoot = resolve(input.workspaceRoot);
    const filePath = resolve(input.filePath);
    this.ensureInsideWorkspace(workspaceRoot, filePath);
    await this.ensureExistingAncestorInsideWorkspace(workspaceRoot, dirname(filePath));
    await this.ensureRealDirectoryInsideWorkspace(workspaceRoot, dirname(filePath));
    await this.ensureRealFileInsideWorkspace(workspaceRoot, filePath);
    await this.requireFileHash(filePath, input.expectedSha256, input.conflictMessage);
    const temporaryPath = join(dirname(filePath), `.${basename(filePath)}.${randomUUID()}.tmp`);
    try {
      const handle = await fs.open(temporaryPath, 'wx');
      try {
        await handle.writeFile(input.content);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.requireFileHash(filePath, input.expectedSha256, input.conflictMessage);
      // POSIX rename 可直接原子覆盖；Windows 使用现有的摘要复核后替换回退。
      try {
        await fs.rename(temporaryPath, filePath);
      } catch (error) {
        if (
          !(error instanceof Error)
          || !('code' in error)
          || !['EEXIST', 'EPERM'].includes(String(error.code))
        ) {
          throw error;
        }
        await this.requireFileHash(filePath, input.expectedSha256, input.conflictMessage);
        await fs.rm(filePath);
        await fs.rename(temporaryPath, filePath);
      }
      const sha256 = createHash('sha256').update(input.content).digest('hex');
      await this.requireFileHash(filePath, sha256, '受管文件原子替换后的摘要校验失败。');
      return { sha256, bytesWritten: input.content.length };
    } finally {
      await fs.rm(temporaryPath, { force: true });
    }
  }

  /** 仅删除摘要未变化的生成文件；用户修改后保留文件并报告冲突。 */
  async deleteGeneratedTest(input: {
    workspaceRoot: string;
    filePath: string;
    expectedSha256: string;
  }): Promise<void> {
    const workspaceRoot = resolve(input.workspaceRoot);
    const filePath = resolve(input.filePath);
    this.ensureInsideWorkspace(workspaceRoot, filePath);
    await this.ensureExistingAncestorInsideWorkspace(workspaceRoot, dirname(filePath));
    await this.ensureRealDirectoryInsideWorkspace(workspaceRoot, dirname(filePath));
    await this.ensureRealFileInsideWorkspace(workspaceRoot, filePath);
    await this.requireFileHash(
      filePath,
      input.expectedSha256,
      () => new GeneratedTestExternallyModifiedError()
    );
    await fs.unlink(filePath);
  }

  /**
   * 撤回类任务结果时只删除当前路径上的常规文件。
   * 不要求摘要匹配；文件已经不存在时也视为删除成功。
   */
  async deleteGeneratedTestIfPresent(input: {
    workspaceRoot: string;
    filePath: string;
  }): Promise<void> {
    const workspaceRoot = resolve(input.workspaceRoot);
    const filePath = resolve(input.filePath);
    this.ensureInsideWorkspace(workspaceRoot, filePath);
    try {
      const fileStat = await fs.lstat(filePath);
      if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
        throw new Error('拒绝删除不是常规文件的生成测试结果。');
      }
      await this.ensureExistingAncestorInsideWorkspace(workspaceRoot, dirname(filePath));
      await this.ensureRealDirectoryInsideWorkspace(workspaceRoot, dirname(filePath));
      await this.ensureRealFileInsideWorkspace(workspaceRoot, filePath);
      await fs.unlink(filePath);
    } catch (error) {
      if (isMissingFileSystemPath(error)) return;
      throw error;
    }
  }

  async assertGeneratedTestUnchanged(input: {
    workspaceRoot: string;
    filePath: string;
    expectedSha256: string;
  }): Promise<void> {
    const workspaceRoot = resolve(input.workspaceRoot);
    const filePath = resolve(input.filePath);
    this.ensureInsideWorkspace(workspaceRoot, filePath);
    await this.ensureExistingAncestorInsideWorkspace(workspaceRoot, dirname(filePath));
    await this.ensureRealDirectoryInsideWorkspace(workspaceRoot, dirname(filePath));
    await this.ensureRealFileInsideWorkspace(workspaceRoot, filePath);
    await this.requireFileHash(
      filePath,
      input.expectedSha256,
      () => new GeneratedTestExternallyModifiedError()
    );
  }

  async loadOwnedGeneratedTest(input: {
    workspaceRoot: string;
    filePath: string;
    expectedSha256: string;
  }): Promise<string> {
    const workspaceRoot = resolve(input.workspaceRoot);
    const filePath = resolve(input.filePath);
    this.ensureInsideWorkspace(workspaceRoot, filePath);
    await this.ensureExistingAncestorInsideWorkspace(workspaceRoot, dirname(filePath));
    await this.ensureRealDirectoryInsideWorkspace(workspaceRoot, dirname(filePath));
    await this.ensureRealFileInsideWorkspace(workspaceRoot, filePath);
    const content = await fs.readFile(filePath);
    if (content.length <= 0 || content.length > MAX_GENERATED_TEST_BYTES) {
      throw new Error('Owned generated test file size is invalid.');
    }
    const actual = createHash('sha256').update(content).digest('hex');
    if (actual !== input.expectedSha256.toLowerCase()) {
      throw new GeneratedTestExternallyModifiedError();
    }
    return content.toString('utf8');
  }

  private toPrepared(workspaceRoot: string, testFilePath: string, testClassName: string, content: string): PreparedGeneratedTest {
    const bytesWritten = Buffer.byteLength(content, 'utf8');
    if (bytesWritten <= 0 || bytesWritten > MAX_GENERATED_TEST_BYTES) {
      throw new Error('生成测试代码为空或超过 1 MiB 上限。');
    }
    return {
      workspaceRoot,
      testFilePath,
      relativePath: this.toPortableRelativePath(workspaceRoot, testFilePath),
      testClassName,
      content,
      sha256: this.hash(content),
      bytesWritten
    };
  }

  private hash(content: string): string {
    return createHash('sha256').update(content, 'utf8').digest('hex');
  }

  private async requireFileHash(
    filePath: string,
    expectedSha256: string,
    conflict: string | (() => Error) = GENERATED_TEST_EXTERNALLY_MODIFIED_MESSAGE
  ): Promise<void> {
    const content = await fs.readFile(filePath);
    const actual = createHash('sha256').update(content).digest('hex');
    if (actual !== expectedSha256) {
      throw typeof conflict === 'string' ? new Error(conflict) : conflict();
    }
  }

  private toPortableRelativePath(workspaceRoot: string, filePath: string): string {
    return relative(workspaceRoot, filePath).split(sep).join('/');
  }

  resolveTestPath(workspaceRoot: string, targetFilePath: string, suggestedTestPath?: string): string {
    const targetAbsolutePath = isAbsolute(targetFilePath) ? resolve(targetFilePath) : resolve(workspaceRoot, targetFilePath);
    const targetRelativePath = relative(workspaceRoot, targetAbsolutePath).split(sep).join('/');
    const sourceMarker = 'src/main/java/';
    const sourceMarkerIndex = targetRelativePath.indexOf(sourceMarker);

    if (sourceMarkerIndex >= 0 && targetRelativePath.endsWith('.java')) {
      const moduleRelativePath = targetRelativePath.slice(0, sourceMarkerIndex);
      const testSourceRoot = resolve(workspaceRoot, moduleRelativePath, 'src/test/java');
      const sourceParts = targetRelativePath.slice(sourceMarkerIndex + sourceMarker.length).split('/');
      const sourceFileName = sourceParts.pop() ?? basename(targetAbsolutePath);
      const defaultTestFileName = `${sourceFileName.replace(/\.java$/, '')}Test.java`;

      if (suggestedTestPath?.trim()) {
        const suggestedAbsolutePath = isAbsolute(suggestedTestPath)
          ? resolve(suggestedTestPath)
          : resolve(workspaceRoot, suggestedTestPath);
        const suggestedRelativePath = relative(testSourceRoot, suggestedAbsolutePath);
        const suggestionIsInTargetModule =
          suggestedRelativePath === '' ||
          (!suggestedRelativePath.startsWith(`..${sep}`) &&
            suggestedRelativePath !== '..' &&
            !isAbsolute(suggestedRelativePath));

        return suggestionIsInTargetModule
          ? suggestedAbsolutePath
          : resolve(testSourceRoot, ...sourceParts, basename(suggestedAbsolutePath));
      }

      return resolve(testSourceRoot, ...sourceParts, defaultTestFileName);
    }

    if (suggestedTestPath?.trim()) {
      return isAbsolute(suggestedTestPath) ? resolve(suggestedTestPath) : resolve(workspaceRoot, suggestedTestPath);
    }

    return resolve(workspaceRoot, 'src/test/java', `${targetRelativePath.replace(/[\\/]/g, '_').replace(/\.java$/, '')}Test.java`);
  }

  private ensureInsideWorkspace(workspaceRoot: string, testFilePath: string): void {
    const relativePath = relative(workspaceRoot, testFilePath);
    const isOutside = relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath);

    if (isOutside) {
      throw new Error('拒绝将生成的测试写入所选工作区之外。');
    }
  }

  private async ensureRealDirectoryInsideWorkspace(workspaceRoot: string, directoryPath: string): Promise<void> {
    const [realWorkspaceRoot, realDirectoryPath] = await Promise.all([
      fs.realpath(workspaceRoot),
      fs.realpath(directoryPath)
    ]);
    const realRelativePath = relative(realWorkspaceRoot, realDirectoryPath);
    const isOutside =
      realRelativePath === '..' || realRelativePath.startsWith(`..${sep}`) || isAbsolute(realRelativePath);

    if (isOutside) {
      throw new Error('拒绝通过目录联接将生成的测试写入工作区之外。');
    }
  }

  private async ensureRealFileInsideWorkspace(workspaceRoot: string, filePath: string): Promise<void> {
    const [realWorkspaceRoot, realFilePath] = await Promise.all([
      fs.realpath(workspaceRoot),
      fs.realpath(filePath)
    ]);
    const realRelativePath = relative(realWorkspaceRoot, realFilePath);
    const isOutside =
      realRelativePath === '..'
      || realRelativePath.startsWith(`..${sep}`)
      || isAbsolute(realRelativePath);
    if (isOutside) {
      throw new Error('拒绝通过文件链接访问工作区之外的受管文件。');
    }
  }

  private async ensureExistingAncestorInsideWorkspace(workspaceRoot: string, directoryPath: string): Promise<void> {
    const realWorkspaceRoot = await fs.realpath(workspaceRoot);
    let candidatePath = directoryPath;

    for (;;) {
      try {
        const realCandidatePath = await fs.realpath(candidatePath);
        const realRelativePath = relative(realWorkspaceRoot, realCandidatePath);
        const isOutside =
          realRelativePath === '..' || realRelativePath.startsWith(`..${sep}`) || isAbsolute(realRelativePath);
        if (isOutside) {
          throw new Error('拒绝通过目录联接在工作区之外创建测试目录。');
        }
        return;
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
          throw error;
        }
        const parentPath = dirname(candidatePath);
        if (parentPath === candidatePath) {
          throw error;
        }
        candidatePath = parentPath;
      }
    }
  }

  private async resolveNonConflictingTestPath(preferredTestFilePath: string, targetClassName: string): Promise<string> {
    const directory = dirname(preferredTestFilePath);

    for (let index = 0; index < 1000; index += 1) {
      const className = index === 0 ? `${targetClassName}Test` : `${targetClassName}${index}Test`;
      const candidate = join(directory, `${className}.java`);
      if (!(await this.pathExists(candidate))) {
        return candidate;
      }
    }

    throw new Error(`无法为生成的测试找到不冲突的文件路径：${preferredTestFilePath}`);
  }

  private async pathExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  private rewriteTestClassName(content: string, finalClassName: string): string {
    const declarationPattern = /\b(class|interface|record|enum)\s+([A-Za-z_$][\w$]*)\b/;
    const match = content.match(declarationPattern);
    if (!match || match[2] === finalClassName) {
      return content;
    }

    if (!match[2].endsWith('Test')) {
      throw new Error('生成的 Java 代码中没有可安全重命名的测试类声明。');
    }

    const originalClassName = match[2];
    const renamedContent = content.replace(declarationPattern, `$1 ${finalClassName}`);
    const remainingReferencePattern = new RegExp(`\\b${this.escapeRegExp(originalClassName)}\\b`);
    if (remainingReferencePattern.test(renamedContent)) {
      throw new Error('生成的 Java 代码包含额外的测试类引用，无法安全重命名。');
    }

    return renamedContent;
  }

  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}

function isMissingFileSystemPath(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && error.code === 'ENOENT';
}
