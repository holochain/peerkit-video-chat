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
│   └── mobile/          React Native application
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

## See also

- [PeerKit](https://github.com/holochain/peerkit) — the underlying P2P framework
- [`docs/architecture.md`](docs/architecture.md) — full architecture document
