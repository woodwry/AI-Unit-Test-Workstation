!include "MUI2.nsh"
!include "nsDialogs.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"

!ifndef BUILD_UNINSTALLER
; 允许用户在目录选择器中选中磁盘根目录。electron-builder 会在进入安装页前
; 自动追加 ${APP_FILENAME} 子目录；否则 NSIS 会直接禁用“下一步”，用户看不到原因。
AllowRootDirInstall true
Var DesktopShortcutCheckbox
Var CreateDesktopShortcut

!macro customInit
  ; Electron 33 与发布契约均要求 Windows 10 1809（内部版本 17763）或更高版本。
  ${IfNot} ${AtLeastWaaS} 1809
    MessageBox MB_OK|MB_ICONSTOP "本工作站需要 Windows 10 1809（内部版本 17763）或更高版本。"
    SetErrorLevel 1633
    Quit
  ${EndIf}
  ; 交互式安装默认勾选；静默安装继续采用同一默认值。
  StrCpy $CreateDesktopShortcut "1"
!macroend

!macro customPageAfterChangeDir
  Page custom DesktopShortcutPageCreate DesktopShortcutPageLeave
!macroend

Function DesktopShortcutPageCreate
  ; 自动更新不重复询问，继续沿用 electron-builder 的快捷方式保留策略。
  ; custom include 会早于 electron-builder 的插件目录加载，因此用 NSIS 内置参数解析，避免提前调用 StdUtils。
  ${GetOptions} "$CMDLINE" "--updated" $0
  ${IfNot} ${Errors}
    Abort
  ${EndIf}

  !insertmacro MUI_HEADER_TEXT "安装选项" "请选择是否创建桌面快捷方式"
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateCheckbox} 0 12u 100% 14u "创建桌面快捷方式"
  Pop $DesktopShortcutCheckbox
  ${NSD_Check} $DesktopShortcutCheckbox
  nsDialogs::Show
FunctionEnd

Function DesktopShortcutPageLeave
  ${NSD_GetState} $DesktopShortcutCheckbox $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $CreateDesktopShortcut "1"
  ${Else}
    StrCpy $CreateDesktopShortcut "0"
  ${EndIf}
FunctionEnd

!macro customInstall
  ; 默认快捷方式由 electron-builder 创建；用户取消时在安装结束前删除。
  ${If} $CreateDesktopShortcut != "1"
    WinShell::UninstShortcut "$newDesktopLink"
    Delete "$newDesktopLink"
    ${If} $oldDesktopLink != $newDesktopLink
      WinShell::UninstShortcut "$oldDesktopLink"
      Delete "$oldDesktopLink"
    ${EndIf}
    System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
  ${EndIf}
!macroend
!else
Var DeleteUserDataOnUninstall
Var KeepUserDataRadio
Var DeleteUserDataRadio
!define PACKAGED_USER_DATA_DIRECTORY_NAME "AI Unit Test Workstation"

!macro customUnInit
  ; 静默卸载、升级和用户未完成页面时默认保留数据。
  StrCpy $DeleteUserDataOnUninstall "0"
!macroend

!macro customUnWelcomePage
  UninstPage custom un.UninstallDataPageCreate un.UninstallDataPageLeave
!macroend

Function un.UninstallDataPageCreate
  ${GetOptions} "$CMDLINE" "--updated" $0
  ${IfNot} ${Errors}
    Abort
  ${EndIf}
  ${If} ${Silent}
    Abort
  ${EndIf}

  !insertmacro MUI_HEADER_TEXT "是否删除工作站的全部数据？" "请选择卸载后的数据处理方式"
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  ${NSD_CreateRadioButton} 0 12u 100% 14u "保留工作站数据（默认）"
  Pop $KeepUserDataRadio
  ${NSD_Check} $KeepUserDataRadio
  ${NSD_CreateRadioButton} 0 36u 100% 14u "删除工作站的全部数据"
  Pop $DeleteUserDataRadio
  ${NSD_CreateLabel} 12u 58u 92% 42u "将删除工作区记录、构建环境、大模型配置、安全保存的 API Key、扩展、日志和缓存。不会删除或修改您导入的项目。"
  Pop $0
  nsDialogs::Show
FunctionEnd

Function un.UninstallDataPageLeave
  ${NSD_GetState} $DeleteUserDataRadio $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $DeleteUserDataOnUninstall "1"
  ${Else}
    StrCpy $DeleteUserDataOnUninstall "0"
  ${EndIf}
FunctionEnd

!macro customUnInstall
  ${If} $DeleteUserDataOnUninstall == "1"
    ${If} $installMode == "all"
      SetShellVarContext current
    ${EndIf}
    ClearErrors
    RMDir /r "$APPDATA\${PACKAGED_USER_DATA_DIRECTORY_NAME}"
    ${If} ${Errors}
      MessageBox MB_OK|MB_ICONEXCLAMATION "工作站部分数据未能删除，请关闭相关程序后手动清理：$APPDATA\AI Unit Test Workstation"
    ${EndIf}
    ${If} $installMode == "all"
      SetShellVarContext all
    ${EndIf}
  ${EndIf}
!macroend
!endif
