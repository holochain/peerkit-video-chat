# peerkit-video-chat

A video chat application built to showcase [PeerKit](https://github.com/holochain/peerkit), a peer-to-peer data synchronization framework written in TypeScript.

**Website & downloads:** https://holochain.github.io/peerkit-video-chat/

## What it is

`peerkit-video-chat` is a small, focused showcase: organizations or teams deploy an instance, each member is issued their own access credentials for the deployment, and members can create or join call rooms inside that organization. Each room supports:

- Live audio and video between participants
- Text chat with no catch-up. A participant only sees messages broadcast while they are in the room; there is no history and no replay for late joiners.
- Up to a small number of simultaneous participants per room in the default peer-to-peer mode, with a planned path to larger rooms via an optional Selective Forwarding Unit (SFU)

The goal of the project is to demonstrate what an end-to-end application built on PeerKit looks like, and to surface the practical decisions an app developer faces when they adopt PeerKit: identity, access control and signaling. Layering media transport on top of a PeerKit-managed connection is a concern specific to this application rather than a general PeerKit adoption concern.

## Why this exists

This project exists to showcase PeerKit and to help the PeerKit developers dogfood their own framework.

## How it is structured

The codebase is laid out as a TypeScript monorepo. The bulk of the application — call lifecycle, room state, signaling protocol, chat — lives in a single platform-agnostic core package consumed by both the desktop and mobile applications.

```text
peerkit-video-chat/
├── apps/
│   ├── desktop/         Electron application
│   ├── mobile/          React Native application
│   └── relay/           PeerKit relay — rendezvous point for peer discovery
├── packages/
│   ├── core/            Business logic. Room and call state machines,
│   │                    signaling protocol over PeerKit messages,
│   │                    ephemeral text chat. Zero platform dependencies.
│   └── media/           Thin WebRTC adapter. Same JS surface, backed
│                        by Chromium WebRTC on desktop and
│                        react-native-webrtc on mobile.
└── docs/                Architecture and design notes.
```

`apps/desktop` and `apps/mobile` are a thin presentation layer: capture and render UI, plumb permissions, wire up the platform-specific PeerKit transport. The rest of the application lives in `packages/core`.

## Running locally

The desktop app discovers other peers through a PeerKit relay. During development we run a local relay alongside the app.

```sh
npm install
npm run build

# Terminal 1 — start the local relay. Its `relay ready` log line carries the
# dialable multiaddr (the `multiaddrs` field) to paste below.
npm run dev:relay

# Terminal 2 — start a desktop window, pointing it at the address the relay
# printed. Run this twice (in two separate terminals) for the two-peer flow.
PEERKIT_RELAY_ADDR=<address-from-terminal-1> npm run dev:desktop
```

The desktop app takes its bootstrap relay from the `PEERKIT_RELAY_ADDR`
environment variable. Point it at any reachable relay multiaddr to use a
relay other than the local dev one.

In each desktop window: set a display name, type the same room name in both, and start chatting. Roster updates as peers join and leave.

### TURN (optional for local builds)

You do **not** need TURN to run or test the app locally — calls run STUN-only,
which is fine for development and for peers that can reach each other directly.

To also exercise the TURN relay path locally (e.g. peers that can't connect
directly), export the same values the release uses before building, then the
credentials get baked into the renderer:

```sh
export TURN_REALM=<turn-server-fqdn>
export TURN_PASSWORD=<turn-password>
npm run build -w @peerkit-video-chat/desktop
```

Without them the client logs `TURN not configured` and stays STUN-only. The
packaged release bakes these from the `TURN_REALM` variable and `TURN_PASSWORD`
secret (see `infra/README.md`).

## Packaging

`electron-builder` produces installers for all three desktop platforms:

```sh
npm run build -w @peerkit-video-chat/desktop
npm run package:linux -w @peerkit-video-chat/desktop   # AppImage + deb
npm run package:mac   -w @peerkit-video-chat/desktop   # pkg
npm run package:win   -w @peerkit-video-chat/desktop   # msi
```

Each builds for the host OS; output lands in `apps/desktop/release/`. Builds are
unsigned for now. CI (`.github/workflows/release.yml`) runs the three-OS matrix
on version tags (`v*`) and attaches the installers to the GitHub Release.

Packaged builds ship with a default bootstrap relay so they work out of the box;
set `PEERKIT_RELAY_ADDR` to override it (e.g. to point at a local dev relay).

## Deploying the relay

For shared testing, deploy the relay to a server with a public IP and direct TCP access (a VPS — not a PaaS HTTP proxy).

**Build**

```sh
npm ci
npm run build -w @peerkit-video-chat/relay
```

**Run with pm2**

```sh
npm install -g pm2
cd apps/relay
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup   # follow the printed instruction to survive reboots
```

The relay binds to `0.0.0.0:9000` by default in production. Override with env vars:

| Variable | Default | Description |
|---|---|---|
| `RELAY_HOST` | `127.0.0.1` | Bind address (`0.0.0.0` to accept external connections) |
| `RELAY_PORT` | `9000` | TCP port |
| `RELAY_LOG_LEVEL` | `info` | Log verbosity (`debug`, `info`, `warning`, `error`) |
| `RELAY_PUBLIC_HOST` | — | Public DNS name to announce as a `/dns4/<host>` multiaddr |
| `RELAY_OTLP_ENDPOINT` | — | OTLP endpoint; metrics export is off unless set |

On start the relay emits structured JSON logs. The `relay ready` line carries
the dialable multiaddr(s):

```
{"level":"INFO","message":"relay ready","properties":{"nodeId":"<peer-id>","multiaddrs":["/ip4/0.0.0.0/tcp/9000/ws/p2p/<peer-id>"]}}
```

Point clients at it via `PEERKIT_RELAY_ADDR=<multiaddr> npm run dev:desktop`.
Replace `0.0.0.0` with the server's public IP (or set `RELAY_PUBLIC_HOST`) when
sharing the address with clients. The peer ID is informational; clients only
need the transport portion (`/ip4/<host>/tcp/<port>/ws`).

## See also

- [PeerKit](https://github.com/holochain/peerkit) — the underlying P2P framework
- [`docs/architecture.md`](docs/architecture.md) — full architecture document
