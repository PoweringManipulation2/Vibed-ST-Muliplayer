# Multiplayer 1.4.0 - validation report

Date: 2026-09-19
Input: user-supplied `Vibed-ST-Muliplayer-main.zip`
Output: browser extension and relay version 1.4.0, wire revision `STMP/1.4.0`

## Result

**336 checks passed across all 14 main regression suites.** The separate hunt
suite reported **13 passes and zero findings**. The offline Chromium UI smoke
page completed **59 assertions**. There were no failures, skipped tests, or
cancelled tests in the new Node test suites. JavaScript syntax, protocol-mirror,
archive integrity, and patch applicability were checked during packaging.

These are automated and source-level results, not a claim of live SillyTavern or
Tailscale certification. The limits of the environment are described below.

## Environment and reproducibility

- Linux container, Node **22.16.0**, npm **10.9.2**.
- Native Node WebSocket client and real browser-compatible WebCrypto algorithms.
- The relay tests used a real WebSocket server, real loopback sockets, and the
  project's real encrypted handshake and relay implementation.
- Outbound package download was unavailable in the working container. The `ws`
  implementation was the real preinstalled copy bundled with Playwright,
  exposed through a small test-only module adapter **outside the repository**.
  It was not a fake socket or a replacement protocol. Neither that adapter nor
  `node_modules` is included in the release. A clean `npm install` of the
  declared dependency was not executed here.
- Browser smoke environment: **Chromium 144.0.7559.96** with Playwright. Local
  source modules and the settings template were supplied directly to the page
  for a fully offline run. SillyTavern's context and event bus were mocked.
- Storage tests used an in-memory HTTP adapter for SillyTavern's character and
  persona endpoints. It models saved data, filenames, request bodies, errors,
  lost replies, and verification reads. It does not run ST's image codec or
  write actual character PNG metadata.

To reproduce the main tests in a normal development checkout with Node 22+:

```bash
npm install
npm test
npm run test:hunt
```

The browser DOM test is `tests/ui-smoke.html`. Serve the repository over a local
HTTP server and open that page. A passing run renders its result and exposes
`window.smokeResult`. No Playwright package is required for a manual run.

## Main suite results

| Suite | Passing checks | Main scope |
| --- | ---: | --- |
| `cards.test.mjs` | 19 | Existing card shapes, stubs, hydration and chunking |
| `e2e.test.mjs` | 39 | Real transport/relay behavior and authority |
| `interop.test.mjs` | 53 | Browser/Node crypto and mirrored protocol constants |
| `legacy-personas.test.mjs` | 8 | Optional legacy helper's durable persona imports |
| `lifecycle.test.mjs` | 18 | Session/socket lifecycle, reconnect and ordered sync |
| `lore.test.mjs` | 25 | Session World Info integration |
| `notice.test.mjs` | 12 | Generation-status notices |
| `ooc.test.mjs` | 25 | Separate player-chat behavior and prompt isolation |
| `persistence.test.mjs` | 28 | Durable identities, disk ownership, revisions, recovery |
| `personaview.test.mjs` | 10 | Room persona presentation |
| `portmap.test.mjs` | 16 | Router-mapping logic and address handling |
| `send-budget.test.mjs` | 4 | Message/byte pacing and cancellation |
| `session.test.mjs` | 61 | Existing session/chat behavior |
| `sync.test.mjs` | 18 | Extension parity synchronization plans |
| **Total** | **336** | **14/14 suites passed** |

The runner launches each suite in a separate Node process, checks its exit code,
and applies a timeout. This matters because older tests replace globals and
bind fixed local ports. The hunt runner is an informational probe with its own
summary, not part of the main gate; its printed findings must be inspected.

## High-value regressions exercised

### Durable create/reuse/update

One hundred simultaneous deliveries of the same card, including deliveries
through separate store instances sharing the same storage, produced exactly
one saved file. One hundred repeated synchronizations with changed room IDs
reused the file without an additional import or metadata edit when its revision
was unchanged. Settings reload, canonical hashes, stable rename identity,
same-name cards owned by different people, and host-session copy reuse were
checked separately.

A changed definition or metadata revision edits the same filename. The test
checks its existing chat association and favourite state. A same-length changed
portrait is detected by content, not byte count. Portrait writes are made using
the clean disk card, not the hydrated in-memory definition. A changed source
cannot reuse a file bearing another owner's marker.

### Real join/rejoin/recovery path

`lifecycle.test.mjs` starts the **real local relay** and connects two real
`MultiplayerSession` instances through real encrypted transports. The guest
joins/leaves ten times. The test then closes the guest's native WebSocket to
simulate a retryable connection loss and allows the existing transport to
perform its automatic backoff, handshake, and readmission.

After all these operations there is still one client card import and one saved
client card. Persona maps remain bounded to the current players. Host-name
metadata produces no repeated admission/roster echo. A host definition change
updates that same client filename and its live definition. The saved client
stub still contains no full description from the host, and leaving restores
the in-memory stub's blank description.

This test uses mocked ST HTTP storage, not two running ST servers. It does not
model Tailscale, NAT, packet loss, a browser crash, or operating-system suspend.

### Fault recovery and conservative ownership

Tests cover server errors, authentication-style lookup failures, an explicitly
missing file, an import that saved successfully but lost its reply, a response
that says success without saving the expected revision, a deleted local file,
a lost receipt, and a deterministic filename already occupied by another card.
A failed write does not mark its revision synchronized or poison the write
queue. Stale work is cancelled before a new create when its session has changed.

Same-room legacy recovery and user-selected cross-room legacy adoption are
exercised. Original local cards and copies assigned to another owner are
refused. Auditing and adoption do not delete any other file or chat history.

### Session-only definitions and lifecycle cleanup

Repeated catalogues and repeated welcomes are idempotent. Incoming definition
content must match its announced hash. Removed definition fields are cleared;
revoked cards lose their live definitions. Missing local cards cause a bounded
refresh, not recursive refreshing. Heartbeat handling stays responsive while
mock disk imports are slow. A disconnect during an import cannot hydrate a new
session using an obsolete callback.

Hydration tests also replace the live character-list object: the detached old
object is restored before its tracking reference is displaced, and edits to
nested UI data do not mutate the received definition cache. This is a test of
these extension paths, not a claim that arbitrary external extensions cannot
copy content.

One hundred transient peer IDs sharing one stable persona resolve to one
current persona record. Leave/roster events prune stale records. Switching
personas and changing same-size portraits, descriptions, and lorebooks refresh
in-memory data without accumulating obsolete profiles.

### Optional legacy persona helper

The legacy `mp-personas.js` helper is tested separately from the live extension.
One hundred overlapping imports use one deterministic avatar file. Metadata
changes and portrait changes update that filename. Different owners remain
separate; retries, a missing avatar file, and an old receipt are handled without
starting a new timestamp-named copy on every reconnect.

### Pacing, limits and UI

A virtual-clock test sends 700 frames through the budget and verifies that the
message and byte consumption remains within the relay's token buckets. Separate
cases check byte-heavy traffic, cancellation, and invalid sizes. This is a
pacing-correctness test, not a throughput benchmark. Existing malicious-flood
tests explicitly bypass the cooperative sender budget so they still exercise
the relay's defensive limiter.

The 13 hunt probes cover admission capacity, abandoned lobbies, host recovery,
relay shutdown, transfer cleanup, malformed authenticated messages, rate limits,
and bounded long-session bookkeeping. They reported no findings.

The Chromium smoke page's 59 assertions include ten mount/destroy cycles, no
retained ST/session listeners after destroy, a template resolving after disable,
shared-card gating, a valid explicit legacy-link interaction, and cancelling a
recovery dialog when the room changes before confirmation.

## Source/API contract review

The implementation was checked against primary upstream SillyTavern sources,
including the pinned 1.13.0 character endpoint and the release-branch character
and avatar endpoints:

```text
https://raw.githubusercontent.com/SillyTavern/SillyTavern/1.13.0/src/endpoints/characters.js
https://raw.githubusercontent.com/SillyTavern/SillyTavern/release/src/endpoints/characters.js
https://raw.githubusercontent.com/SillyTavern/SillyTavern/release/src/endpoints/avatars.js
```

The release branch is moving; the review date is the date of this report. The
relevant contracts were `/api/characters/get`, `/import`, and `/edit`, plus
`/api/avatars/get` and `/upload`. Image updates use the established multipart
character edit path rather than requiring the newer `edit-avatar` endpoint.
Favourite/chat/date fields are retained explicitly. Full-card `json_data` and
extension fields carry the saved ownership marker.

Reviewing endpoint source is not a substitute for running that endpoint. The
manifest minimum remains 1.13.0 but complete integration across every version
from 1.13.0 onward has not been certified.

## Not tested here / remaining limitations

No complete SillyTavern installation, real data directory, actual PNG decode /
encode, or complete multipart middleware stack was run. The UI test loads real
extension UI code but not ST's whole application or its Guided Generations
extension. Real-world Tailscale, routers, tunnelling, firewalls, Windows relay
installation, multi-account concurrency, browser-storage failure, and
simultaneous browser-tab writes across independent server sessions were not
validated end to end.

The new identity cannot reliably reconstruct the owner of arbitrary unmarked
legacy files. Such files are not merged or deleted automatically. Normal
settings persistence and backups remain important; the receipt registry is not
a transactional database. A malicious trusted host can copy received IDs; they
are not cryptographic authorship certificates.

Automatic synchronization writes clean stubs on clients, but full definitions
are visible to admitted clients in memory. Manual exports/saves, other
extensions, chat transcripts, and the separately persisted session lorebook are
outside a blanket "nothing ever reaches disk" guarantee. No independent security
audit was performed.

## Manual acceptance before deploying broadly

Use backups and two non-production ST instances first. Update every extension
and the host relay together, rerun the relay installer, restart the host server,
and reload both browser pages.

1. Share one character and select a persona on each instance. Record the client
   card filename and card/persona counts. Join/leave repeatedly, reload the
   client page, and briefly interrupt its connection. Counts should stabilize,
   not rise once per reconnect, and the activity log should not flood with
   repeated admissions.
2. Start a new room/code with the same host settings. The client should reuse
   the same card filename. Edit the host card's description, tags, and portrait;
   verify its existing client copy updates rather than a new copy appearing.
   Confirm its chat association and favourite state are retained.
3. Change a persona portrait, description, and lorebook. Use resync when testing
   a path that does not emit a normal ST event. The room should show current
   data with one entry per current player. Leaving should remove the departed
   profile. The live extension should not create remote Persona Management
   entries automatically.
4. Disconnect and inspect the client card through a fresh load from disk. It
   should be a stub again. Revoke sharing and verify the old local stub cannot
   be used merely by connecting to some other room. Confirm expected session
   World Info bindings are removed on leaving.
5. On a backed-up legacy dataset, inspect Shared storage / recovery. Explicitly
   select the old remote copy whose chat history you want to preserve. Confirm
   resync uses that filename and does not delete the other copies. Do not delete
   duplicates manually until their histories have been reviewed.
6. Disable/re-enable the extension and retry. Check that there is one panel and
   one set of event reactions. Inspect the activity log for API failures, then
   repeat the test over the actual network path, including Tailscale if used.

## Supplied evidence

The packaged release contains this report and all regression sources. The
separate validation bundle contains the main runner output, hunt output,
browser result JSON, syntax-check output, packaging checks, and file hashes.
The patch is relative to the uploaded archive, not to an assumed upstream HEAD.
No commit, push, or deployment to the GitHub repository was performed.
