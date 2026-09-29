/** 主进程安全存储适配器；实现由 Electron safeStorage 提供。 */
export type CredentialCipher = {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
};
