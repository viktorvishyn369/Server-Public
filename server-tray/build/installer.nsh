; PhotoLynk NSIS Installer Script
; Kill running processes before install/uninstall

!macro customInit
  ; Kill any running PhotoLynk processes before installation
  nsExec::ExecToLog 'taskkill /F /IM "PhotoLynk Desktop.exe" /T'
  ; Wait a moment for processes to fully terminate
  Sleep 1000
!macroend

!macro customInstall
  ; Additional cleanup after install if needed
!macroend

!macro customUnInit
  ; Kill any running PhotoLynk processes before uninstallation
  nsExec::ExecToLog 'taskkill /F /IM "PhotoLynk Desktop.exe" /T'
  ; Wait a moment for processes to fully terminate
  Sleep 1000
!macroend

!macro customUnInstall
  ; Additional cleanup during uninstall if needed
!macroend
