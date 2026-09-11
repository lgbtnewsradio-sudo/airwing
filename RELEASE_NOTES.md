## AirWing 1.0.3

**Fixed: streaming froze.** The encoder wrote a fixed 33 ms duration on every frame while timestamps came from a real-time clock, so each frame the encoder dropped under load left a hole in the video timeline — and a player stalls forever at a hole. Durations are now derived from the next frame's decode time, making the timeline exactly contiguous. Verified on a live stream (zero discontinuities across every segment) and by soak-testing a receiver under eight CPU-saturating processes: 144 seconds, zero stalls, where it previously froze permanently after about 37.

Also fixed alongside it:
- Picking a receiver in the first second of capture failed with "no active stream"; connecting now waits for the encoder to produce its first frame.
- A capture that Windows ends on its own (display change, session switch, a source that disappears) used to stop silently and look like a frozen picture. It is now logged with a reason and restarted automatically while anyone is still watching.
- Receivers get a safety net that seeks across a gap rather than stalling, in case one ever appears.

**New window.** Rebuilt to match AirParrot's compact single-window layout: a status line showing what is being streamed, a small transport bar, then **From** and **To** lists of plain rows. Selecting a source starts capture on its own and clicking a destination streams to it, so there is no start, cast, pause or stop step to hit first. Quick-connect by IP address sits at the top of the **To** list, and settings, diagnostics and the browser receiver moved to the footer.

**Downloads**
- `AirWing-1.0.3-win-x64.exe` — installer (supports silent `/S` install)
- `AirWing-1.0.3-win-x64.zip` — portable
