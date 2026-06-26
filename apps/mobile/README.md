# @peerkit-video-chat/mobile

Expo / React Native client for peerkit-video-chat. Full UI parity with the
Electron desktop app, sharing `@peerkit-video-chat/core` and
`@peerkit-video-chat/media`, driven by
`@peerkit/transport-libp2p-react-native`.

The RN transport is consumed locally via a `file:` dependency on the sibling
`peerkit` repo until it is published.

## Prerequisites

| Requirement             | Notes                                                        |
| ----------------------- | ------------------------------------------------------------ |
| Node                    | `>=22` (repo `engines`)                                      |
| Sibling `peerkit` repo  | Cloned at `../peerkit` (next to this repo) and **built**     |
| A `webrtc-direct` relay | A relay multiaddr ending in `/certhash/<hash>` (UDP, no TLS) |
| Xcode + CocoaPods (iOS) | For `expo run:ios`                                           |
| Android Studio + SDK    | For `expo run:android`                                       |
| Watchman                | Recommended for Metro file watching                          |

This is a **custom dev client** app (it ships native modules:
react-native-webrtc, react-native-quick-crypto, …), so Expo Go will not work —
you must build and install the dev client with `expo run:*`.

## 1. Lay out the repos

The mobile `package.json` references the transport as
`"@peerkit/transport-libp2p-react-native": "file:../../../peerkit/packages/transport-libp2p-react-native"`,
and `metro.config.cjs` watches `../peerkit`. Both repos must sit side by side:

```text
parent/
├── peerkit-video-chat/   ← this repo
└── peerkit/              ← sibling, must be built (dist/ present)
```

Build the sibling transport once (in the `peerkit` repo) so its `dist/` exists:

```bash
cd ../peerkit && npm install && npm run build
```

## 2. Install dependencies

Install from the **repo root** (npm workspaces). Use `--legacy-peer-deps` — the
desktop workspace has a pre-existing `vite` peer-range conflict that blocks a
strict fresh resolve:

```bash
cd peerkit-video-chat
npm install --legacy-peer-deps
```

React Native and React are pinned tree-wide via root `overrides` to the Expo
SDK 54 versions (RN `0.81.5`, React `19.1.0`). See [Why the pins](#why-the-pins).

## 3. Configure the relay and ICE servers

Set `expo.extra.relayMultiaddr` in `app.json` to a `webrtc-direct` relay
multiaddr. The transport dials the relay over UDP and authenticates it with the
`certhash` baked into the multiaddr, so no TLS certificate or domain is needed
(iOS ATS only governs TCP, so it does not apply):

```jsonc
{
  "expo": {
    "extra": {
      // REQUIRED — a webrtc-direct multiaddr ending in /certhash/<hash>.
      "relayMultiaddr": "/ip4/203.0.113.10/udp/9000/webrtc-direct/certhash/<hash>",
      // Optional — STUN/TURN. Defaults to Cloudflare STUN if omitted.
      "iceServerUrls": ["stun:stun.cloudflare.com:3478"]
    }
  }
}
```

With an empty `relayMultiaddr` the app starts but cannot reach peers; the
identity screen surfaces a relay-not-configured error on join.

## 4. Build and run the dev client

Generate the native projects, then build/run on a simulator or device:

```bash
cd apps/mobile
npx expo prebuild            # generates ios/ and android/ (config plugins, pods)
npx expo run:ios             # or: npx expo run:android
```

Subsequent JS-only runs (after the dev client is installed) just need Metro:

```bash
npx expo start --dev-client
```

## Verify without a device

A headless Metro bundle catches dependency, shim, and config errors without a
simulator:

```bash
cd apps/mobile
npx expo export --platform ios --output-dir /tmp/pkvc-export
```

A clean run ends with `Exported: …`. This is the fastest way to confirm the
dependency wiring after touching `metro.config.cjs`, `package.json`, or the
sibling transport.

## Scripts

| Command             | What it does                      |
| ------------------- | --------------------------------- |
| `npm run start`     | `expo start --dev-client` (Metro) |
| `npm run ios`       | `expo run:ios`                    |
| `npm run android`   | `expo run:android`                |
| `npm run prebuild`  | `expo prebuild`                   |
| `npm run typecheck` | `tsc --noEmit`                    |

## How it is wired

- `index.js` — **first line** imports
  `@peerkit/transport-libp2p-react-native/polyfills` (RNG, quick-crypto,
  react-native-webrtc globals, Buffer/process) before anything else.
- `src/media.ts` — calls `registerGlobals()` from react-native-webrtc, then
  builds the shared media controller from `@peerkit-video-chat/media` with
  react-native-permissions wired to `requestMediaAccess`.
- `src/hooks/useChatNode.ts` — owns the `ChatNode` lifecycle and passes a
  `transportFactory` that calls the RN transport's `createNode`.
- `src/config.ts` — reads `relayMultiaddr` / `iceServerUrls` from
  `expo.extra`.

## Why the pins

These settings are load-bearing — changing them tends to break the Metro
bundle. Documented so they are not "cleaned up" by accident.

- **`metro.config.cjs` / `babel.config.cjs` use the `.cjs` extension.** This
  package is `"type": "module"`, so a `.js` config is treated as ESM and Metro
  (which `require`s its config) fails to load it.
- **`babel-preset-expo`, not `@react-native/babel-preset`.** The Expo preset is
  version-matched to the SDK's React Native; the raw RN preset can mismatch and
  break codegen on RN core components.
- **Root `overrides` pin `react-native` + `react`.** The sibling transport and
  the native modules accept newer RN via broad peer ranges, so npm would
  otherwise hoist a React Native newer than Expo 54 supports.
- **`metro.config.cjs` `resolveRequest` dedupe.** Forces React, React Native,
  `@react-native/*`, and the native modules to resolve from this app's
  `node_modules`, so the watched sibling repo cannot introduce a second copy
  (two native libwebrtc stacks contend for the camera/audio session).
- **`shims/os.js` + `node:` handling.** libp2p's `@libp2p/utils` imports
  `node:os`; a dial-only RN client never needs it, so it is stubbed.

## Troubleshooting

| Symptom                                                | Fix                                                                                                                     |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `require is not defined in ES module scope` (Metro)    | A config file is `.js` — it must be `.cjs` (see [Why the pins](#why-the-pins)).                                         |
| `Unable to determine event arguments` / codegen errors | React Native resolved to a non-Expo version — run `npm install --legacy-peer-deps` so the root `overrides` take effect. |
| `Unable to resolve module node:<x>`                    | Add the builtin to `extraNodeModules` in `metro.config.cjs` (and a shim if RN has no equivalent).                       |
| Two `libp2p` / `react-native-webrtc` copies at runtime | Add the offending package(s) to the `resolveRequest` dedupe set in `metro.config.cjs`.                                  |
| Join fails with a relay-not-configured message         | Set `expo.extra.relayMultiaddr` to a `webrtc-direct` multiaddr.                                                         |

## Known limitations

- **Foreground only.** The libp2p transport does not run while backgrounded
  (iOS/Android suspend the JS runtime); calls do not survive backgrounding.
- **No relay-disconnect signal.** PeerKit emits no relay-disconnected event, so
  the relay status indicator only ever transitions to connected.
- **Speaker selection and identity-copy** are not yet implemented; device
  pickers list camera/microphone only.
