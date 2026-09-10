## AirWing 1.0.0

First release. An open-source AirParrot alternative for Windows 10/11.

**Mirroring**
- Entire display, single app window, or a drag-selected screen region
- 480p to 4K, 15–60 fps, hardware H.264 (Media Foundation) with AAC system audio, optional local mute
- Pause without disconnecting (frozen frame + banner), configurable global hotkeys, tray quick-connect
- Stream to any number of receivers at once from a single encode

**Receivers**
- Apple TV, HomePod, Roku, Fire TV and other AirPlay 2 receivers (HAP pairing with on-screen code or transient pairing, encrypted control channel)
- Reflector and AirPlay 1 receivers
- Chromecast / Google TV / Nest speakers (Google Cast v2, live fMP4 HLS)
- Any web browser via the built-in low-latency receiver page; phone remote page for couch control
- Connect by IP address for receivers on other subnets; favourites and recents

**Media**
- Stream files directly to the receiver (MP4/M4V/MOV/MP3/M4A/AAC/WAV) with play/pause/seek/volume
- Transcode anything Chromium can decode (MKV, WebM, AVI, FLAC, OGG…) into a live stream

**Extend desktop**
- Guided setup with the open-source Virtual Display Driver; virtual displays appear as mirror sources

**Downloads**
- `AirWing-1.0.0-win-x64.exe` — installer (supports silent `/S` install)
- `AirWing-1.0.0-win-x64.zip` — portable

Verified on a real network against a HomePod mini (AirPlay 2 transient pairing, encrypted session, SETUP/RECORD) and with mock AirPlay 2 / Cast receivers in the test suite. Apple TV, Roku and Fire TV require entering the on-screen code once.
