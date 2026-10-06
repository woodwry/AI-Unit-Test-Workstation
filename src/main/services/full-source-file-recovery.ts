import type { FullSourceRunCheckpoint } from './full-source-checkpoint.ts';
import type { TestWriterService } from './test-writer.service.ts';

/** Complete an owned write-ahead replacement; unrelated edits are never overwritten. */
export async function recoverFullSourceReplacement(workspaceRoot: string, checkpoint: FullSourceRunCheckpoint,
  writer: TestWriterService, save: (cp: FullSourceRunCheckpoint) => Promise<FullSourceRunCheckpoint>): Promise<FullSourceRunCheckpoint> {
  const pending = checkpoint.pendingReplacement, file = checkpoint.managedFile;
  if (!pending || !file) return checkpoint;
  if (checkpoint.publication?.phase === 'VERIFIED') throw new Error('已验证发布不能恢复候选替换。');
  let written = false;
  try {
    await writer.loadOwnedGeneratedTest({ workspaceRoot, filePath: file.path, expectedSha256: pending.replacementSha256 });
    written = true;
  } catch {
    await writer.loadOwnedGeneratedTest({ workspaceRoot, filePath: file.path, expectedSha256: pending.originalSha256 });
  }
  if (!written) {
    const prepared = writer.prepareReplacement({ workspaceRoot, filePath: file.path, content: pending.code });
    if (prepared.sha256 !== pending.replacementSha256) throw new Error('完整源码恢复替换摘要不符。');
    await writer.replacePreparedGeneratedTest({ workspaceRoot, filePath: file.path, expectedSha256: pending.originalSha256, prepared });
  }
  return save({ ...checkpoint, managedFile: { ...file, sha256: pending.replacementSha256 }, pendingReplacement: null,
    publication: null });
}
