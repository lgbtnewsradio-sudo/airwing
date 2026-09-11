## AirWing 1.0.4

**Fixed: the Chromecast froze with a bar across the bottom of the TV.** Instrumenting the Cast session showed the receiver oscillating `PLAYING → BUFFERING` every few seconds, forever — it never built a buffer, so the picture froze between refills and the TV showed its buffering bar. No segment ever 404'd; the stream was simply served with the receiver pinned to the live edge, which leaves it no headroom.

The HLS playlist now tells receivers where to start (`EXT-X-START`) and keeps a small, bounded window. Measured on a Sony Bravia: **98 seconds of continuous playback with no rebuffering**, where before it rebuffered every few seconds indefinitely.

These numbers came from measuring, not guessing:

| Playlist window | Start cushion | Lag behind live | Rebuffers |
| --- | --- | --- | --- |
| 8 segments | 1 s | ~8 s | none after startup |
| 4 segments | 1 s | ~6 s | 22 |
| 30 segments | none | ~12 s | drifts |

**Fixed: audio feedback loop from the computer's speakers.** With the browser receiver open on the same PC that is capturing, its audio played out of the speakers and straight back into the system-audio loopback, which then re-sent it. The receiver page now detects that it is running on the capturing machine and starts muted, with a one-click "Unmute anyway". Opening it on any other device is unaffected.

**Known limitation: Chromecast delay.** Casting runs over HLS, and the Chromecast's own buffering puts it roughly 8 seconds behind live. Tightening it further brings the freezing back, so this is the floor for this transport. Google's own screen mirroring uses a proprietary low-latency protocol that is not available to third-party senders. For near-real-time viewing use the **Browser** receiver, which runs about a third of a second behind. Receiver rows now say "a few seconds behind" so the delay is not a surprise.

**Also**
- Every receiver request is logged with its status, so a stalling receiver can be diagnosed from `%APPDATA%\AirWing\logs\airwing.log`.
- Cast player state changes (playing, buffering, idle and why) are recorded in the log.

**Downloads**
- `AirWing-1.0.4-win-x64.exe` — installer (supports silent `/S` install)
- `AirWing-1.0.4-win-x64.zip` — portable
