# AirWing privacy

AirWing captures only the screen, window, region, media file or system audio selected in the app. An active capture indicator is shown in the window; the tray provides Stop mirroring. Closing the window may leave capture running in the tray. Stop capture or quit to end it.

Selected content is sent to the receivers you connect, or to authorized browser viewers on your local network. Browser access can require a code. Casting is intended for trusted networks; content can include personal information and notifications. AirPlay and Cast mirroring use encrypted media transports; local HTTP/browser playback is not encrypted. Do not expose the local server to the internet.

Settings, recent receiver names and network addresses, and diagnostic logs are stored locally. AirPlay pairing keys are encrypted using Windows account-protected storage. They are not included in support exports. Windows account protection does not protect against all software already running as you. Forget pairing removes a receiver's stored keys.

There is no built-in analytics collection or automatic support upload. Support export is initiated by you and writes a local JSON file containing app/runtime versions, preferences, session health and recent logs. Known tokens, pairing secrets, usernames and selected media paths are redacted. Local network addresses, device names and arbitrary text logged by devices may remain; review the file before sharing.

External links open in your browser and are subject to the destination's privacy policy. The optional virtual-display driver is a separate third-party product, not bundled or installed by AirWing. Store updates are managed by Microsoft.

To report a privacy issue, use the project's issue tracker: https://github.com/lgbtnewsradio-sudo/airwing/issues. Do not include unredacted secrets or private media.
