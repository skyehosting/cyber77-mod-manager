; Edgerunners Mod Manager: what the uninstaller adds (electron-builder includes build/installer.nsh).
;
; Save backups and the saves of other profiles live outside the app, in
; %USERPROFILE%\Saved Games\Edgerunners Mod Manager, and uninstalling never deletes them. On a real
; uninstall the user is told where they are, and may open the folder (README.txt there lists every
; folder and how to use the saves without the app). Only when that README.txt is there: the app
; writes it once it keeps something.
;
; Not on an update: every update runs the old uninstaller with --updated (checked by isUpdated).
; Not on a silent uninstall (/S): electron-builder's uninstaller runs this section in silent mode
; either way, so /S is read from the command line, as its own un.onInit does. A MessageBox without
; /SD still shows in that silent section (checked with this NSIS version).

!macro customUnInstall
  ${ifNot} ${isUpdated}
    ${GetParameters} $R0
    ClearErrors
    ${GetOptions} $R0 "/S" $R1
    ${If} ${Errors}
    ${AndIf} ${FileExists} "$PROFILE\Saved Games\Edgerunners Mod Manager\README.txt"
      MessageBox MB_YESNO|MB_ICONINFORMATION "Your Cyberpunk 2077 save backups (unless you chose another folder for them), and the saves of your other profiles (if each profile had its own saves), are kept here:$\r$\n$\r$\n$PROFILE\Saved Games\Edgerunners Mod Manager$\r$\n$\r$\nUninstalling does not delete them, and your current saves stay in the game's save folder. README.txt in that folder lists where every one of them is, and how to use them.$\r$\n$\r$\nOpen that folder now?" IDNO edgerunners_saves_done
      ExecShell "open" "$PROFILE\Saved Games\Edgerunners Mod Manager"
      edgerunners_saves_done:
    ${EndIf}
  ${endIf}
!macroend
