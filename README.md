# SillyTavern Multiplayer

Play SillyTavern together. One person hosts a room on their own machine, others
join with a short connection code, and everyone shares one chat while keeping
their own personas.

Verified against **SillyTavern 1.18.0**.

---

## What it does

**Host mode and client mode in one extension.** Same install for everyone. Press
*Start hosting* to open a room, or paste a code to join one. Nothing is
configured twice.

**Connection codes.** Hosting produces something like
`STMP1-4T2M9-KX0BW-1FQ7P-…`, which packs the host's address, port and a
freshly generated key. Codes are Crockford base32 with a checksum, so `O`/`0`
and `I`/`1` mix-ups still decode and a single mistyped character is caught
immediately rather than turning into a confusing connection failure.

**Extension parity.** The relay fingerprints each peer's enabled third-party
extensions and refuses to seat anyone whose set differs from the host's — two
people with different mods cannot join each other. Instead of a dead end, the
mismatched peer gets a diff and a **Sync extensions** button that installs
what's missing, updates what's out of date, and disables (or, if you tick the
box, deletes) anything extra. Extension git URLs come from SillyTavern's own
`/api/extensions/version` endpoint, so syncing installs the same source the host
is running rather than guessing.

**Cloud character cards.** The host picks which characters to share. Everyone
else sees them in their normal Characters tab with a cloud badge on the avatar.
Offline they're greyed out and clicking one explains why; connected, the card
works normally.

The card *text* is never written to a client's disk. Only a stub — name, avatar,
and a marker — is stored locally. The actual definition is streamed over the
encrypted session when the card is opened, patched into memory for that session
only, and wiped on disconnect. So "they can't use it unless they're connected"
is literally true, and sharing a character doesn't hand out permanent copies of
your writing.

**Player chat the model can't see.** A floating panel, toggled from the icon next
to the send button, where players plan without any of it entering the roleplay.
Sort out who acts next, fix a continuity problem, or just talk.

SillyTavern builds prompts by walking `getContext().chat`, so anything placed in
that array is context whether it's displayed or not — `is_system` messages are
still considered and hidden ones still cost tokens on some paths. The OOC channel
therefore keeps its own transcript and renders to its own DOM, and never writes to
`chat`, chat metadata, or `setExtensionPrompt`. `tests/ooc.test.mjs` asserts that
against a mock context that throws if any of those are touched.

The only route from OOC into the roleplay is the explicit **To RP** button, which
hands the text to SillyTavern's `/send` — the same mechanism Guided Generations'
Simple Send wraps — so it posts as a normal message without asking for a reply.
The text is passed through a scoped variable rather than interpolated into the
command string, so a message containing pipes or braces can't be parsed as
script. History is held by the relay, not the host, so someone joining late sees
what was already agreed, and the channel survives a host reconnect.

**Everyone keeps their own persona.** Personas and local characters stay local.
Only a peer's resolved persona name and description travel with a turn.

---

## How a session works

The host owns the chat and the API connection. Clients don't call an inference
endpoint at all: a client's turn goes to the host, the host appends it,
generates the reply with its own model and settings, and streams the result back
to everyone. One canonical transcript, one prompt assembly, and joiners need no
API keys of their own.

```
   Client browser                  Host machine
  ┌──────────────┐        ┌──────────────────────────────┐
  │ SillyTavern  │        │ SillyTavern                  │
  │  extension   │        │  ├─ extension  (host UI)     │
  │      │       │        │  └─ server plugin (relay)    │
  └──────┼───────┘        └──────────┬───────────────────┘
         │                            │
         │   encrypted session        │  loopback, same
         └────────────────────────────┤  handshake
             ECDH + AES-256-GCM       │
                                      └─→ the model / API
```

---

## Installing

### 1. The extension (everyone)

*Extensions → Install extension* → paste this repository's URL. Or clone it into
your extensions folder yourself:

| Scope | Path |
|---|---|
| Per user | `SillyTavern/data/<user>/extensions/SillyTavern-Multiplayer` |
| Global | `SillyTavern/public/scripts/extensions/third-party/SillyTavern-Multiplayer` |

**Guided Generations is required.** Install it first:

```
https://github.com/Samueras/GuidedGenerations-Extension
```

`manifest.json` declares it as a hard dependency, so SillyTavern will refuse to
load Multiplayer without it and say exactly what's missing. The reason is its
**✈️ Simple Send** button: multiplayer needs a way to post a turn *without*
triggering a reply, so several players can act before the model answers. Guided
Generations already provides that button, and duplicating it would just mean two
buttons doing the same job.

One caveat about how ST resolves dependencies: the name it matches is the
*folder* name, not anything inside Guided Generations' own manifest. Installing
from the URL above produces `GuidedGenerations-Extension`, which is what's
declared. If you cloned it into a differently-named folder, Multiplayer won't
load — either rename the folder or edit the `dependencies` array in
`manifest.json` to match.

Joining a room needs nothing else. Only the host needs step 2.

### 2. The relay (host only)

SillyTavern loads server plugins from its own `plugins/` directory, so the relay
has to be linked there. From inside the extension folder:

On Windows, double-click **`install-windows.bat`**. It finds Node even when it
isn't on PATH — the SillyTavern Launcher bundles its own copy and doesn't always
add it — then runs the installer and tells you what to do next.

Anywhere else, or from a terminal:

```bash
node install.mjs --enable
```

Either way it links `./server` to `SillyTavern/plugins/st-multiplayer`, checks
that `ws` resolves, and sets `enableServerPlugins: true` in `config.yaml`
(backing the file up first).

**Then fully restart SillyTavern.** Reloading the browser page does nothing:
`loadPlugins()` only runs while the server is starting, so the server process
itself has to restart.

```bash
node install.mjs                 # link only, just report on config.yaml
node install.mjs --root /path    # point at SillyTavern explicitly
node install.mjs --copy          # copy instead of link (Windows, Docker images)
node install.mjs --uninstall     # remove it again
```

On startup the SillyTavern console — the terminal window, not the browser one —
should print `Initializing plugin from …/plugins/st-multiplayer`.

### "The Multiplayer server plugin is not available: HTTP 404"

404 means the route was never mounted, so the plugin was not loaded at all.
Exactly three things cause it, in order of likelihood:

1. **The installer was never run.** Nothing is in `SillyTavern/plugins/`.
2. **`enableServerPlugins` is not `true`** in `config.yaml`. ST returns an empty
   cleanup function and skips the whole plugins directory without logging
   anything, so this failure is completely silent.
3. **SillyTavern was not restarted** after the first two were fixed.

Joining a room is unaffected by all of this — only hosting needs the relay.

A different status means something else: **403** is a non-admin account, **401**
means reload and sign in again, and a version-mismatch message means the relay
on disk is older or newer than the extension, so re-run the installer.

`ws` is one of SillyTavern's own dependencies from 1.13 onward, so there is
normally nothing to install. On an older tree: `npm install ws` in the
SillyTavern root.

---

## Using it

**Host.** *Extensions → Multiplayer → Start hosting.* Copy the code and send it
to whoever is joining. *Choose shared characters* picks what the room can see.
*New code* invalidates the old one and drops everyone — useful if a code leaked.

**Client.** *Extensions → Multiplayer*, paste the code, *Join*. If the extension
check fails you'll get a diff and the sync option; after syncing, reload and
rejoin.

**Reaching the host.** Leave **Ask my router to open the port automatically**
ticked and, in most cases, there is nothing else to do.

That option asks the router directly, over NAT-PMP and UPnP — the two protocols
consumer routers have implemented for decades, usually enabled out of the box.
If it works, the relay learns the public address from the router and puts it
straight into the connection code, so a code generated on your Wi-Fi works for
someone in another state with no port forwarding, no account, and nothing
installed. Both protocols are implemented here with Node builtins only: no
dependency, and no third-party service in the path.

The mapping is a one-hour lease that renews itself and is removed when hosting
stops. If SillyTavern is killed without a clean exit, the hole closes on its own
within the hour rather than staying open.

When it does not work, the panel says why rather than leaving you guessing:

- **The router did not respond.** Automatic mapping is switched off in its
  settings, or there is a second router between you and the internet.
- **Carrier-grade NAT.** The router reports its own "public" address as a private
  one, which means the ISP is sharing it between customers. No protocol can open
  a port through that.

For either case, use one of these instead and put the address in **Address
players connect to**:

- **Tailscale** (or WireGuard, ZeroTier) — install on both machines, sign in to
  the same account, use your `100.x.y.z` address. Works through CGNAT and exposes
  nothing to the internet.
- **Manual port forwarding** — forward the port on your router, use your public
  IP.
- **An HTTPS tunnel or reverse proxy** — Cloudflare Tunnel, ngrok, or your own
  nginx. Put the public hostname in, **tick the HTTPS box**, leave the public
  port at 0 if it is on 443. This is also the only option that works when a
  player's own SillyTavern is served over HTTPS, since browsers refuse plain
  WebSockets from an HTTPS page.

The panel shows the exact URL players will dial next to the code, so a wrong
address or a forgotten HTTPS tick is visible before anyone tries to join.

### "Stuck on Connecting" forever

The client reports this after three failed attempts with a checklist, because
nothing answering at all is a network problem rather than a wrong-code or
wrong-version problem. In rough order of likelihood:

1. **The code contains a local address and the joiner is elsewhere.** A
   `192.168.x.x` or `10.x.x.x` address cannot route to another house. Use
   Tailscale or one of the other options above. The host's activity log warns
   about this when it happens.
2. **A firewall is blocking the port.** On Windows, Defender blocks incoming
   connections to `node.exe` silently — no prompt, no log entry, nothing.
3. **The host stopped hosting**, or rotated the code after sharing it.
4. **The port is not forwarded** to the host machine.
5. **The joiner's SillyTavern is served over HTTPS.** Browsers refuse plain
   WebSocket connections from an HTTPS page, so this is refused up front with an
   explanation rather than hanging.

**Player chat.** The speech-bubble icon next to the send button opens and closes
it, and carries an unread badge. Enter sends, Shift+Enter makes a new line.

The panel can be dragged by its title bar, resized from the bottom-right grip,
and collapsed to just the title bar with the **–** button or by double-clicking
the title bar. Position, size and collapsed state are remembered between
sessions, and are always clamped back into the viewport — so a panel saved on a
large monitor never returns unreachable on a laptop. If it ends up somewhere
awkward, **Reset its position** in the Multiplayer panel puts it back.

**To RP** posts the composed text into the roleplay without asking for a reply —
that, and only that, crosses over.

Slash commands: `/mp-host`, `/mp-join <code>`, `/mp-leave`, `/mp-sync`,
`/mp-status`, `/mp-ooc [message]` (opens the panel when given no text).

---

## Security

**What the encryption is for.** The relay runs on the host's own machine, so the
attacker worth defending against is on the network path — shared Wi-Fi, a
router, a VPS, a tunnel provider. Every frame is encrypted above the WebSocket
layer, which means the guarantees are the same over plain `ws://` on a LAN as
over `wss://` behind a proxy. It does *not* hide anything from the host, who
owns the transcript and runs the model regardless.

**Handshake.** Ephemeral ECDH on P-256, and the shared secret is concatenated
with the connection code's pre-shared key *before* the KDF runs:

```
transcript = SHA-256("STMP/1 handshake" ‖ clientPub ‖ serverPub ‖ nonceC ‖ nonceS)
okm        = HKDF-SHA256(ikm = ECDH ‖ psk, salt = transcript, info = "STMP/1 keys")
```

Folding the PSK into the input keying material rather than only MAC-ing
afterwards is what authenticates the exchange. Someone in the middle can
substitute public keys, but without the code they derive different keys and
cannot forge either confirmation MAC, so the connection dies before any
application data moves. Both sides prove knowledge of the PSK with an HMAC over
the full transcript, compared in constant time. Ephemeral keys mean recording
traffic and learning the code later decrypts nothing.

**Records.** AES-256-GCM, separate keys and nonce salts per direction, nonce =
`salt(4) ‖ counter(8)`, so no `(key, nonce)` pair repeats. The 10-byte header is
authenticated as AAD, so rewriting a counter or flipping the compression flag
fails authentication. A sliding-window replay guard rejects duplicates before
any crypto work.

**The code never travels.** The relay identifies a room by
`SHA-256("STMP/1 room-id" ‖ psk)`, so a wrong code is rejected at the first
message without the key itself ever going on the wire.

**Authority.** Exactly one host per room, claimed with a token minted by the
`/start` endpoint *and* required to arrive over loopback. Clients are held to an
opcode allow-list: a client cannot publish a card catalogue, rewrite the
transcript, or address other clients directly. Turns are routed to the host, not
broadcast.

**Player chat authority.** The relay stamps the author, id and timestamp on
every OOC message and echoes it to the whole room including the sender, so no
peer can post under someone else's name and every peer renders the channel in
the same order. Messages are capped at 2000 characters, blanks are dropped, the
room's history is a bounded ring buffer, and peers held at the parity gate can't
talk to the room at all. Received text is rendered with `textContent`, never
`innerHTML`.

**Abuse resistance.** Bounded half-open handshakes, per-IP failure blocking with
a cooldown, per-peer token buckets on both message count and bytes, a hard frame
ceiling enforced by `ws` before any of this code runs, `maxOutputLength` on
decompression to stop compression bombs, heartbeat-based culling, and kick/ban.

**The control API.** SillyTavern calls `loadPlugins()` *after* its basic auth,
IP whitelist, CSRF and login middleware, so `/api/plugins/st-multiplayer/*`
inherits all of it. That's what makes it safe for `/start` to return the room's
key: it only ever goes to the already-authenticated browser session of the
person hosting. On top of that the plugin adds an admin check, `no-store` on
secret-bearing responses, and strict validation before anything reaches the
relay.

**Please note.** This has not had an external security review. The handshake is
a deliberately conservative construction out of standard primitives rather than
anything novel, but "reviewed by its author and a test suite" is not the same as
"audited". Treat it as good enough for playing with people you already trust,
not as protection against a determined attacker.

---

## Tests

```bash
node tests/interop.test.mjs   # 52 checks — browser and Node crypto agree
node tests/e2e.test.mjs       # 32 checks — real relay, real sockets
node tests/ooc.test.mjs       # 25 checks — player chat cannot reach a prompt
node tests/hunt.test.mjs      # 13 probes — adversarial; findings, not a gate
node tests/portmap.test.mjs   # 16 checks — router protocols, parsing, SSRF guard
node tests/sync.test.mjs      # 18 checks — extension sync actually installs things
node tests/cards.test.mjs     # 19 checks — the card-sharing chain end to end
```

`interop` matters because the key schedule and frame format are implemented
twice, in WebCrypto and in Node's `crypto`. It proves both halves derive the
same keys, verify each other's MACs, and can open each other's frames — and that
tampering, replays and cross-session frames are rejected.

`e2e` starts the actual relay on a loopback port and drives it with the actual
browser transport (Node 20+ has a global `WebSocket`, so `lib/transport.js` runs
unmodified). It covers role assignment, the parity gate, opcode authority,
capacity, kick, rotation and clean port release.

`ooc` drives the real channel against a mock context whose `chat`,
`chatMetadata` and `setExtensionPrompt` are watched, and fails if anything lands
in them. It also covers truncation, name spoofing, and malformed payloads.

`hunt` is deliberately adversarial: it fills the room with peers who can never be
admitted, disconnects the host and reconnects, claims the host slot twice,
abandons transfers, floods the rate limiter and runs a 5000-turn session looking
for unbounded growth. It exits zero regardless, because its job is to surface
findings rather than gate a release.

Seven bugs came out of writing these, all fixed:

- Frame handling is asynchronous, so an unserialised handler let the relay's
  `welcome` be processed before the `accepted` that installs the session keys —
  killing valid sessions non-deterministically. Inbound frames are now chained
  on both sides.
- `stop()` resolved on a timeout race while the listener was still bound, so
  stop-then-start on the same port failed with `EADDRINUSE`. Sockets are now
  terminated first and the close is actually awaited.
- The host was seated silently, so its UI never left "checking extensions" and
  it never published its shared cards. Admission now runs through one code path
  that always announces itself.
- The OOC panel's unread counter was cleared inside a DOM guard, so the state
  machine's behaviour depended on whether the panel happened to be mounted.
- The panel could not be closed at all. It is shown and hidden with the `hidden`
  attribute, but `#stmp_ooc_panel { display: flex }` is an author-origin ID rule,
  and author rules beat the browser's built-in `[hidden] { display: none }`
  regardless of specificity — so `hidden` had no visual effect. The close button
  looked dead and the panel was visible before it was ever opened. Fixed with an
  explicit `#stmp_ooc_panel[hidden] { display: none }`.
- Reopening a panel that had been collapsed left it collapsed, so clicking the
  icon appeared to do nothing — the same "state behind a DOM guard" mistake as
  above, made a second time. Every state change in `openPanel` now happens above
  the guard, with a comment saying why.
- Room capacity counted *every* connected peer rather than admitted ones, so
  anyone held at the extension-parity gate occupied a seat. A group who all
  needed to sync could fill the room and lock out someone who was ready to play,
  with the host seeing only "room full". Capacity now counts admitted peers, and
  the lobby has its own smaller cap.
- Peers held in the lobby were never dropped. They answer heartbeats perfectly
  well, so the liveness timeout could never remove them and their slot leaked for
  the life of the room. There is now a 90-second lobby timeout.
- Advertising a non-loopback address with "Allow players on my local network"
  switched off is a guaranteed failure — the relay binds `127.0.0.1`, the code
  looks correct, and every joiner hangs forever. Now refused up front with an
  explanation.
- `ChatBridge` remembered every message id for the life of the session purely to
  detect echoes, which only ever arrive moments after sending. A long session
  accumulated all of them; the sets are now bounded windows.
- The connection code could only express `ws://host:port`, so an HTTPS tunnel or
  reverse proxy — the most accessible way to play across the internet, and the
  only one that works when a player's SillyTavern is on HTTPS — was impossible.
  Codes can now carry a TLS endpoint and a default port.
- Tailscale addresses were warned about as "local network only". They are in
  carrier-grade NAT space, which the check treated as private, but a tailnet
  reaches across the internet and is the recommended setup — so the warning sent
  people looking for a problem they did not have.
- Cross-network play required either router configuration or a mesh VPN, i.e. a
  setup loop per player. The relay now asks the router to open the port itself
  over NAT-PMP and UPnP, and uses the public address the router reports.
- Port-mapping discovery originally probed each candidate gateway in sequence, so
  hosting blocked for four and a half seconds before a code appeared. Candidates
  and protocols are now raced under a 2.6-second ceiling.
- **Sharing characters shared nothing, and said so.** The picker read its
  checkboxes after `callGenericPopup` resolved, but SillyTavern removes the
  dialog from the DOM before `show()` settles — so the query matched nothing, the
  selection was always empty, and the panel honestly reported "Sharing 0
  characters". Selection is now captured both by a delegated change listener and
  by an `onClosing` handler that reads the popup while its DOM still exists.
- **Extension sync installed nothing at all, silently.** The parity report
  stripped `homePage`, and `remoteUrl` was only populated in the non-default
  `commit` strictness mode — so `buildSyncPlan` had no URL for anything, every
  entry became an "install this yourself" step, and pressing Sync reported
  success while doing nothing. The report now carries `homePage`, and the host
  can be asked for real git remotes on demand when Sync is pressed.
- `deleteExtension` builds its hook name as `'third-party' + name` with no
  separator, so passing a bare folder name resolved to `third-partyFoo` and the
  extension's own delete hook never ran. SillyTavern's own UI passes `/Foo`;
  this now does too.
- Sync reported failures as "N step(s) failed, see the log", which is not
  something anyone can act on. It now lists each failure with its reason and URL.
- The connection code's address, port and scheme were decided in two places —
  once when hosting started and once when the code was rotated — and the two had
  drifted. Rotation ignored the router-supplied public address, so rotating a
  working code silently downgraded it to a LAN address remote players could not
  reach. Both now call one tested function.
- Ticking "behind an HTTPS tunnel" without supplying a hostname produced a
  `wss://` code aimed at the router's own address on port 443, where nothing is
  listening. That combination is now refused with an explanation, since it is an
  easy thing to reach for when you have no address to type.
- `portMapping` and `publicHost` were added to `status()` but not `describe()`,
  and `/start` returns `describe()` — so the host UI never received either, and
  the automatic address could not be used. Caught by probing the real return
  value rather than reading the code.

---

## Layout

```
manifest.json          UI extension manifest
index.js               entry point, settings, hooks, slash commands
settings.html          settings drawer
style.css
lib/
  protocol.js          frame layout, opcodes, limits, connection codes
  crypto.js            WebCrypto: ECDH P-256, HKDF, AES-256-GCM
  transport.js         handshake, backpressure, reconnect
  session.js           host/client orchestration
  parity.js            fingerprinting, diffing, sync execution
  cards.js             stub cards, hydration, chunked avatars
  chat.js              chat relay
  ooc.js               player-only channel (never touches context.chat)
  ui.js                panel, cloud badges, sync dialog
server/                ← linked into SillyTavern/plugins/st-multiplayer
  index.js             plugin entry: info / init / exit + control API
  lib/protocol.js      mirror of lib/protocol.js  (KEEP IN SYNC)
  lib/crypto.js        Node crypto, wire-compatible with lib/crypto.js
  lib/relay.js         WebSocket relay, rooms, parity gate, limits
  lib/portmap.js       NAT-PMP and UPnP port mapping, zero dependencies
install.mjs            links the relay into SillyTavern's plugins directory
tests/
```

`lib/protocol.js` and `server/lib/protocol.js` are deliberate mirrors. Both
peers exchange `PROTOCOL_REVISION` during the handshake and refuse to continue
on mismatch, so letting them drift fails closed instead of corrupting state
silently. `tests/interop.test.mjs` asserts they agree.

---

## Limits and rough edges

- **The host is a single point of failure.** If the host disconnects, clients
  are told and wait; there is no host migration.
- **Clients mirror the host's chat.** Swipes, branching and message editing are
  host-side actions. A client's local chat file becomes a transcript of the
  session.
- **Group chats are not synced.** One character at a time.
- **Player chat is not stored anywhere.** The relay keeps the last 200 messages
  in memory only. Stop the relay and the planning history is gone.
- **Commit-level parity is slow.** The exact mode pins each extension's git
  commit, which costs a `git fetch` per extension. Results are cached for five
  minutes; the default name-and-version mode is instant and catches every
  practical mismatch.
- **Sync can't install what isn't public.** Extensions the host installed by
  hand, with no git remote, are listed for manual installation.
- **Reinstalling to change versions is destructive.** Matching a pinned commit
  deletes and re-clones that extension, which discards local modifications to
  it.

## Licence

AGPL-3.0, matching SillyTavern.
