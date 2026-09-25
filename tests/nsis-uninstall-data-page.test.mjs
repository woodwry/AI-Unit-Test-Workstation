import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const installerIncludeUrl = new URL(
  '../packaging/windows/installer.nsh',
  import.meta.url
);

test('registers the user-data choice as an NSIS uninstaller page', async () => {
  const source = await readFile(installerIncludeUrl, 'utf8');

  assert.match(
    source,
    /UninstPage\s+custom\s+un\.UninstallDataPageCreate\s+un\.UninstallDataPageLeave/
  );
  assert.match(source, /Function\s+un\.UninstallDataPageCreate\b/);
  assert.match(source, /Function\s+un\.UninstallDataPageLeave\b/);

  assert.doesNotMatch(source, /\bPage\s+custom\s+UninstallDataPageCreate\b/);
  assert.doesNotMatch(source, /Function\s+UninstallDataPage(?:Create|Leave)\b/);
});

test('keeps user data by default and suppresses the choice during silent updates', async () => {
  const source = await readFile(installerIncludeUrl, 'utf8');

  assert.match(source, /StrCpy\s+\$DeleteUserDataOnUninstall\s+"0"/);
  assert.match(
    source,
    /Function\s+un\.UninstallDataPageCreate[\s\S]*\$\{GetOptions\}\s+"\$CMDLINE"\s+"--updated"[\s\S]*Abort[\s\S]*\$\{If\}\s+\$\{Silent\}[\s\S]*Abort[\s\S]*FunctionEnd/
  );
  assert.match(
    source,
    /\$DeleteUserDataOnUninstall\s+==\s+"1"[\s\S]*RMDir\s+\/r\s+"\$APPDATA\\\$\{PACKAGED_USER_DATA_DIRECTORY_NAME\}"/
  );
});
