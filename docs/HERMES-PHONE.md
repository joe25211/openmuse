# OpenMuse on Android with Hermes on GPC

## Deployment

OpenMuse is a **dedicated Android app**, not a Hermes Relay tab or plugin. The phone talks to the OpenMuse API over Tailscale HTTPS; the API talks to a loopback-only AG-UI bridge; the bridge talks to Hermes's authenticated API server. Hermes owns reasoning, tools, memory, and worker dispatch. No Hermes or bridge credential is bundled in the APK.

This first slice supports streamed chat, saved conversations, rename/archive/restore, history, and generic Hermes tool cards. CopilotKit Intelligence is optional and is not configured for this deployment. Upstream built-in models and cloud features remain available in source but are not used here.

### GPC services

- `openmuse-api.service` — loopback API `127.0.0.1:8788`
- `openmuse-bridge.service` — loopback bridge `127.0.0.1:8791`
- Hermes API server — authenticated loopback `127.0.0.1:8642`
- Tailnet-only HTTPS — `https://gpc.tailb0557b.ts.net:8788`
- Private deployment environment — `~/.config/openmuse/phone.env` (0600)

Start/status/stop only the OpenMuse stack:

```sh
systemctl --user start openmuse-bridge.service openmuse-api.service
systemctl --user status openmuse-bridge.service openmuse-api.service
systemctl --user stop openmuse-api.service openmuse-bridge.service
```

This does not require restarting Hermes. The services use built files under `dist/`, not development watchers.

### Build the standalone APK

Use installed JDK 17 and Android SDK, not the system default JDK. From the repository root:

```sh
pnpm typecheck
pnpm test
pnpm build:server
cd apps/mobile
JAVA_HOME="$HOME/.gradle/jdks/eclipse_adoptium-17-amd64-linux.2" \
ANDROID_HOME="$HOME/Android/Sdk" \
./node_modules/.bin/expo prebuild --platform android --no-install
cd android
env -u CC -u CXX -u AR -u LDFLAGS -u LD_LIBRARY_PATH \
  JAVA_HOME="$HOME/.gradle/jdks/eclipse_adoptium-17-amd64-linux.2" \
  ANDROID_HOME="$HOME/Android/Sdk" \
  ANDROID_SDK_ROOT="$HOME/Android/Sdk" \
  NODE_ENV=production \
  EXPO_PUBLIC_API_URL=https://gpc.tailb0557b.ts.net:8788 \
  PATH="$HOME/.gradle/jdks/eclipse_adoptium-17-amd64-linux.2/bin:$PATH" \
  ./gradlew :app:assembleRelease --no-daemon -PreactNativeArchitectures=arm64-v8a --max-workers=3
```

Output: `apps/mobile/android/app/build/outputs/apk/release/app-release.apk`. It contains the JavaScript bundle and does not need Expo Go or Metro. The local release build uses the project's debug signing configuration; it is for private testing, not Play Store distribution. Package: `app.openmuse.mobile`.

Install only after `adb devices -l` shows the intended phone as `device`, not `unauthorized`:

```sh
adb -s PHONE_SERIAL install -r apps/mobile/android/app/build/outputs/apk/release/app-release.apk
```

The phone needs Tailscale connectivity to GPC and the OpenMuse access key at first sign-in. Do not put this access key, the bridge token, or the Hermes API key into source or the APK. On Android, only the returned session token is retained in Expo SecureStore (Android Keystore-backed storage), scoped to this backend URL and excluded from Android backup. The access key itself is not stored. Expired or revoked sessions require sign-in again; network errors do not delete the saved token.

### Update and rollback

Before rebuilding/redeploying, keep the previous `dist/` and APK. Build, run tests, then restart **only** these OpenMuse services:

```sh
systemctl --user restart openmuse-bridge.service openmuse-api.service
curl --fail http://127.0.0.1:8791/health
curl --fail https://gpc.tailb0557b.ts.net:8788/api/health
```

Rollback: restore the previous `dist/`, restart those two services, and reinstall the previous signed APK if the phone build changed. Keep `DATA_DIR`, `BRIDGE_DATA_DIR`, and the private environment unchanged. Stopping these services disables OpenMuse without changing Hermes.

## Ownership and truthful results

- Canonical `om_…` IDs are handles, **not** proof of ownership. The bridge's private `conversations.json` registry must contain an ID before it can be read, changed, or run. Creation conflicts do not enroll existing Hermes sessions. Do not delete or reconstruct this registry from a list of upstream sessions.
- Only one bridge process may own a registry directory. Concurrent operations inside that process share a serialized registry writer.
- History is read from Hermes in chronological pages, including compacted source history. It is not replayed into CopilotKit's in-memory runner or overwritten from the phone.
- Tool events preserve actual names and arguments. The session-stream protocol currently omits tool-call IDs and full output. Overlapping same-name calls are marked unattributed; the bridge does not guess which invocation produced a result.
- A broken stream or failed turn is an error, never a successful empty answer.

## Not yet verified or implemented

- USB installation and signed-in chat were verified on a Pixel 7 (Android 17): a message sent from the phone produced a real Hermes terminal-tool card and the requested reply. The final update removes misleading built-in-worker warnings and adds secure session persistence. Its force-stop/reopen acceptance check is still pending the user's sign-in on that updated build.
- Approvals, durable run reconnection, native worker-status cards, and push notifications are follow-up work. Existing Relay notifications do not implement these for OpenMuse.
- The current chat-stream path does not guarantee work survival after a disconnect. Do not advertise durable background worker monitoring or phone approvals until the durable-run integration is built and tested.
- This is a single-owner deployment. Tailnet access and the OpenMuse access key protect the API; it is not a public multi-user service.
