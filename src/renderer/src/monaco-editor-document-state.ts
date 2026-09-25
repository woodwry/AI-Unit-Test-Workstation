export class MonacoDecorationIdStore {
  private readonly idsByCanonicalKey = new Map<string, string[]>()

  replace(canonicalKey: string, nextIds: readonly string[]): string[] {
    const previousIds = this.idsByCanonicalKey.get(canonicalKey) ?? []
    this.idsByCanonicalKey.set(canonicalKey, [...nextIds])
    return previousIds
  }

  release(canonicalKey: string): string[] {
    const current = this.idsByCanonicalKey.get(canonicalKey) ?? []
    this.idsByCanonicalKey.delete(canonicalKey)
    return current
  }

  clear(): Array<{ canonicalKey: string; ids: string[] }> {
    const released = Array.from(this.idsByCanonicalKey, ([canonicalKey, ids]) => ({
      canonicalKey,
      ids
    }))
    this.idsByCanonicalKey.clear()
    return released
  }
}

export function updateOpenFileContentByPath<T extends { path: string; content: string }>(
  files: readonly T[],
  path: string,
  content: string
): readonly T[] {
  const index = files.findIndex((file) => file.path === path)
  if (index === -1 || files[index].content === content) {
    return files
  }

  const updated = [...files]
  updated[index] = { ...files[index], content }
  return updated
}
