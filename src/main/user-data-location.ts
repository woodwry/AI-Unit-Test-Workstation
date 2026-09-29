import { join } from 'node:path';

export const PACKAGED_USER_DATA_DIRECTORY_NAME = 'AI Unit Test Workstation';

export type ApplicationUserDataAdapter = {
  readonly isPackaged: boolean;
  getPath(name: 'appData' | 'userData'): string;
  setPath(name: 'userData', value: string): void;
};

/**
 * 安装版与开发版使用不同的数据目录，避免安装后的工作站继承开发期状态。
 */
export function configureApplicationUserData(app: ApplicationUserDataAdapter): string {
  if (!app.isPackaged) {
    return app.getPath('userData');
  }

  const productionUserData = join(
    app.getPath('appData'),
    PACKAGED_USER_DATA_DIRECTORY_NAME
  );
  app.setPath('userData', productionUserData);
  return productionUserData;
}
