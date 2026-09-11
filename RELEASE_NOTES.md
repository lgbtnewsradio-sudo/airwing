## AirWing 1.0.2

**Simpler window.** AirWing is now a single compact window laid out the way AirParrot is: **What to stream** on top, **Where to stream** directly underneath. Picking a receiver starts everything, so there is no separate "start mirroring first" step. Quality settings are collapsed into a one-line summary you can expand when you need them, and pause/stop moved into the section header.

**Fixed**
- **"Connection closed by receiver" on Apple TV.** AirWing was sending the RTSP `RECORD` command, which belongs to the realtime audio path, before playing a video URL. Apple TV drops the connection when it receives it. Video URL playback now uses the plain `/play` flow.
- **HLS receivers are now given a multivariant (master) playlist** naming the variant's codecs, resolution and frame rate, which is what AirPlay and Cast receivers expect at the play URL.
- Event-channel messages from the receiver are now framed and answered individually (a receiver can batch several into one packet), with the `Audio-Latency` header real receivers expect.

**Known limitation: Apple TV video**
Current tvOS accepts a `/play` request from a third-party sender and then never loads the stream — it requires Apple's proprietary FairPlay handshake. This was confirmed by asking the Apple TV to play **Apple's own reference HLS stream**, which it also ignored, so it is not a problem with AirWing's output. AirWing now detects this and says so plainly instead of showing a confusing error. To put this PC's screen on an Apple TV, use the **Browser** tab and open the receiver URL in a browser on a device attached to the TV. HomePod and other AirPlay speakers, Chromecast, and browser receivers are unaffected.

**Downloads**
- `AirWing-1.0.2-win-x64.exe` — installer (supports silent `/S` install)
- `AirWing-1.0.2-win-x64.zip` — portable
