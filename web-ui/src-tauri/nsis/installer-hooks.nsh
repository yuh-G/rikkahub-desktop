; Rikkahub installer: ask the user where conversations / config / uploads should live.
;
; This file is `!include`d early by our custom installer template (nsis/installer.template.nsi).
; The actual `Page custom RikkahubDataDirPageCreate RikkahubDataDirPageLeave` directive lives
; in the template itself — placed right after MUI_PAGE_DIRECTORY so the wizard flows:
;   Welcome → License (optional) → Install Dir → Data Dir (this) → Install → Finish.
;
; After files are installed, NSIS_HOOK_POSTINSTALL persists the choice to
; %APPDATA%\com.rikkahub.pc\user-config.json so the Tauri shell reads it on first launch.
;
; NOTE: We do not define `.onInit` — the Tauri template owns it.

!include "MUI2.nsh"
!include "nsDialogs.nsh"
!include "LogicLib.nsh"

Var RIKKAHUB_DATA_DIR
Var RIKKAHUB_DATA_TEXT
Var RIKKAHUB_DATA_BROWSE

Function RikkahubDataDirPageCreate
  ; Default mirrors the user's chosen install dir — "数据路径默认跟着 exe 走".
  ${If} $RIKKAHUB_DATA_DIR == ""
    StrCpy $RIKKAHUB_DATA_DIR "$INSTDIR\pc-data"
  ${EndIf}

  !insertmacro MUI_HEADER_TEXT "选择数据保存位置" "对话记录、设置和上传的文件都会放在这里。"

  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0u 0u 100% 30u "Rikkahub 会把所有的对话历史、应用设置、上传的图片和导出的备份保存到下面的目录。$\r$\n安装完成后你也可以在应用内「设置 → 数据设置」里随时换位置。"

  ${NSD_CreateLabel} 0u 36u 100% 10u "数据保存目录："

  ${NSD_CreateText} 0u 50u 80% 14u "$RIKKAHUB_DATA_DIR"
  Pop $RIKKAHUB_DATA_TEXT

  ${NSD_CreateBrowseButton} 82% 50u 18% 14u "浏览..."
  Pop $RIKKAHUB_DATA_BROWSE
  ${NSD_OnClick} $RIKKAHUB_DATA_BROWSE RikkahubDataDirBrowse

  ${NSD_CreateLabel} 0u 72u 100% 30u "提示：放到 D 盘等大容量分区可以避免占用系统盘空间，但路径里最好不要包含中文字符。"

  nsDialogs::Show
FunctionEnd

Function RikkahubDataDirPageLeave
  ${NSD_GetText} $RIKKAHUB_DATA_TEXT $RIKKAHUB_DATA_DIR
  ${If} $RIKKAHUB_DATA_DIR == ""
    StrCpy $RIKKAHUB_DATA_DIR "$INSTDIR\pc-data"
  ${EndIf}
FunctionEnd

Function RikkahubDataDirBrowse
  nsDialogs::SelectFolderDialog "选择数据保存位置" "$RIKKAHUB_DATA_DIR"
  Pop $0
  ${If} $0 != error
    ${NSD_SetText} $RIKKAHUB_DATA_TEXT "$0"
  ${EndIf}
FunctionEnd

; --- Tauri post-install hook --------------------------------------------------------
; Persist the user's choice to %APPDATA%\com.rikkahub.pc\user-config.json so the Rust
; shell can read it at startup and forward it to the sidecar via env var.
!macro NSIS_HOOK_POSTINSTALL
  ${If} $RIKKAHUB_DATA_DIR != ""
    CreateDirectory "$APPDATA\com.rikkahub.pc"
    Push $RIKKAHUB_DATA_DIR
    Call RikkahubEscapeJson
    Pop $0
    FileOpen $1 "$APPDATA\com.rikkahub.pc\user-config.json" w
    FileWrite $1 '{$\r$\n  "data_dir": "$0"$\r$\n}$\r$\n'
    FileClose $1
    CreateDirectory "$RIKKAHUB_DATA_DIR"
  ${EndIf}
!macroend

; JSON escape helper: doubles every `\`. Input on stack, output on stack.
Function RikkahubEscapeJson
  Exch $0
  Push $1
  Push $2
  Push $3
  StrCpy $1 0
  StrCpy $2 ""
escape_loop:
  StrCpy $3 $0 1 $1
  StrCmp $3 "" escape_done
  StrCmp $3 "\" escape_backslash
  StrCpy $2 "$2$3"
  IntOp $1 $1 + 1
  Goto escape_loop
escape_backslash:
  StrCpy $2 "$2\\"
  IntOp $1 $1 + 1
  Goto escape_loop
escape_done:
  Pop $3
  Pop $1
  Exch $2
  Exch
  Pop $0
FunctionEnd
