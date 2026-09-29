type ClipboardWriter = Pick<Clipboard, 'writeText'>;

export async function copyModelInterfaceEnvironmentVariable(
  name: string,
  clipboard: ClipboardWriter
): Promise<string> {
  const normalized = name.trim();
  if (!normalized) throw new Error('环境变量名不能为空。');
  await clipboard.writeText(normalized);
  return normalized;
}
