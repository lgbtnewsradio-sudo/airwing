# AirWing

**Wireless screen mirroring, media streaming and extended desktop for Windows — open source.**

AirWing does what AirParrot 3 does on Windows, and then some: mirror your whole screen, a single app window or a hand-drawn region to Apple TV, HomePod, Chromecast, Roku, Fire TV, Reflector and any device with a web browser. Stream media files straight to the TV with remote control, send system audio to speakers, turn a TV into an extra monitor, and drive everything from your phone.

It is built on Electron + TypeScript, uses WebCodecs for hardware H.264/AAC encoding, and implements the AirPlay 2 (HAP pairing, encrypted control channel) and Google Cast v2 protocols in plain Node.js.

## Feature comparison

| Capability | AirParrot 3 | AirWing |
| --- | --- | --- |
| Mirror entire display | ✅ | ✅ 1080p60 / 1440p / 4K, hardware H.264 |
| Mirror a single application window | ✅ | ✅ |
| Mirror a screen region | — | ✅ drag a rectangle on any display |
| Audio-only streaming to speakers | ✅ | ✅ AAC 96–320 kbps, mute-local option |
| Stream media files | ✅ | ✅ direct (receiver decodes, lossless audio) **or** transcode (MKV/WebM/AVI/FLAC/… anything Chromium plays) |
| Receivers: Apple TV, AirPlay 2 TVs (Roku, Fire TV, Samsung, LG) | ✅ | ✅ AirPlay 2 with HAP pairing, encrypted session |
| Receivers: HomePod / AirPlay speakers | ✅ | ✅ transient pairing (no code) |
| Receivers: Chromecast / Google TV / Nest speakers | ✅ | ✅ Google Cast v2, live fMP4 HLS |
| Receivers: Reflector and other software receivers | ✅ | ✅ AirPlay 1 and 2 |
| Receivers: **any web browser** (smart TV, laptop, tablet) | — | ✅ built-in low-latency browser receiver (~1 frame + network) |
| Multiple simultaneous receivers | ✅ | ✅ unlimited, one encode feeds all |
| Pause feed without disconnecting | ✅ | ✅ frozen frame + “Paused” banner, audio muted |
| Extend desktop | ✅ (bundled driver) | ✅ via the open-source Virtual Display Driver (guided setup) |
| Quick Connect | ✅ code | ✅ connect by IP/hostname, favourites, recents, tray quick-connect |
| Remote control | iOS app | ✅ web remote for any phone (pause, stop, switch receivers, media transport) |
| Receiver-side playback control | ✅ | ✅ play/pause/seek/volume for files on Cast and AirPlay |
| Global hotkeys | ✅ | ✅ configurable |
| Encrypted connections | ✅ | ✅ HAP ChaCha20-Poly1305 (AirPlay 2), TLS (Cast) |
| Enterprise deployment | ✅ | ✅ silent NSIS install, JSON settings, MIT licence |
| Price | $15.99 | Free, MIT |

## Download

Grab `AirWing-<version>-win-x64.exe` (installer) or the portable `.zip` from the [Releases](https://github.com/lgbtnewsradio-sudo/airwing/releases) page, or build it yourself (below).

Silent install for managed rollouts:

```bash
AirWing-1.0.3-win-x64.exe /S
```

Settings live in `%APPDATA%\AirWing\settings.json`; AirPlay pairing keys in `credentials.json` beside it.

## How it works

```
┌────────────── renderer (Chromium) ──────────────┐   ┌──────────────── main process (Node) ─────────────────┐
│ getDisplayMedia (screen / window / loopback)     │   │ StreamHub  ── fragments ──▶ HLS segmenter ──▶ /hls/*   │
│  └▶ MediaStreamTrackProcessor                    │   │    │                          (Chromecast, AirPlay,   │
│      └▶ wall-clock pacer (crop / scale / pause)  │   │    │                           Roku, Fire TV, HomePod) │
│          └▶ VideoEncoder H.264 (HW) + AAC        │   │    └── WebSocket ──▶ browser receiver (MSE)           │
│              └▶ fMP4 muxer (1 fragment / sample) ├──▶│ SessionManager ── AirPlay 2 client (HAP, ChaCha20)    │
│                                                  │IPC│                └── Google Cast client (castv2)       │
└──────────────────────────────────────────────────┘   │ mDNS discovery · tray · hotkeys · phone remote         │
                                                       └────────────────────────────────────────────────────────┘
```

* **One encode, many receivers.** The renderer encodes once; the main process fans the fragments out to every receiver.
* **Latency tuned per receiver.** Browser receivers get fragments per frame over WebSocket (tens of milliseconds). HLS receivers get 1 s keyframe-aligned segments (Chromecast/Apple TV typically play ~3 s behind).
* **Real AirPlay 2.** `src/main/airplay` implements HAP transient pairing, PIN pair-setup (M1–M6), pair-verify, the encrypted control channel, event channel, timing responder and the SETUP/RECORD/play/rate/scrub/volume commands. Credentials are stored so you only pair once.
* **Google Cast.** Launches (or joins) the Default Media Receiver and loads a live fMP4 HLS stream or a media file with HTTP range support.

## Building from source

Requirements: Windows 10/11, Node.js 20+ (24 recommended).

```bash
git clone https://github.com/lgbtnewsradio-sudo/airwing.git
cd airwing
npm install
npm run dev          # hot-reloading dev build
npm run build        # compile to out/
npm start            # run the compiled app
npm run dist         # build installer + portable zip into release/
```

### Tests

```bash
npm test             # unit + integration tests (mock AirPlay 2 and Cast receivers, fMP4/HLS, crypto, discovery, server)
npm run test:e2e     # launches the real app, captures the screen, verifies encoder, HLS and a browser viewer
AIRWING_LIVE=1 npx vitest run tests/live   # optional: handshake with real AirPlay receivers on your LAN
```

The mock receivers under `tests/mocks` speak the real wire protocols (HAP SRP/Ed25519/X25519/ChaCha20 framing for AirPlay 2, CASTV2 over TLS for Cast) so the clients are exercised end to end without hardware.

## Using AirWing

1. **From**: pick a display, an application window, a screen region, *Audio Only*, or a media file. Capture starts by itself — there is no start button.
2. **To**: click a receiver. AirPlay receivers that need a code show a pairing dialog the first time; enter the 4-digit code from the TV. Click the row again to stop, or use the transport bar at the top to pause or stop everything.
3. **Media** tab: choose a file. *Direct* sends it to the receiver untouched (best quality, receiver-side seeking); *Transcode* re-encodes anything Chromium can decode into a live stream.
4. **Extend Desktop** tab: install the free [Virtual Display Driver](https://github.com/VirtualDrivers/Virtual-Display-Driver), add a virtual monitor, and stream it like any other display.
5. **Browser Receiver** tab: open the URL on any device with a browser to watch with sub-second latency; the phone **remote** URL controls everything from the couch.
6. Hotkeys (default): `Ctrl+Shift+M` start/stop, `Ctrl+Shift+P` pause/resume, `Ctrl+Shift+X` stop everything. The tray icon offers quick-connect to every receiver.

## Known limitations and honest notes

* **Apple TV video does not work and cannot be made to work.** Current tvOS accepts a `/play` request from a third-party sender and then never loads the stream, because it requires Apple's proprietary FairPlay handshake. Verified by asking the Apple TV to play Apple's own reference HLS stream, which it also ignored. Use the browser receiver on a device attached to the TV instead. AirPlay *speakers* (HomePod) are unaffected.
* **Roku / Fire TV mirroring uses HLS**, so those receivers show roughly 2–4 s of delay (fine for presentations and video, not for gaming). Use the browser receiver for near-real-time viewing.
* **HomePod and AirPlay speakers** receive the audio-only HLS stream through the AirPlay 2 video path; RAOP/RTP realtime audio is not implemented yet.
* **Extend Desktop** relies on a third-party virtual display driver because Windows requires a signed IddCx driver to create displays.
* The AirPlay 2 implementation was validated against mock receivers and a HomePod mini/Apple TV on a home network; other brands may need tweaks — please open an issue with the `Logs` tab output.
* Windows Firewall must allow AirWing on private networks so receivers can fetch the stream.
* Electron's Node runtime (BoringSSL) lacks ChaCha20-Poly1305, so AirWing ships its own RFC 8439 implementation for HAP pairing and transport encryption; the crypto tests are also run under Electron's runtime (`ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run`).
* Diagnostics: the Logs tab plus `%APPDATA%AirWinglogsairwing.log`.

## Project layout

```
src/main            Electron main: discovery, AirPlay + Cast clients, HLS server, sessions, tray, hotkeys
src/renderer        React UI and the WebCodecs capture/encode pipeline
src/shared          fMP4 muxer, HLS segmenter, shared types
resources/receiver  browser receiver + phone remote pages served by the app
tests               vitest unit/integration tests, mock receivers, Playwright e2e
```

## Licence

MIT © AirWing contributors. AirParrot is a trademark of Squirrels LLC; AirWing is an independent project and is not affiliated with Squirrels, Apple or Google.
