import { execFile } from 'node:child_process';

export function configureFirewall(executable: string, allowPublic: boolean): Promise<void> {
  if (process.platform !== 'win32') return Promise.reject(new Error('This setting is available on Windows only.'));
  if (process.windowsStore) return Promise.reject(new Error('For the Store edition, use Windows Security to choose the networks AirWing may access.'));
  const literal = executable.replace(/'/g, "''");
  const profiles = allowPublic ? 'Private,Public' : 'Private';
  const elevated = `$ErrorActionPreference='Stop'; Get-NetFirewallRule -DisplayName 'AirWing' -ErrorAction SilentlyContinue | Remove-NetFirewallRule; New-NetFirewallRule -DisplayName 'AirWing' -Direction Inbound -Action Allow -Program '${literal}' -Profile ${profiles} -Enabled True | Out-Null`;
  const encoded = Buffer.from(elevated, 'utf16le').toString('base64');
  const script = `$p=Start-Process -FilePath powershell.exe -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList '-NoProfile -NonInteractive -EncodedCommand ${encoded}'; exit $p.ExitCode`;
  return new Promise((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true }, (err) => {
    if (err) reject(new Error('Firewall change was cancelled or failed. Existing Windows permissions may still apply.'));
    else resolve();
  }));
}
