; Windows Firewall rule for AirWing.
;
; Cast receivers (Chromecast / Google TV / smart TVs) and HLS-based AirPlay receivers fetch
; the live stream *from* this PC, so AirWing needs an inbound allow rule. Without one the
; receiver connects, shows its splash screen, never receives a byte, and appears to hang.
; A program-scoped rule is used so it keeps working if the HTTP port changes.
;
; Best effort: a per-user (non-elevated) install cannot modify firewall rules, so failures
; are ignored. AirWing also detects the condition at runtime and explains it in the UI.

!macro customInstall
  DetailPrint "Adding Windows Firewall rule for AirWing (private + public networks)"
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="AirWing"'
  Pop $0
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="AirWing" dir=in action=allow program="$INSTDIR\AirWing.exe" enable=yes profile=private,public description="Allow AirWing to serve its live stream to receivers on your network"'
  Pop $0
!macroend

!macro customUnInstall
  DetailPrint "Removing Windows Firewall rule for AirWing"
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="AirWing"'
  Pop $0
!macroend
