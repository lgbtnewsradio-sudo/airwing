## AirWing 1.0.5

A testing pass over the whole app: a behavioural sweep of the real UI plus a line-by-line
review of the renderer and main process. Nineteen bugs found and fixed, two of which could
take the entire application down.

### Crashes that killed the app

- **The phone remote dropping off Wi-Fi exited AirWing completely.** The remote-control
  socket had no error listener, and an unhandled socket error is fatal in Node. Capture,
  every cast session and the tray icon all vanished with no dialog.
- **Unplugging a drive (or moving a file) while casting it exited AirWing.** Media files
  were streamed with a bare `pipe()`, leaving the read stream's error unhandled. The file
  handle also leaked whenever a receiver aborted a request.
- The HTTP server had no error handler once listening, and nothing caught a failure during
  start-up. There is now also a last-resort handler so no stray error can kill a tray app
  that people leave running for days; anything that reaches it is written to the log.

### Wrong pictures on the TV

- **Restarting capture reset the HLS media sequence to zero.** A receiver still watching
  saw segment 0 again with entirely different content, so it reused what it already had and
  sat on a frozen frame.
- **A changed encoder configuration was published under the unchanged `init.mp4` URI**, so
  receivers decoded new video against the old configuration — green blocks or a stall.
  Init segments are now versioned and a discontinuity is signalled properly.

### Dead ends in the new window

- **Pressing Stop and then clicking the same source did nothing at all.** Capture only
  followed a *change* of source, so the only way back was to pick a different one.
- **Pressing Stop and then picking a receiver waited about 17 seconds and then failed**
  with "the capture did not start". Picking a destination now starts capture.
- **Clicking a display under Extend Desktop appeared to do nothing** until you happened to
  press Back.
- **A Chromecast added by typing a bare IP address could never connect** — it was always
  added as AirPlay on port 7000. AirWing now asks the address which protocol it speaks.
  IPv6 literals were also mangled, and a failed add reported nothing.
- **The close button could never actually close the app**, because capture now starts on
  its own and the window treated that as "still streaming".
- The pairing dialog either kept a stale error or lost the "that code was not accepted"
  message, depending on how you got there.

### Stability and resources

- A start/stop race could let an in-flight teardown dismantle a capture that had just
  started, so capture appeared to start and immediately died.
- One pause left every later frame being redrawn through a canvas for the rest of the
  session, costing CPU that was never given back.
- When a receiver's app closed (someone casts something else from their phone), the session
  stayed listed as streaming for ever and a status poll kept ticking against it.
- Failed connections counted as active receivers, inflating the tray label and making
  capture restart on behalf of a receiver that never connected.
- The automatic restart after Windows ends a capture never fired for anyone streaming only
  to a TV, because it counted watchers after they had already been torn down.
- A receiver added by hand could be quietly dropped once it was also discovered normally,
  and mDNS host records accumulated for the lifetime of the app.
- The Extend Desktop panel spawned a PowerShell probe every 5 seconds while open.

### Testing

Unit and integration tests are up from 40 to 48, end-to-end from 4 to 6, including
regressions for both dead ends, HLS restart continuity, versioned init segments, and both
crash paths exercised in-process so a regression fails the run rather than passing quietly.

**Downloads**
- `AirWing-1.0.5-win-x64.exe` — installer (supports silent `/S` install)
- `AirWing-1.0.5-win-x64.zip` — portable
