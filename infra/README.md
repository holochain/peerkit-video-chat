# infra

One-shot droplet provisioning. `cloud-init.yaml` sets machine state once at
first boot. No day-2 config management: to change config, **redeploy** from an
edited copy. The deploy is driven by the manually-triggered
`.github/workflows/deploy.yml`.

Runs two systemd services on one DigitalOcean droplet:

| Service | Unit | Port(s) |
| --- | --- | --- |
| PeerKit relay | `peerkit-relay` | 9000/tcp |
| coturn TURN/STUN | `coturn` | 3478, 5349, 443, 49152–65535/udp (80/tcp for ACME) |

## Deploy

Run the **Deploy relay + TURN** workflow (Actions → Run workflow). Inputs:
`repo_ref` (relay version to build), droplet name/region/size. It renders
`cloud-init.yaml`, creates a fresh droplet, and reassigns the demo Reserved IP
to it. Each run = a new droplet (immutable); the old one is left running so a
bad deploy is rolled back by reassigning the Reserved IP. Delete the old droplet
manually after verifying.

### Required GitHub secrets

| Secret | Purpose |
| --- | --- |
| `DIGITALOCEAN_ACCESS_TOKEN` | doctl auth |
| `TURN_PASSWORD` | static long-term TURN credential (also used by release.yml) |
| `CERTBOT_EMAIL` | Let's Encrypt (ACME account) contact email |
| `DO_SSH_KEY_FINGERPRINTS` | comma-separated SSH key fingerprints added to the droplet (one per operator) |
| `DO_RESERVED_IP` | Reserved IP the demo FQDN resolves to |

The realm/FQDN (`peerkit-video-chat-demo.holochain.org`) is set as `env.REALM`
in the workflow, not a secret.

## Reserved IP + DNS (required for TLS)

The cert domain must resolve to the droplet **before** boot-time issuance.
Create a DO **Reserved IP**, point the A record
`peerkit-video-chat-demo.holochain.org` at it once, and let each deploy reassign
it. Without this, certbot fails at boot and coturn serves plain 3478 only.

## Secrets handling

- `TURN_PASSWORD` is never committed — `cloud-init.yaml` keeps the
  `__TURN_PASSWORD__` placeholder; the workflow substitutes the secret at deploy.
- ⚠️ The rendered password lands in the droplet's DO **user-data**, readable
  on-box via the metadata service (`169.254.169.254/metadata/v1/user-data`) by
  any local process. Acceptable for a single-tenant demo box; don't co-host
  untrusted workloads.
- Same password is baked into the desktop client at release time
  (`TURN_PASSWORD` → electron-vite `define` → `apps/desktop/src/renderer/src/webrtc.ts`).
  ⚠️ It is extractable from the shipped app bundle — inherent to static creds in
  a client. Rotating = redeploy droplet **and** cut a new release.

## TLS (turns://)

Handled automatically: cloud-init runs `certbot --standalone` (HTTP-01 on :80)
for `__REALM__`, then appends the `tls-listening-port` / `alt-tls-listening-port`
/ `cert` / `pkey` lines and runs the deploy hook that copies certs to
`/etc/coturn/certs` (readable by `turnserver`) and restarts coturn. Renewal uses
the certbot systemd timer; the same deploy hook re-copies + restarts on renewal.

⚠️ Let's Encrypt allows **5 duplicate certs / FQDN / week**. Each redeploy
issues fresh, so iterate against `--staging` (edit the certbot line) before a
real deploy.

## Operating

```bash
systemctl status peerkit-relay coturn
journalctl -u peerkit-relay -f
tail -f /var/log/turnserver/turn.log
```

The relay prints its full multiaddr (`/ip4/<ip>/tcp/9000/ws/p2p/<nodeId>`) at
startup — read it from `journalctl -u peerkit-relay` to configure clients
(`PEERKIT_RELAY_ADDR`).
