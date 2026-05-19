# Architecture

This document describes the architecture of `peerkit-video-chat`, a showcase application built on [PeerKit](https://github.com/holochain/peerkit). It is intended for engineers contributing to the application and for the PeerKit team as feedback on how an early consumer integrates with their framework.

## Goals

- Showcase what an end-to-end application built on PeerKit looks like, including identity, access control, signaling and text messaging.
- Provide a user experience comparable to consumer video chat tools for small group calls: live audio and video, in-call text chat, no perceptible latency on a broadband internet connection.
- Run on Linux, macOS, Windows, Android and iOS with as much shared code as is practical.
- Default to publicly provided services for the parts of the stack that need external infrastructure (e.g. STUN/TURN), so the application is easy to get running. Allow organizations with the necessary technical skills to self-host a complete deployment for full independence.
- Preserve PeerKit's peer-to-peer story: media is exchanged peer-to-peer wherever the network permits.

## Non-goals

- Federation between deployments. Each deployment is a closed network. The door is left open for external participants to be admitted into a deployment through temporary credentials in the future, but that is not part of the initial scope.
- Persistent chat history, message search and file transfer. The application is small and focused.
- Identity portability across devices. PeerKit identities are per-device for now; a user who appears as multiple participants on multiple devices can disambiguate by setting their display name (for example, "My Name" and "My Name (phone)").
- Calls beyond what a peer-to-peer mesh can comfortably sustain in the default mode. An optional Selective Forwarding Unit (SFU) is described as a future direction below.

## High-level approach

The application is split along a clean boundary. PeerKit handles peer discovery, network access control and reliable application messaging between peers. WebRTC handles all media: capture, encoding, transport, decoding, playback, jitter buffering, packet loss concealment, echo cancellation and adaptive bitrate. The application owns room and call lifecycle, the signaling protocol that exchanges SDP offers/answers and ICE candidates over PeerKit messages, ephemeral text chat over PeerKit messages, and the user interface.

Building media transport directly on top of PeerKit streams was considered and rejected. WebRTC is already purpose-built for real-time media and gives all of the above for free. PeerKit does not expose WebRTC in a form the application could use directly, so layering WebRTC on top for media while keeping PeerKit for everything else lets both pieces do what they are designed for.

## Components

### `packages/core`

The platform-agnostic core of the application. Pure TypeScript with zero platform dependencies, importable from both the Electron renderer and the React Native runtime.

Responsibilities:

- Room and call state machines: joining, leaving, participant roster, who-is-speaking.
- Signaling protocol over PeerKit application messages, carrying SDP offers/answers, ICE candidates, call invitations and hang-up signals.
- Ephemeral chat state for the current room. Participants only see messages broadcast while they are present; no catch-up, no persistence.
- PeerKit lifecycle wiring: initialization, network access handshake, agent discovery, application message routing.

### `packages/media`

A thin adapter exposing a single TypeScript surface backed by the platform's WebRTC implementation: Chromium's built-in WebRTC on Electron, and `react-native-webrtc` on React Native. Owns `RTCPeerConnection` setup, simulcast configuration and bandwidth-adaptive bitrate. Code that touches `RTCPeerConnection` directly lives here and nowhere else, so the same call logic in `packages/core` runs on both platforms.

### `apps/desktop`

Electron application. Uses the `@peerkit/transport-libp2p-nodejs` PeerKit transport. A desktop instance is a full PeerKit peer and can establish direct libp2p connections to other peers when the network permits.

### `apps/mobile`

React Native application. Uses the planned `@peerkit/transport-libp2p-react-native` PeerKit transport. Mobile peers reach other peers through a circuit-relay and upgrade to direct connections where NAT allows.

## Networking model

### Deployment, organization, network access

A deployment corresponds to one organization. Each member of the organization is issued their own access credentials for the deployment. Holding valid credentials grants access to the PeerKit network and to any room within the deployment. Rooms are an application-level concept on top of a single PeerKit network; there are no per-room access restrictions.

### Rooms

A room is a named, ephemeral grouping of agents participating in a call together. The room identifier is included in every signaling and chat message so participants can filter by room.

- A room is created the first time an agent attempts to join it. There is no separate "create" API.
- An agent joins by broadcasting a join announcement over PeerKit. Existing participants reply with their roster.
- The agent establishes pairwise `RTCPeerConnection`s with each existing participant. Signaling for each pair flows over PeerKit application messages, agent-to-agent.
- The agent leaves by broadcasting a leave announcement.
- When the last participant leaves, the room and its in-memory chat state cease to exist anywhere.

### Identity

PeerKit identities, one per device. Currently agent IDs are not persisted — a new ID is assigned each time the application is opened. The preferred future state is persistent agent IDs.

### Signaling

WebRTC requires SDP offer/answer exchange and ICE candidate trickling. Both flow over PeerKit application messages. Because PeerKit messages are authenticated end-to-end, signaling is implicitly authenticated without additional cryptography.

Separating signaling messages from application messages (chat, join/leave announcements) using a custom PeerKit stream is worth considering during implementation.

### NAT traversal

PeerKit's libp2p stack handles NAT traversal for its own peer-to-peer messaging, transparent to the application.

WebRTC media connections use standard ICE. By default the application is configured against publicly provided STUN/TURN services so it works out of the box. Deployments that want full independence can self-host the relevant infrastructure; `coturn` is a reasonable choice when that step is taken.

## Media topology

### Default: mesh

By default, every participant in a room establishes a direct `RTCPeerConnection` with every other participant. Each peer encodes once and uploads `N-1` copies of its outgoing audio and video; each peer receives and decodes `N-1` incoming streams. This preserves the peer-to-peer story end-to-end and is the right default for typical small-group calls.

The practical limit of mesh is bounded by upload bandwidth and decode CPU. With simulcast and bandwidth-adaptive bitrate, the comfortable ceiling is approximately 8 participants per room. The application surfaces an in-app warning as room population approaches that ceiling and recommends staying within it.

### Scaling beyond mesh (future)

For deployments that need calls larger than mesh can sustain, the architecture leaves room for an optional Selective Forwarding Unit. This is a future direction and not in initial scope. The intended approach is for the SFU to join the deployment's PeerKit network as a regular agent, so it sits inside the same access boundary as the participants.

### Two WebRTC stacks on mobile

The mobile application has two WebRTC consumers: the application's own media `RTCPeerConnection`s, and PeerKit's React Native transport. This is not a problem provided both share a single underlying native libwebrtc binary, which is the case when PeerKit's React Native transport is built on top of `react-native-webrtc` (consuming the W3C API surface that `react-native-webrtc` polyfills onto `globalThis`).

The risk is if PeerKit's React Native transport bundles its own native libwebrtc binary independently. That would link two copies of libwebrtc into the binary and create the potential for audio session and camera ownership contention on iOS.

## Code reuse strategy

The intended reuse boundary is:

| Layer | Shared between desktop and mobile? |
|---|---|
| `packages/core` (state machines, signaling, chat, PeerKit wiring) | Fully shared |
| `packages/media` (shared JS surface; platform-specific implementations selected at build time via package `exports` conditions) | Fully shared |
| Presentation layer | Per-platform |
