# Microsoft Store preparation

The installed electron-builder 26.15.3 supports APPX desktop packaging. Microsoft accepts APPX alongside MSIX. This project deliberately uses the supported APPX target, not a target unavailable in this dependency version.

## Build

Reserve AirWing in Partner Center and copy Package/Identity/Name, Package/Identity/Publisher and Package/Properties/PublisherDisplayName into these environment variables:

```powershell
$env:AIRWING_STORE_IDENTITY = 'your exact Package/Identity/Name'
$env:AIRWING_STORE_PUBLISHER = 'your exact Package/Identity/Publisher'
$env:AIRWING_STORE_PUBLISHER_NAME = 'your exact publisher display name'
npm run store:check
npm run dist:store
```

Output goes to release/store. Do not upload the normal NSIS EXE as the packaged-app submission. No Partner Center identity is fabricated or checked into source. Store builds do not execute the NSIS firewall macros. The minimum declared desktop version is Windows 10 build 19041; validate your supported Windows versions before listing them.

## Required before submission

- Install and test the package, including Windows Firewall prompts, discovery, Cast video/audio, Apple TV pairing, safeStorage migration, capture selection, pause/stop, tray lifecycle and uninstall. A self-signed testing certificate must match the package publisher; do not make users trust a development certificate. Store delivery handles signing after certification.
- Run the Windows App Certification Kit against the actual package. Passing source tests is not certification. Review restricted runFullTrust approval; the app needs desktop capture, encoders, local networking and tray controls. Do not claim microphone/webcam access.
- Complete Store description, screenshots, support URL, age rating and data declarations. Publish docs/PRIVACY.md at a stable public URL and supply that URL. This file alone is not a hosted policy.
- Distribute the exact corresponding GPL source and third-party notices for each binary version. Review all dependencies and incorporated interoperability code; source preparation is not a legal or trademark clearance.
- Confirm Store account/publisher details and monotonic package version. Public Store submissions must have fourth version component zero; the build uses the three-component app version and disables build-number insertion.
- Store edition uses Windows Security for network permissions and disables the desktop installer firewall helper. Login-at-startup changes are unavailable in this initial packaged edition; no startup task is registered. Drivers are not bundled. Extended desktop requires a separately installed compatible display.
- Keep the existing desktop distribution available during packaged migration. Packaged app data may be separate: test preference/credential migration explicitly before promising seamless migration.

Official requirements: https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/upload-app-packages

The Store package cannot be built with the real identity or certified until the publisher values and packaged-device test results are available.
