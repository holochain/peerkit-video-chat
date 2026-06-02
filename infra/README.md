# infra

One-shot droplet provisioning. `cloud-init.yaml` sets machine state once at
first boot. No day-2 config management: to change config, **redeploy** from an
edited copy. The deploy is driven by the manually-triggered
`.github/workflows/deploy.yml`.

Runs two systemd services on one DigitalOcean droplet:

| Service | Unit | Port(s) |
| --- | --- | --- |
| PeerKit relay | `peerkit-relay` | 9000/tcp |
| coturn TURN/STUN | `coturn` | 3478, 5349, 443, 49152–65535/udp |

## Deploy

Run the **Deploy relay + TURN** workflow (Actions → Run workflow). Inputs:
`repo_ref` (relay version to build), `region`, `size`. Each run renders
`cloud-init.yaml`, creates a fresh droplet (immutable model), upserts the
Cloudflare DNS record to its IP, issues a TLS cert via DNS-01 in CI, and
delivers it over SSH to enable coturn TLS. The old droplet is left running so a
bad deploy is rolled back by pointing DNS back at it; delete it manually after
verifying.

### Required GitHub secrets

| Secret | Purpose |
| --- | --- |
| `DIGITALOCEAN_ACCESS_TOKEN` | doctl auth |
| `TURN_PASSWORD` | static long-term TURN credential (also used by release.yml) |
| `CERTBOT_EMAIL` | Let's Encrypt (ACME account) contact email |
| `CLOUDFLARE_API_TOKEN` | DNS upsert + DNS-01 challenge; scope to **Zone.DNS:Edit** on the one zone |
| `CLOUDFLARE_ZONE_ID` | zone holding the demo FQDN |
| `DO_SSH_KEY_FINGERPRINTS` | comma-separated SSH key fingerprints added to the droplet (one per operator) |
| `DO_SSH_PRIVATE_KEY` | private key the workflow uses to SSH in and install the cert (must match one of the fingerprints above) |

### Required GitHub variable

| Variable | Purpose |
| --- | --- |
| `TURN_REALM` | the server FQDN (`peerkit-video-chat-demo.holochain.org`) — public, not a secret. Used by `deploy.yml` (realm + cert domain) **and** `release.yml` (baked into the client), so client and server agree on one value. |

The release workflow (`release.yml`) needs `TURN_PASSWORD` (secret) and
`TURN_REALM` (variable) to wire TURN into the desktop client; if either is
absent the client falls back to STUN-only. The other secrets are deploy-only.

### One-time setup

Provision under **Settings → Secrets and variables → Actions** (secrets on the
*Secrets* tab, `TURN_REALM` on the *Variables* tab):

1. **DigitalOcean** — create an API token with read/write
   (`DIGITALOCEAN_ACCESS_TOKEN`). Upload each operator's SSH **public** key to
   the DO account; collect the fingerprints into `DO_SSH_KEY_FINGERPRINTS`
   (comma-separated). Put the **private** key for one of them in
   `DO_SSH_PRIVATE_KEY` so the workflow can SSH in to install the cert.
2. **Cloudflare** — the FQDN's zone must be managed by Cloudflare (NS
   delegation), since both the DNS upsert and the DNS-01 challenge go through
   its API. Create an API token scoped to **Zone.DNS:Edit** on that one zone
   (`CLOUDFLARE_API_TOKEN`) and copy the zone's ID (`CLOUDFLARE_ZONE_ID`).
3. **TURN / TLS** — set the `TURN_REALM` variable to the FQDN, pick a static
   `TURN_PASSWORD`, and set a `CERTBOT_EMAIL` for the Let's Encrypt account.

No DNS record needs to pre-exist — the deploy creates/updates it. After the
first deploy, verify the FQDN resolves to the droplet IP and that `turns:` on
443 answers.

## DNS

The deploy upserts a **DNS-only (grey-cloud)** A record for the FQDN → the new
droplet's IP. The record must not be proxied — Cloudflare's proxy can't carry
TURN UDP or the relay port range. No Reserved IP is needed; DNS is the stable
pointer.

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

The cert is issued **in CI** via the Let's Encrypt DNS-01 challenge
(`certbot --dns-cloudflare`), so the Cloudflare token never touches the droplet.
The workflow then waits for cloud-init to finish, copies the cert to
`/etc/coturn/certs` (readable by `turnserver`), appends the `tls-listening-port`
/ `alt-tls-listening-port` / `cert` / `pkey` lines, and restarts coturn. coturn
serves plain 3478 from boot; TLS on 5349/443 comes up once the cert is delivered.

⚠️ **No on-box renewal.** The token being CI-only means the 90-day cert is
refreshed by re-running this workflow — schedule a periodic deploy or it will
expire. (A `schedule:` trigger can be added later.)

⚠️ Let's Encrypt allows **5 duplicate certs / FQDN / week** — mind it if you
redeploy rapidly.

## Operating

```bash
systemctl status peerkit-relay coturn
journalctl -u peerkit-relay -f
tail -f /var/log/turnserver/turn.log
```

The relay logs structured JSON at startup; the `relay ready` line carries its
full multiaddr in the `multiaddrs` field
(`/ip4/<ip>/tcp/9000/ws/p2p/<nodeId>`) — read it from
`journalctl -u peerkit-relay` to configure clients (`PEERKIT_RELAY_ADDR`).
