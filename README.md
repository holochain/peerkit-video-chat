# peerkit-video-chat

A video chat application built to showcase [PeerKit](https://github.com/holochain/peerkit), a peer-to-peer data synchronization framework written in TypeScript.

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
│   └── relay/           Local PeerKit relay used as rendezvous in development
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

# Terminal 1 — start the local relay. It prints its dialable address
# (and a ready-to-paste PEERKIT_RELAY_ADDR=... npm run dev:desktop line).
npm run dev:relay

# Terminal 2 — start a desktop window, pointing it at the address the relay
# printed. Run this twice (in two separate terminals) for the two-peer flow.
PEERKIT_RELAY_ADDR=<address-from-terminal-1> npm run dev:desktop
```

The desktop app takes its bootstrap relay from the `PEERKIT_RELAY_ADDR`
environment variable. Point it at any reachable relay multiaddr to use a
relay other than the local dev one.

In each desktop window: set a display name, type the same room name in both, and start chatting. Roster updates as peers join and leave.

## See also

- [PeerKit](https://github.com/holochain/peerkit) — the underlying P2P framework
- [`docs/architecture.md`](docs/architecture.md) — full architecture document
