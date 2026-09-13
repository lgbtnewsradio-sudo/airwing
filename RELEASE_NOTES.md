## AirWing 1.0.6

**Apple TV now tells you the truth in a tenth of a second, instead of spinning for twelve.**

I researched how AirParrot mirrors to an Apple TV without the lag, and the answer is that it
uses a different protocol entirely. AirParrot uses the real-time AirPlay **screen-mirroring**
transport: H.264 frames pushed over a TCP channel with a 128-byte header. AirWing uses the
`/play` path, which hands the receiver a URL and asks it to fetch an HLS stream. That
difference is exactly where the lag comes from, because HLS buffers whole segments.

Switching to the mirroring transport would remove the lag, and it is technically proven to
work against current Apple TVs. It is gated behind one thing: **Apple's FairPlay
authentication**. Measured against the Apple TV on this network, it answers `/fp-setup`
with a 142-byte FairPlay message, so it expects a sender that passes that handshake. The
known workaround of omitting the AES key only works on non-Apple receivers, which decline
FairPlay outright. AirParrot can do this because Squirrels is an Apple licensee.

AirWing does not implement FairPlay, so rather than let it fail slowly, it now says so:

- tvOS Apple TVs are labelled in the receiver list before you click them.
- Clicking one explains the limitation in about 0.1 seconds, instead of putting a loading
  spinner on your TV for roughly 12 seconds and then failing.

Deliberately unaffected, because they all work: Apple TV 3 (which does play third-party
video over AirPlay 1), HomePod and other AirPlay speakers, Roku, Fire TV, Chromecast, and
the browser receiver.

For reference, where the latency stands on the paths that do work: the browser receiver runs
about 0.3 seconds behind live, and Chromecast about 8 seconds, which is the Chromecast's own
HLS buffering rather than anything AirWing adds.

**Downloads**
- `AirWing-1.0.6-win-x64.exe` — installer (supports silent `/S` install)
- `AirWing-1.0.6-win-x64.zip` — portable
