; Screen Revesane: своя страница установщика — ярлык на рабочем столе и автозапуск.
; Подключается через "nsis.include" в package.json.

!include nsDialogs.nsh
!include LogicLib.nsh

; Всё ниже до деинсталляции нужно только установщику: в проходе сборки
; деинсталлятора неиспользуемые переменные — ошибка.
!ifndef BUILD_UNINSTALLER

Var srDesktopBox
Var srAutostartBox
Var srDesktopWanted
Var srAutostartWanted
Var srRussian

; По умолчанию (и при тихой установке, где страницы нет): ярлык — да, автозапуск — нет.
!macro customInit
  StrCpy $srDesktopWanted ${BST_CHECKED}
  StrCpy $srAutostartWanted ${BST_UNCHECKED}
  ; Язык подписей — по языку интерфейса Windows (0x19 — русский).
  System::Call 'kernel32::GetUserDefaultUILanguage() i .r0'
  IntOp $0 $0 & 0x3FF
  ${If} $0 == 0x19
    StrCpy $srRussian "1"
  ${Else}
    StrCpy $srRussian "0"
  ${EndIf}
!macroend

; Страница вставляется после выбора папки, когда интерфейс установщика (MUI)
; уже подключён, — поэтому и её функции объявлены внутри этого макроса.
!macro customPageAfterChangeDir
  Page custom srOptionsShow srOptionsLeave

  Function srOptionsShow
    ${If} $srRussian == "1"
      !insertmacro MUI_HEADER_TEXT "Дополнительно" "Ярлык и запуск вместе с компьютером"
    ${Else}
      !insertmacro MUI_HEADER_TEXT "Additional options" "Shortcut and start with the computer"
    ${EndIf}
    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}
    ${If} $srRussian == "1"
      ${NSD_CreateCheckbox} 0 8u 100% 14u "Создать ярлык на рабочем столе"
    ${Else}
      ${NSD_CreateCheckbox} 0 8u 100% 14u "Create a desktop shortcut"
    ${EndIf}
    Pop $srDesktopBox
    ${If} $srDesktopWanted == ${BST_CHECKED}
      ${NSD_Check} $srDesktopBox
    ${EndIf}
    ${If} $srRussian == "1"
      ${NSD_CreateCheckbox} 0 30u 100% 14u "Запускать при включении компьютера (в трее)"
    ${Else}
      ${NSD_CreateCheckbox} 0 30u 100% 14u "Start with the computer (in the tray)"
    ${EndIf}
    Pop $srAutostartBox
    ${If} $srAutostartWanted == ${BST_CHECKED}
      ${NSD_Check} $srAutostartBox
    ${EndIf}
    nsDialogs::Show
  FunctionEnd

  Function srOptionsLeave
    ${NSD_GetState} $srDesktopBox $srDesktopWanted
    ${NSD_GetState} $srAutostartBox $srAutostartWanted
  FunctionEnd
!macroend

!macro customInstall
  ${If} $srDesktopWanted == ${BST_CHECKED}
    CreateShortCut "$DESKTOP\${PRODUCT_NAME}.lnk" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
    ClearErrors
    WinShell::SetLnkAUMI "$DESKTOP\${PRODUCT_NAME}.lnk" "${APP_ID}"
    System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
  ${EndIf}
  ; Та же запись, что делает сама программа (app.setLoginItemSettings):
  ; имя — идентификатор приложения, запуск в трей с флагом --hidden.
  ${If} $srAutostartWanted == ${BST_CHECKED}
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${APP_ID}" '"$appExe" --hidden'
  ${EndIf}
!macroend

!endif

!macro customUnInstall
  ; При обновлении ярлык и автозапуск не трогаем — только при удалении программы.
  ${IfNot} ${isUpdated}
    Delete "$DESKTOP\${PRODUCT_NAME}.lnk"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${APP_ID}"
  ${EndIf}
!macroend
