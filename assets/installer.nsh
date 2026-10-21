; ============================================================
; installer.nsh — 尊泓工具箱 NSIS 自定义脚本（electron-builder nsis.include）
;
; 修复：覆盖安装时弹出「尊泓工具箱 无法关闭。请手动关闭它，然后单击重试
; 以继续。」——挂起/无窗口的旧进程不响应优雅关闭（WM_CLOSE），导致：
;   a) 覆盖安装前的旧版静默卸载（uninstallOldVersion）连续 5 次失败后弹框；
;   b) 默认运行检测 _CHECK_APP_RUNNING 强杀失败后弹框。
;   两处弹框（appCannotBeClosed）都会卡住覆盖安装。
;
; 方案：默认检测（CHECK_APP_RUNNING 会优先插入本宏）之前先静默强杀——
;   1. PowerShell 可用时按安装目录路径精确匹配 Stop-Process（不误杀别处
;      的同名便携版进程）；
;   2. taskkill /F /T 按映像名兜底（覆盖无 Get-CimInstance 的老系统；/T
;      连 7z 等子进程一起结束；也会结束同名便携版，覆盖安装场景可接受）；
;   3. 最多 4 轮「检测-强杀」；
;   4. 仍有幸存进程（典型：旧进程以管理员身份运行、或属于其他用户会话，
;      普通权限 taskkill 返回拒绝访问）时发起一次提权强杀——PowerShell
;      Start-Process -Verb RunAs 弹一次 UAC，授权后以管理员 taskkill /F /T
;      终结；安装器本已提权时 RunAs 静默执行不弹框；用户拒绝 UAC 或仍失败
;      则回落 electron-builder 默认流程（保留本地化提示框，行为不劣于修复前）。
; ============================================================

!include "getProcessInfo.nsh"
Var /GLOBAL pid
Var /GLOBAL ZH_PsOk ; 0=PowerShell 可用 2=不可用 1=未探测
# _CHECK_APP_RUNNING（回落兜底）引用此变量，但其声明在默认分支内
# （IS_POWERSHELL_AVAILABLE），定义 customCheckAppRunning 后该分支被编译
# 掉，必须在此补声明，否则 -WX 下 warning 6000 直接构建失败
Var /GLOBAL IsPowerShellAvailable

!macro _ZH_DETECT_RUNNING
  # 检测：按映像名查存活进程（tasklist+findstr，快且不依赖 PowerShell）。
  # 退出码入 $R9：0=找到进程（需要处理），非 0=无进程。
  nsExec::Exec `"$CmdPath" /C tasklist /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FO CSV /NH | "$SYSDIR\findstr.exe" /B /I /C:"\"${APP_EXECUTABLE_FILENAME}\""`
  Pop $R9
!macroend

!macro customCheckAppRunning
  StrCpy $ZH_PsOk 1
  StrCpy $R8 0
zh_recheck:
  IntOp $R8 $R8 + 1
  !insertmacro _ZH_DETECT_RUNNING
  IntCmp $R9 0 0 zh_clear zh_clear
  # 惰性探测 PowerShell（仅首次，失败标记为不可用不再试）
  StrCmp $ZH_PsOk 2 zh_tk
  StrCmp $ZH_PsOk 0 zh_ps_kill
  nsExec::Exec `"$PowerShellPath" -NoProfile -Command "exit 0"`
  Pop $ZH_PsOk
  IntCmp $ZH_PsOk 0 0 zh_ps_bad zh_ps_bad
  Goto zh_ps_kill
zh_ps_bad:
  StrCpy $ZH_PsOk 2
  Goto zh_tk
zh_ps_kill:
  # 按安装目录路径精确匹配强杀（无路径信息或别处同名进程不受影响）
  nsExec::Exec `"$PowerShellPath" -NoProfile -Command "Get-CimInstance -ClassName Win32_Process | Where-Object { $$_.Path -and $$_.Path.StartsWith('$INSTDIR', 'CurrentCultureIgnoreCase') } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"`
  Pop $0
zh_tk:
  # 按映像名强杀（/T 连子进程），兼容无 Get-CimInstance 的老系统
  nsExec::Exec `"$CmdPath" /C taskkill /F /T /IM "${APP_EXECUTABLE_FILENAME}"`
  Pop $0
  Sleep 1500
  IntCmp $R8 4 zh_final zh_recheck zh_final ; 最多 4 轮后进入提权强杀
zh_final:
  # 4 轮普通强杀后复查：进程已退则直接走默认流程收尾
  !insertmacro _ZH_DETECT_RUNNING
  IntCmp $R9 0 0 zh_clear zh_clear
  # PowerShell 不可用时无提权通道，回落默认提示
  StrCmp $ZH_PsOk 2 zh_clear zh_ekill
zh_ekill:
  # 提权强杀：Start-Process -Verb RunAs 弹一次 UAC（安装器已提权则静默），
  # 授权后的 taskkill 拥有管理员权限，可终结以管理员运行的旧进程。
  # 用户拒绝 UAC → catch → exit 1，照常回落。
  DetailPrint `正在请求权限以结束 ${PRODUCT_NAME} …`
  nsExec::Exec `"$PowerShellPath" -NoProfile -Command "try { Start-Process -FilePath '$SYSDIR\taskkill.exe' -ArgumentList '/F /T /IM \"${APP_EXECUTABLE_FILENAME}\"' -Verb RunAs -Wait } catch { exit 1 }"`
  Pop $0
  Sleep 1500
  !insertmacro _ZH_DETECT_RUNNING
  IntCmp $R9 0 0 zh_clear zh_clear ; 提权击杀成功 → 走默认流程收尾
zh_clear:
  # 同步探测结果给默认流程（非 0 视为不可用，走 tasklist/taskkill 路径）
  StrCpy $IsPowerShellAvailable $ZH_PsOk
  # 兜底回落默认流程（仍检测到存活进程时给出本地化提示框）
  !insertmacro _CHECK_APP_RUNNING
!macroend
