## AirWing 1.0.1

Bug-fix release for AirPlay 2 pairing.

**Fixed**
- **Pairing with Apple TV, Roku, Fire TV and other code-protected AirPlay 2 receivers failed after entering the code** ("Unknown cipher"). Electron's Node runtime is built on BoringSSL, which does not expose ChaCha20-Poly1305 through the crypto API, so the encrypted M5/M6 pairing steps (and the encrypted control channel) could not run inside the packaged app even though they passed in the Node-based test suite. AirWing now ships its own RFC 8439 ChaCha20-Poly1305 implementation, verified against the RFC test vectors and Node's native cipher, and the pairing/transport tests are run under Electron's runtime in CI.
- **"pairing was not started" when pressing Pair a second time.** A rejected or expired code invalidates the receiver's pairing session; the dialog now automatically requests a fresh code from the receiver, clears the field and explains what happened. The backend also re-arms pairing if a stale submit arrives.

**Added**
- Full log file at `%APPDATA%\AirWing\logs\airwing.log` (rotated at 5 MB) with protocol traces, for bug reports.
- End-to-end UI test that pairs against a mock AirPlay 2 receiver inside the real Electron app, including the wrong-code path.

**Downloads**
- `AirWing-1.0.1-win-x64.exe` — installer (supports silent `/S` install)
- `AirWing-1.0.1-win-x64.zip` — portable
