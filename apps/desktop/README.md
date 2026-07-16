# PeerKit Video Chat Desktop

The desktop app accepts PeerKit network controls at startup. These controls do
not change the mobile app.

## Startup switches

`--listen-address <multiaddr>` sets an explicit PeerKit listen and advertised
address. The equal form, `--listen-address=<multiaddr>`, is also accepted. The
switch is repeatable, and addresses are forwarded in the order provided.

`--relay-only` restricts PeerKit to circuit-relayed connectivity. The node
listens and advertises only `/p2p-circuit`, and it dials peers only through
circuit addresses that do not contain plain WebRTC. WebRTC Direct may still
be used to reach the relay; the peer-to-peer hop remains circuit-relayed.

The switches cannot be combined. A missing or empty listen address, or using
`--relay-only` with any `--listen-address`, stops startup with an error. Other
Electron and Chromium arguments are ignored by this parser.

## Development examples

Run the desktop app in strict PeerKit relay-only mode:

```sh
npm run dev -w @peerkit-video-chat/desktop -- -- --relay-only
```

Run it with multiple explicit listen addresses:

```sh
npm run dev -w @peerkit-video-chat/desktop -- -- \
  --listen-address /ip4/127.0.0.1/tcp/4001 \
  --listen-address=/ip6/::1/tcp/4002
```

Packaged binaries accept the switches directly:

```sh
peerkit-video-chat --relay-only
```

## PeerKit relay and TURN

PeerKit circuit relay and WebRTC TURN relay are separate network layers.
PeerKit transports room messages and WebRTC signaling between peers. WebRTC
then selects its own media path using host, STUN-derived, or TURN candidates.

Therefore, `--relay-only` guarantees relayed PeerKit peer links but does not
force media through TURN and does not change WebRTC `iceTransportPolicy`. A
call whose signaling crosses a PeerKit circuit relay may still use a direct or
STUN-derived media path. TURN-only media is used only by the existing WebRTC
recovery ladder when TURN is configured and direct media recovery fails.
