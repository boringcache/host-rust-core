# Hermetic test host: what the code says

Findings from investigating the proposal to build a hermetic TrUAPI test host in this
repo to replace `@parity/host-api-test-sdk`. Everything below is measured against
source, with the ref named. Nothing here is an estimate carried over from an earlier
document.

Three checkouts are involved and all three are on disk:

| Repo | Path | Ref read |
| --- | --- | --- |
| host-rust-core (this repo) | `~/Work/Parity/truapi`, worktree `~/Work/Parity/mock-report` | `mock-rebase-probe` |
| product-sdk | `~/Work/Parity/product-sdk/product-sdk` | `origin/main` (working tree is 158 behind) |
| host-api-test-sdk | `~/Work/Parity/host-api-test-sdk` | `origin/main` = `17a28f9`, v0.12.1 |

## 1. `sign_raw` is hermetic; `create_transaction` is not

On a signing host, `sign_raw` needs no chain access. It passes a remote-permission
check named `ChainSubmit` — a local policy question answered by the platform, not an
RPC (`runtime.rs:611` resolves it through `require_remote_permission`) — and then signs
locally with sr25519. `create_transaction` and `sign_payload` do need chain metadata,
because they call `build_local_transaction`.

Proven by `rust/crates/truapi-server/tests/signing_host_mock_platform.rs` (3 tests):
a real `signing_sign_raw` product frame through the dispatcher into a
`SigningHostRuntime` whose entire platform is `MockPlatform`, with the returned
signature verified against a keypair derived independently from the activation
entropy. Both load-bearing assertions were mutation-checked: deriving from different
entropy fails with `EquationFalse`, and verifying the unwatermarked message fails.

The name `require_chain_submit` implies an RPC and is the reason this was mis-scoped.
The doc comments in `truapi-platform/src/mock.rs` and
`js/packages/truapi-host/src/web/create-mock-host.ts` asserted that signing parks under
a silent chain; both were corrected.

**Scope on what a call needs from the chain, not on whether it signs.**

## 2. The product-sdk suite is 63 tests, and 80% of the active ones need no chain

Counted directly across 34 spec files on `origin/main`: **63 test cases, 12 skipped
(10 inside four `describe.skip` blocks plus 2 individual `test.skip`), 51 active.**

| Bucket | Total | Active |
| --- | --- | --- |
| NONE — no chain at all | 41 | 41 |
| READ — reads only | 11 | 4 |
| EXTRINSIC — real inclusion | 10 | 5 |
| FINALITY | 1 | 1 |

The NONE bucket is exactly five whole examples — statement-store 10, signer 9, keys 8,
storage 8, host 6. Four declare zero chain-facing dependencies; `signer-demo` declares
`polkadot-api` and never imports it in either source file.

The discriminator is the host signing log: two tests assert type `"raw"`
(`signer-demo/e2e/sign-raw.spec.ts:28`, `lifecycle.spec.ts:51`) and five assert
`"createTransaction"`. That is the same hermetic/chain-bound line as finding 1,
arrived at independently from the JS side.

**Consequence:** a hermetic chain responder was scoped at 5–8 days, but the expensive
half — block production, event emission, dispatch-error semantics, finality — serves
only ~6 active tests. Serving the READ bucket alone is a static metadata blob plus two
fixed responses. The cheap win is partitioning the suite, not building a responder.

## 3. The six skips are not caused by `host-api-test-sdk`

**Superseded on the wider question — see section 19.** This section answers one
narrow thing, asked in July: are product-sdk's skipped tests skipped because the
package is inadequate? They are not, and that still holds. It is NOT a finding
that consumers are unblocked. They are blocked, at the wire: the package
reimplements codec 1 and cannot serve a product built on `@parity/truapi`
0.16.0, which is codec 2. Section 19 has the measurements.

All six skip markers were read. None is caused by the package being inadequate:

- 3 × `cloud-storage-demo` — the product migrated to `AsyncBulletinClient`; the new
  path needs "a real bulletin chain (or an extrinsic-aware mock)".
- 1 × `contracts-demo/query` — a contract was reaped in a Paseo genesis reset. The
  comment says outright: "This is stale chain state, not an SDK regression" (#322).
- 2 × `signing-rejected` — product-sdk caches the `TransactionSubmit` grant instead of
  re-checking per sign.

The proposed project fixes at most one of the six. The three cloud-storage skips need
the extrinsic-aware mock chain the proposal explicitly rejects, and those target a
**bulletin** chain rather than Asset Hub — re-enabling them means modelling two chains.

The package is actively maintained (98 commits in six months) and already tracks
TrUAPI: `ac633f8` (2026-07-17, Valentin Fernandez) answers TrUAPI 0.4's MessagePort
handshake.

## 4. The 40-member control plane already exists

`TestHostAPI` at `src/types.ts` on `origin/main` (v0.12.1, the version product-sdk's
catalog pins) has **40 members**. The local working tree shows 42 because it sits on
`test/fault-injection-e2e` with unreleased `setFaults`/`getFaults` — read `origin/main`,
not the working tree.

Every category previously sized as "genuinely net-new, nobody has costed these" is
already present:

- **Chat (5)**: `getChatRooms`, `getChatBots`, `getChatMessageLog`, `clearChatState`,
  `injectChatAction`
- **Payments (5)**: `setPaymentBalance`, `getPaymentLog`, `clearPaymentLog`,
  `setPaymentTopUpBehavior`, `simulatePaymentStatus`
- **Permission granularity (4)**: `grantPermission`, `revokePermission`,
  `getGrantedPermissions`, `setEnforcePermissions`, plus `getPermissionLog` and
  `clearPermissionLog`
- **Signing-log payloads**: `SigningLogEntry { type; payload: unknown; timestamp }` —
  records the payload, not merely the kind
- **8 `clear*` methods**

These exist in the package proposed for replacement, not in this repo's mock, which
still has ~20 members. The expansion would re-implement a working, shipped control
plane — a replacement-cost argument, not a work-already-done one.

## 5. The coupling is 40/60, but the seams are not congruent

`host-api-test-sdk/src` is 2,757 lines across 11 files.

**Protocol-coupled, ~1,092 lines (40%)** — would be rewritten:

- `src/browser/host-runtime.ts:331-1234` — the whole `setupContainer`, 904 lines,
  holding all 41 `container.handleXxx` registrations
- `src/fault-provider.ts` — 188 lines wrapping the `@novasamatech/host-api` `Provider`
- `src/types.ts:1,3` — two `HexString` type imports

**Protocol-agnostic, ~1,665 lines (60%)** — survives untouched: module state, dev
keyring, `buildSignedV4Extrinsic`, the iframe allow-attribute, `init()`, the entire
40-member control plane, and every other file (`playwright/fixture.ts`, `types.ts`,
`host-page.ts`, `server.ts`, `scenarios.ts`, `networks.ts`, `index.ts`, `accounts.ts`)
— all verified to hold zero protocol references.

The control plane block references the container in exactly two places, both lifecycle
(`dispose` and recreate on `setAccounts`). It is genuinely decoupled.

**But 41 Spektr handlers map onto only 22 TrUAPI host-callback methods**, because a
TrUAPI host *confirms* where a Spektr host *performs*. Every signing reference in the
generated host callbacks is a `UserConfirmationReview` variant; there is no `signRaw()`
host callback. So ~19 handlers — signing, accounts, statement store — are deleted
rather than ported, their work moving into the Rust core. Which is exactly what finding
1 proves runs against `MockPlatform`.

### The payments hole

There is no host seam for payments: zero payment references in the generated JS host
callbacks, and `pub trait Platform` (`truapi-platform/src/lib.rs:2968`) has exactly 12
supertraits, none of them payment. But the reason is not that the core owns payments.
**Payments are unimplemented.**

`rust/crates/truapi-server/src/runtime/capabilities/payment.rs` is the only `Payment` /
`CoinPayment` implementation in the workspace, and every method returns an error while
ignoring both `_cx` and `_request`: `balance_subscribe` yields `PermissionDenied`,
`request`, `status_subscribe` and `top_up` yield `PAYMENTS_NOT_IMPLEMENTED`, and all
nine `CoinPayment` methods return `Unsupported`. The constant reads
`"Payments are not supported in dot.li"` (`runtime.rs:931`). The wire surface is fully
specified and the TS client encodes all of it, so a product can call these — it just
always gets an error.

Meanwhile RFC 0006 (accepted, `docs/rfcs/0006-payments.md`) assigns payments to **host
implementors**, "including user consent flows, coin management, and settlement", and
requires that every `host_payment_request` raise a confirmation prompt the host must
not auto-approve (:27, :149).

So the seam is designed and accepted but unbuilt. Adding a payment trait — most
naturally to `OptionalPlatform`, which already carries `ChatPlatform` this way so
existing hosts keep compiling — is implementing an accepted RFC rather than inventing
protocol. The alternative is to accept that a TrUAPI test host's truthful payment
behaviour today is "returns `PAYMENTS_NOT_IMPLEMENTED`", in which case any product test
that exercises a *successful* payment cannot port, because TrUAPI cannot execute that
path at all.

That is the live decision, and it is a product decision rather than a test-host one.
Note that mocking cannot close this gap: there is no behaviour to fake.

A related second-order cost: several surviving members lose their *data source* even
though their code survives. `getSigningLog()` records payloads today because the host
signs; under TrUAPI the host only sees `confirmUserAction`. Recoverable —
`SignRawReview` carries the request — but it is re-plumbing, not a no-op.

## 6. The seam work was already prototyped here, and is now superseded

Branch `feat/truapi-host-engine` (`3454c5d`, Nidish, 2026-06-24) adds
`src/truapi-engine/host-iframe-provider.ts` (117 lines) plus a 159-line test — a
host-side (parent) iframe provider for `@parity/truapi`, written because
`createIframeProvider` serves the child side only. Local only, never pushed, 21 commits
behind `origin/main`.

**On its merits it is sound.** No TODOs or hedging. It reads `contentWindow` lazily so
iframe reloads work, pins both `event.source` and `event.origin`, guards the payload
type, and documents its one escape hatch as off-by-default. The 10 tests genuinely
discriminate — foreign source dropped, foreign origin dropped, non-`Uint8Array`
ignored, unsubscribe and dispose asserted by handler count, `allowAnyOrigin` asserted
to relax the origin *and* keep the source pin, and a reload case asserted in both
directions. Its structural `Provider` is member-for-member identical to today's
`WireProvider` (`js/packages/truapi/src/transport.ts:363`), optional `subscribeClose`
included; only the name changed.

**But the architecture moved past it.** TrUAPI hosts no longer bridge parent and iframe
with raw window `postMessage`: `createIframeHost`
(`js/packages/truapi-host/src/web/create-iframe-host.ts`) transfers a `MessagePort`
into the product iframe and the host pipes its end through `createMessagePortProvider`
(`js/packages/truapi/src/transport.ts:636`). Both ship today. And
`host-api-test-sdk`'s own main already answers that handshake (`ac633f8`, three weeks
after this branch was written).

So the branch reads as parked because the ground shifted and the need was met upstream,
not because it hit a wall — though only its author can confirm that. The practical
consequence is favourable: a seam retarget needs no bespoke provider at all.

## 7. The 40-member surface spans three layers, not one

"Grow the mock to 40 members" is the wrong target. `TestHostAPI` is shaped around a
host that *performs* signing, accounts and statements; a TrUAPI host only *confirms*.
Several members therefore have no `MockPlatform` home at all:

| Member | Where it belongs in TrUAPI |
| --- | --- |
| `injectChatAction` | The runtime. `publish_chat_action` (`host_core.rs:1155`) already exists, gated on a chat platform being installed — implementing `ChatPlatform` is what unlocks it. |
| `switchAccount`, `setAccounts`, `setLoginBehavior` | The runtime. Accounts derive from entropy, so these are `activate_local_session` with different material, not a host callback. |
| `getSubmittedStatements`, `injectStatement`, `clearStatements` | The chain responder. `truapi-platform` declares no statement trait or seam; `lib.rs:11` states that statement-store protocol flows live in the core. Statements are observable through `sent_rpc()` and injectable through scripted responses. |
| `getConnectionStatus` | The transport. `MockPlatform` models the chain connection, not the product-host link. |
| `getIsAuthenticated` | Already covered by `auth_states()`. `AuthPresenter` is observation-only. |
| The 5 payment members | Nowhere, until the decision above is made. |

What genuinely belongs on `MockPlatform` — and is now implemented — is the confirmation
and permission surface, chat, theme, preimages, chain connection simulation, and fault
injection.

## 8. Where this leaves the plan

| Step | Original | What the code says |
| --- | --- | --- |
| 1 Signing-host wiring | ~1d | Done and proven. |
| 2 JS half of #294 | 2.5–3d | Small repair of existing in-tree code; worth doing regardless. |
| 3 Chain responder | 5–8d | Expensive half serves ~6 active tests. Partitioning gets 80% for near-zero. |
| 4 Control surface to ~45 | ~7d | Re-implements a shipped, maintained 40-member API. |
| 5 Port #261 harness | 4–6d | Depends on 4. |
| 6 Package via product-sdk | 5–8d | Depends on 4–5. |

If a TrUAPI-native test host is still wanted, the cheapest path is to lift the 60% that
has no protocol imports, rewrite the 40% seam onto `createIframeHost` +
`createMessagePortProvider`, and archive the original — which satisfies both the
engineering and the stated goal of archiving `host-api-test-sdk`. Roughly 6–11 days
plus the payments decision, against 25–33 as originally scoped.

## 9. Migrating product-sdk needs a truapi bump first

`@parity/truapi` 0.13.1 and 0.15.0 are not wire-compatible, and the handshake
says so rather than hanging: #357 moved `WIRE_CODEC_VERSION` from 1 to 2
(`truapi/src/lib.rs:219`), and `system.rs` refuses a mismatched codec with
`UnsupportedProtocolVersion`. product-sdk's catalog pins ^0.13.1, so its suites
cannot run against a 0.15-derived host until that is bumped.

That bump is not free. Building product-sdk against 0.15 surfaces two compile
errors in **its own** code, both in `packages/host/src/testing.ts`
(`createFakeHost`):

- the signing stub is missing `signRawUnwatermarkedDeprecated` and
  `signRawUnwatermarkedDeprecatedWithLegacyAccount`, which 0.15 added to
  `SigningClient`;
- `PublicTruApiClient` is missing the whole `renderer` domain, which 0.15 added.

Both are two-line fixes -- the second follows the file's existing `notModeled`
pattern -- but they are a sequencing dependency nobody had costed: the test-host
migration cannot start until product-sdk compiles against the newer protocol.

## 10. Test suites couple to the host's internals, and that is the real churn

Running `storage-demo` against the TrUAPI mock host, 6 of 8 tests passed
unmodified. The 2 that failed did so for the same reason, and it is the reason
that matters: they assert on `@parity/host-api-test-sdk`'s internal storage
keys, reading `localStorage.getItem("test-host:demo:mykey")` out of the host
page. That is a test coupled to one host's implementation rather than to product
behaviour, and no amount of API compatibility ports it.

The fix is to read through the control surface -- `getProductStorage()`, or
`findProductStorage(key)` on the fixture -- not to teach the new mock to fake
the old one's key scheme, which would bake another host's internals into ours.

**Budget ~25% assertion churn per suite**, and expect it to be concentrated in
tests that verify routing rather than behaviour.

## 11. Compiled artefacts silently lag their source

Three separate incidents in one session, each costing time and each looking like
a different bug:

- `worker-wasm-import.test.ts` failed against a stale `dist/`, and its own
  failure message said so;
- rebuilding the WASM broke both bridge tests with
  `callbacks.workerDemandChanged must be a function` -- a raw bridge callback
  outside the generated `RequiredHostCallbacks`, so `tsc` cannot see it, and the
  old bundle predated the requirement. The tests had been passing against an
  older core;
- the served test-host bundle lacked `getHostCallCount` because `dist/`
  predated it.

`dist/` and `dist/wasm/` are gitignored build outputs with no freshness check.
Rebuild before trusting any test that reads them, and treat "it passed before my
change" as evidence about the artefact rather than about the source.

### The wider pattern: the check was not checking

Four instances, and the shape is worth naming because three of them produced a
**false pass**, which is far more dangerous than a false failure. A broken clone
reporting missing files announces itself; a green check that verified the wrong
thing does not.

- The `REQUIRE_WASM` guard lived in one of three suites, so rewriting that one
  test would have silently disabled the gate for the other two.
- A mutation check on a stream **hung** instead of reddening, so it taught
  nothing while also being able to hang CI.
- A `git apply --check` chained with `&&` reported success because the shell was
  checking the exit status of the following command, not of `git apply`.
- The stale artefacts above: suites passing against a bundle older than the
  source they were meant to exercise.

When a check passes, confirm it *can* fail. Every guard in this work was
mutation-tested for that reason.

## 12. The core caches a decided permission, by design

After a permission is decided for a `(product, permission)` pair, the core
persists the answer and short-circuits on it: `host_logic/permissions.rs:379`
keys the decision on `CoreStorageKey::device_permission_authorization` and reads
it back before prompting, with a test at :702 named
`check_or_prompt_device_caches_grant`.

The consequence for testing is sharp and easy to lose an afternoon to: **a grant
made after a denial does not take effect, and the second call never reaches the
host at all.** The mock's `permissionLog` stays at one entry, because the core
answered from its own storage.

This explains product-sdk's two skipped `signing-rejected` tests. Their comment
blames caching in product-sdk; the caching is in the *core*, and it is
deliberate. No test host can make those tests pass — not this one, not
`host-api-test-sdk` — without either a core change to per-call permissions or
the tests changing shape. They are a known constraint rather than a gap.

The same mechanism appears elsewhere with a coarser key: `IdentityDisclosure`'s
durable grant is keyed by `product_id` alone with no capability discriminator,
so one cached decision answers a finer-grained question.

## 13. The test host now runs the production topology

**Resolved.** The test host runs the core in a Web Worker by default, the same
way a production web host does. What follows is what it took, kept because the
constraint explains the shape of the fix.

The worker runtime supported pairing hosts only: `worker-runtime.ts` hardcoded
`new wasm.WasmPairingHostRuntime(...)` in its `init` handler and had no signing
references, while a test host needs a signing host to own dev accounts. The
change is additive, so a host written before it behaves exactly as it did:

- `init` gained an optional `role?: "pairing" | "signing"`; omitted means
  pairing;
- one new `MainToWorker` kind, `activateLocalSession { requestId, secret }`,
  shaped like the existing `activateExternalSession`, reusing the
  `handleSessionActivation` helper and its response;
- `createWebWorkerPairingHostRuntime` gained a `role` option and an
  `activateLocalSession` method;
- the init handler branches on role, and says so plainly when a bundle has no
  signing host rather than failing on an undefined constructor.

One thing deliberately **not** changed: the worker imports its WASM glue as a
literal specifier so bundlers resolve it statically, which is why the production
`web` bundle works at all. Making that dynamic would change how every web host
loads its core. The test host's server instead redirects the specifier at bundle
time, so only the test host loads the `testing` bundle.

The two topologies expose the core differently -- a worker hands back a wire
provider, the main thread a product core -- so the host page normalises both to
one "pipe this port" step. `topology: "main-thread"` remains available for
debugging.

**Both topologies produce identical suite results**: 22 of 22 across the
chain-free suites, and signer-demo's same 3 failures, which confirms those are
not topology-related.

## 13a. Superseded: how the gap looked before it was closed

Production web hosts run the core in a Web Worker
(`createWebWorkerPairingHostRuntime`). The test host runs it on the page's main
thread. That is not a preference: **the worker runtime supports pairing hosts
only** -- `worker-runtime.ts` hardcodes `new wasm.WasmPairingHostRuntime(...)`
in its `init` handler and contains no signing references -- while a test host
needs a signing host to own dev accounts and sign locally.

So today the choice is production topology *or* local signing, not both. The
main-thread fixture is the deliberate trade.

Closing it is small but not free, and it is protocol work on a surface every web
host uses:

- an optional `role?: "pairing" | "signing"` on the existing `init` message
  (additive; a host that omits it behaves exactly as now);
- one new `MainToWorker` kind, `activateLocalSession { requestId, secret }`,
  an exact clone of the existing `activateExternalSession { requestId, blob }`;
- no new response kind -- `handleSessionActivation` already covers it;
- one branch in the `init` handler to pick the runtime class.

The Rust side is already done: `WasmSigningHostRuntime` exists at
`wasm.rs:1139` and the `testing` WASM bundle already carries it. There is no way
to avoid the change and keep signing, because the worker's only session entry
point is `activateExternalSession`, which needs a real pairing handshake.

## 14. Every product suite, run against the TrUAPI mock host

Nine suites, real browser, real codec-2 core, real wire. Results, and the cause
of every failure rather than a count:

| Suite | Result | Why the failures fail |
| --- | --- | --- |
| storage-demo | **8/8** | 2 assertions read the old host's internal keys |
| keys-demo | **8/8** | 1 assertion, same cause |
| host-demo | **6/6** | 1 assertion, same cause |
| signer-demo | 6/9 | 3 distinct causes, below |
| statement-store-demo | 1/10 | 9 die on missing API, before reaching the store |
| tx-demo | 0/7 (1 skipped) | chain: submit, finalization, dispatch error |
| chain-client-demo | 0/2 | chain: boot gates on a live client |
| contracts-demo | 0/2 (4 skipped) | chain |
| cloud-storage-demo | 0/0 (7 skipped) | already skipped upstream |

**22 of 22 pass across the three chain-free suites.** The churn to get there was
4 assertion rewrites out of 22 tests -- **18%** -- and every one had the same
cause: reading `localStorage.getItem("test-host:…")` out of the host page. Not
one was a behavioural difference. The migration is mechanical, not semantic.

`tx-demo`, `chain-client-demo` and `contracts-demo` produced **no** "is not a
function" errors, so those tests genuinely reach the chain path and fail there.
`statement-store-demo` is the opposite and the distinction matters: its 9
failures are `testHost.clearStatements is not a function`, one layer *before*
the store. Reporting those as "fails on chain" would be wrong.

### signer-demo's three, none of which are churn

- **permission rejection** -- blocked by the core's permission caching
  (section 12). The test revokes `ChainSubmit` and reconnects expecting a fresh
  prompt; the core answers from its own storage and never asks the host. Not
  fixable by any test host.
- **persistence across a page reload** -- the mock's storage is in-memory per
  host-page load, where `host-api-test-sdk` used browser `localStorage`, which
  survives a reload. A real behavioural difference, and a deliberate one: the
  mock keeps no state outside the process that created it.
- **stable product account across a host account switch** -- in TrUAPI a product
  account derives from the session root, so switching the active account
  *changes* it. `host-api-test-sdk` pinned it with a `productAccounts` mapping,
  which made it stable. The test encodes that mapping's behaviour rather than
  the protocol's.

### Two fixture gaps this surfaced

- `productId` must match the identifier the product signs with. The core rejects
  a signing request whose account is scoped to a different product, and it
  surfaces as `PermissionDenied` rather than as a config error. The fixture now
  takes `productId`; without it, signer-demo failed 2 tests for a reason that
  looked like a permission problem.
- The permission log is now shaped as `{ tag, value, approved, kind }`, matching
  `host-api-test-sdk`'s `PermissionLogEntry`, because suites assert on those
  field names.

## 15. What the mock will not pretend to do

Three domains throw a descriptive error on any access rather than returning a
plausible value, so a test reaching for them learns why instead of silently
passing against a fake:

- `payment` and `coinPayment` -- the protocol declares them and no host
  implements them (section 9).
- `statements` -- the core owns the statement store and submits it over the
  people chain, so there is no host seam to record or inject through. This is
  why `statement-store-demo` cannot pass without chain support, and stating it
  as an explicit limit is the difference between "the method does not exist" and
  "this needs a chain".

## 16. Live chain: what host-api-test-sdk actually does, and what we now do

`host-api-test-sdk` does two different things under the word "chain":

- **statement store: it fakes it entirely in JS.** `handleStatementStoreSubmit`
  pushes to an in-memory array and matches topics against subscribers. No chain
  is involved, which is why those ten tests looked chain-free there.
- **everything else: it proxies a live public testnet**, opening
  `wss://paseo-asset-hub-next-rpc.polkadot.io` lazily on first connection. It
  does not simulate a chain at all.

The mock now supports the second, opt-in, through `chainProxies`. Default stays
hermetic: nothing reaches the network unless a suite asks. Use `liveChain()`,
which builds the proxy, the reported chain set and the runtime config's genesis
from one value -- they have to agree, and the product checks the last two.

**Proven:** `chain-client-demo` 2/2 against the real Asset Hub, and `tx-demo`'s
boot test passes with `Chain client ready (assetHub, bulletin, individuality)`.

### Two things this surfaced

**Pinned genesis hashes rot, and every published one is already stale.** The
chain reports `0x4349b00e…` today. `host-api-test-sdk` pins `0xbf0488db…` at
0.11.0 and `0x23e730eb…` at 0.12.1 -- *neither* matches, so its own suites would
fail the descriptor check against this endpoint now. Our proxy therefore routes
without a hash: an unhashed proxy takes every request, so a reset cannot break
routing. A hash is still needed in the *declared* config, because
`@parity/product-sdk-descriptors` refuses a host whose genesis disagrees with
the bundle it was built against; that one has to be re-pinned after a reset, and
`chain_getBlockHash(0)` reads the current value.

**Writes need funded accounts, and ours are not funded.** `tx-demo` now reaches
the chain and signs, then fails with `Invalid.Payment` -- no balance for the
fee. TrUAPI derives a product account per (session entropy, product id), so the
addresses differ from polkadot-js `//Bob` and are unfunded. `tx-demo.dot/0`
under the `alice` dev entropy is
`13B6hYAQJjAG37JuCYeszFhvD8rpVg49NQpHvmG2y4NcB6qP`. Funding is deterministic and
one-off per (account, product), but it is an operational step, not a code one.

So the boundary is: **live-chain reads work today; live-chain writes need those
addresses funded.**

## 17. Statement store: transport works, submission does not

Proxying the real people chain (`wss://paseo-people-next-system-rpc.polkadot.io`,
genesis `0x4a2b5b73…ad48`) connects the statement store. The demo boots to
"Statement store connected (host transport)" and
`statement_subscribeStatement` appears in `getSentRpc`, so subscription traffic
is real and observable.

Submission is not. Publishing fails with `Statement submission rejected: {}`
**inside the core, before any RPC is emitted** -- it needs a statement
allowance, which is a per-period budget. So there is nothing on the transport to
observe either, and `getSubmittedStatements` cannot be built as a recording over
`getSentRpc`.

The three controls therefore exist on the fixture and throw with that reason,
rather than being absent. A product author reaching for one gets an explanation
of which half is missing; before this they got
`testHost.clearStatements is not a function`, which reads like an unfinished
fixture rather than a boundary.

So the honest status is **"connects; submission needs an allowance"**, not
"needs chain support" -- a smaller and differently-shaped gap than it looked.

## 18. The tx-demo submit stall: three wrong leads, and what survives

Three confident diagnoses died here. Recording them because each was built on
evidence that looked stronger than it was, and the same reading error recurs.

**Wrong lead 1: the chain proxy.** The mock pooled one WebSocket per `rpcUrl`
while giving each lease its own reader, so three proxied chains numbered their
JSON-RPC ids from 1 onto one socket. That is a real defect -- every lease read
every other lease's frames, and `close()` leaked its listener -- and it is
fixed. It was **not** this symptom. After the fix the submit still does not
happen, and `getSentRpc` shows 0 transaction-related requests out of 24.

**Wrong lead 2: transaction construction.** `create_transaction` on the V5 path
needs chain metadata through `build_local_transaction`, so a park there looked
plausible. It is impossible. `capabilities/signing.rs` runs in this order:

1. normalize signer
2. `is_product_account_valid_for_caller` -> `PermissionDenied`, returns
3. `require_chain_submit` (:121)
4. `let Some(session) = ... current_session() else { return Rejected }` (:126)
5. `confirm_user_action(CreateTransaction)` (:131)
6. `authority.create_transaction` -> `build_local_transaction`

Step 5 precedes step 6, so construction cannot be entered without a
confirmation being recorded first. Zero reviews were recorded, so construction
was never reached.

Nothing between 3 and 5 can park, either. `require_chain_submit`
(`runtime.rs:622`) matches on the status and returns. `ChainSubmit` is not
`RemotePermission::Remote { domains }` (`host_logic/permissions.rs:82`), so
`check_or_prompt_remote` takes the no-domain branch: peek, prompt,
`persist_decision`, return -- the only await after the host answers is a storage
write the mock answers. And step 4 is **synchronous**: `current_session` at
`signing_host.rs:622` is `fn`, not `async fn`. It returns `Rejected`; it cannot
hang. The signing host's own `create_transaction` (`signing_host.rs:778`) raises
no confirmation at all, so a review can only come from step 5.

**Wrong lead 3: transaction broadcast.** `broadcast_transaction`
(`capabilities/chain.rs:217`) is the only `require_chain_submit` caller with no
confirmation after it and an unbounded chain await immediately following, which
made it the only shape fitting "permission approved, no review, real hang". It
did not run either -- see the host-call count below. It was the best available
explanation of an event that never happened.

**The permission log cannot attribute a call.** `require_chain_submit` has seven
call sites -- `capabilities/signing.rs` at :48, :121, :188, :278, :347, :407 and
`capabilities/chain.rs:227` (transaction broadcast). A single
`{"tag":"ChainSubmit","approved":true}` entry therefore says a chain-submitting
method ran, not *which*. Both wrong leads rested on reading it as if it named
`create_transaction`.

**Zero reviews is trustworthy, though.** `confirmUserAction`
(`create-mock-host.ts:718`) pushes the review on entry and returns the
configured answer immediately, so a recorded review cannot be lost to a park.
An empty log means the call never arrived.

**In the stalled run: not a hang, and not silent.** `submitAndWatch` carries a
`DEFAULT_TIMEOUT_MS` of 300_000 (`packages/tx/src/submit.ts:19`), armed at :108
*before* `signSubmitAndWatch` is called, so signing and submission both sit
inside the timed region; the only await outside it, `resolveTransaction`
(:30-36), cannot park for a plain extrinsic. Every probe before this one waited
45-90 seconds, and the suite's own assertion gives up at 90s. We were measuring
a five-minute budget with a one-minute stopwatch.

Run past it and the flow ends on its own, at 300s to the second:

```
[2:53:29] Submitting System.remark("Hello from tx-demo")…
[2:58:29] remark: error
[2:58:29] remark failed: Transaction timed out after 300s.
```

**What the transport did that time.** Sampling `getSentRpc` against a baseline
taken before the click, rather than only after it:

| | rpc | new methods |
| --- | --- | --- |
| baseline | 3 | `chainHead_v1_follow` x3 (one per chain) |
| t+30s | 18 | `header` x3, `storage` x6, `call` x6 |
| t+60s, t+120s | 18 | -- nothing -- |
| t+240s | 46 | `unpin` x21, `call` x2, `chainSpec_*` x3, `unfollow`, `follow` |
| t+330s | 46 | -- nothing -- |

So the submit is not inert. polkadot-api issues its pre-signing reads --
header for mortality, storage for the account nonce, runtime calls for
metadata -- and then stalls with them outstanding. At around t+240s the
chainHead subscription is torn down and rebuilt (`unfollow`, 21 `unpin`, a fresh
`follow`), and the submit never resumes across that rebuild. It just runs out
the clock.

**In that run the signer is never invoked.** Reviews stay at 0 throughout, so
`confirm_user_action` never fires and `create_transaction` never runs. The fault
is upstream of signing, in the chain reads. Permissions stay at 1 for the whole
run too -- and that 1 is present in the BASELINE, before the click. The
`ChainSubmit` entry every earlier theory was built on is a boot artefact. There
was never a post-click permission event to explain.

**Corrections to earlier readings, including the previous version of this
section.** "Never reaches the host" was wrong: 43 RPC requests go out after the
click. "A genuine hang" was wrong: the SDK's own timeout fires and the product
reports it. And a probe that sampled only after the click reported `18 total`,
which is exactly the t+30s plateau -- a pause read as a terminus.

**The stall is intermittent, and the later evidence contradicts the earlier.**
A full `pnpm test:e2e` run afterwards -- the same command CI runs -- shows
`tx-demo` reaching the signer and failing on fees:

```
Submitting System.remark("Hello from tx-demo")…
remark: signing
remark failed: Transaction failed before inclusion: Invalid.Payment
```

`remark: signing` means `create_transaction` ran, which means a confirmation was
raised and the host WAS reached. Not one 300s timeout appears anywhere in that
run. So the measured stall -- no host contact, no signer, a 300s expiry -- has
not reproduced, and it cannot be treated as this suite's behaviour.

That also settles section 16's `Invalid.Payment` as the normal outcome rather
than a stale pre-funding artefact, and it disposes of the idea that funding had
already happened: `Invalid.Payment` is the chain saying the account cannot pay,
so the derived addresses still hold no balance.

What remains unexplained is why one run never reached the host at all. Against a
public testnet that is most cheaply read as a transport or endpoint condition,
not a defect in this branch -- but it is unexplained, not explained away, and it
is worth recognising if a CI job goes red with a 300s timeout rather than
`Invalid.Payment`.

**Method note.** Every one of these leads died to an instrument, not to an
argument. `getSentRpc` killed the first by showing no transaction traffic after
the proxy fix; `getHostCallCount` killed the third by showing the click produced
no host activity at all. Both were built because we hit something we could not
see, and both paid for themselves within a day.

The recurring error is worth naming, because it happened four times.
`ChainSubmit` names a permission, not a caller. `getSigningLog` is a view of
`reviews`, not a second source. A boot-time entry is not a click-time event. A
plateau is not a terminus. One run against a public testnet is not a
behaviour -- the stall documented above did not survive contact with the next
full run. Each time a measurement was read as answering a
question it could not answer. Before a log localises a fault, check what it can
physically distinguish -- and sample it against a baseline, not once at the end.

The instruments also have to exist where they are used. `getHostCallCount` is on
`MockHost` but is not exposed on the Playwright fixture, so a host-call figure
quoted from a fixture-level probe has no source behind it. Either expose it or
stop citing it.

## 19. Wire codec 2 is an adoption prerequisite

> Superseded in part by section 22: the published fleet has since moved. The
> prerequisite below still holds; the survey of who meets it is out of date.

`@parity/truapi` 0.16.0 is the first release on wire codec 2; 0.13.1 before it
is codec 1, and the published versions jump straight from one to the other
(0.5.0 ... 0.13.0, 0.13.1, 0.16.0 -- there is no 0.14.x or 0.15.x). The
handshake refuses a mismatched codec, so a codec-1 product cannot talk to this
host at all.

Nothing published is on codec 2:

| | pins `@parity/truapi` | codec |
| --- | --- | --- |
| `product-sdk-host` 0.15.1 | `^0.7.0` | 1 |
| `product-sdk-host` 0.19.1 (latest) | `^0.13.1` | 1 |
| product-sdk monorepo catalog | `^0.13.1` | 1 |
| this test host | 0.16.0 | **2** |

A caret on a `0.x` version pins the minor, so `^0.13.1` cannot resolve 0.16.0.

**product-sdk main has since moved to `@parity/truapi` 0.16.0**, so it is on
codec 2 and resolves the client from npm. Earlier runs in the `psdk-e2e`
checkout leaned on a lock override pinning `@parity/truapi` at the 0.16.0
worktree; that is no longer needed, and a run on pristine main without it is
recorded below. What is still unpublished is `@parity/truapi-host` carrying
`./testing`, which is the one substitution any local verification has to make.

**What this means for the failed t3rminal trial.** t3rminal resolves
`@parity/truapi` 0.7.0 through `product-sdk-host` 0.15.1 -- codec 1. Every host
call goes unanswered and expires on the product's own 5s timeout, so the app
parks at "Connecting to host..." and every locator times out. That is not a
defect in this test host: a real TrUAPI host refuses the same handshake. It
also means the trial's 1-passed/15-failed was never a like-for-like comparison,
because `@parity/host-api-test-sdk` has no `@parity/truapi` dependency and no
codec constant at all -- being a reimplementation rather than the core, it
answers whatever a product sends, at any wire version.

By the same resolution `host-playground` and `playground-app` are codec 1 too.
Read their versions from the REMOTE manifest, not a local clone: this laptop's
`host-playground` declares `product-sdk-host ^0.10.0` against individual
packages, while `main` declares the umbrella `@parity/product-sdk 0.27.0`,
which resolves `product-sdk-host` 0.19.1 -> `@parity/truapi ^0.13.1`. Same
verdict, very different distance -- one ordinary bump to 0.28.0 rather than a
multi-generation migration. Local checkouts in this tree are stale enough to
invert that judgement, so verify against the remote before quoting a number.

**So the adoption order has a step before the one the PR body used to name:**
product-sdk has to move its catalog to `@parity/truapi` 0.16.0 and re-release,
and only then can a consumer adopt the fixture. A `@parity/truapi-host` release
carrying `./testing` is necessary but not sufficient.

### The block is symmetric, and only one host works past it

The codec boundary was assembled locally to test this, with no release: copy
`@parity/truapi` 0.16.0 and the monorepo's built `product-sdk` packages into
`t3rminal/node_modules`. Running its suite twice, changing nothing but the
fixture:

| t3rminal, codec-2 stack | result | wall clock |
| --- | --- | --- |
| `@parity/truapi-host/testing` | **9 passed / 7 failed** | 3.8m |
| `@parity/host-api-test-sdk` | **1 passed / 15 failed** | 21.1m |

On the codec-1 stack the same suite gives 7/16 on `host-api-test-sdk` and 1/16
here. So neither host crosses the boundary, and the earlier reading -- that this
test host regressed six of t3rminal's tests -- was comparing two different
stacks. Hold the stack fixed and the result inverts.

That makes this more than a replacement. `host-api-test-sdk` reimplements the
protocol rather than running the core, and it reimplemented codec 1; it cannot
serve a product built against 0.16.0, and its 21 minutes are 30-second locator
timeouts. Once product-sdk moves, this is the only one of the two that
functions, so the fixture is what unblocks that upgrade rather than something
to adopt after it.

Seven t3rminal specs still fail here. Comparing failure sets by test id: six of
the seven fail on `host-api-test-sdk` too, and three specs that fail there pass
here (`home` twice, `history`) -- so the net is +3/-1. The one that fails only
here (`enters decimal amount`) times out on `terminal-header` exactly like the
other six, so it is the same root cause rather than a distinct defect.

That root cause is not the host. The terminal page gates on a resource
allocation the host cannot grant: the console shows `requestResourceAllocation
failed` and `PreimageSubmit ... Polkadot host is not ready`, on both hosts.
`ResourceAllocation` is a `UserConfirmationReview` variant, so the mock does
answer it; what is missing is a real allowance, which is core-owned. Same
boundary as the statement store, and not closable by adding a control method.

### Like-for-like across products

Every row holds the tree and the stack fixed and changes only the fixture.

**product-sdk, nine suites, main at `@parity/truapi` 0.16.0 from npm** -- the
baseline reverts every `e2e/` source so it is main as it ships, not a half-
migrated tree (reverting only the fixtures would leave the rewritten specs
calling `findProductStorage`, which the old package does not have, and would
fail for the wrong reason). Failures per suite:

| suite | `host-api-test-sdk` | this test host |
| --- | --- | --- |
| storage-demo | 8 | **0** |
| keys-demo | 8 | **0** |
| host-demo | 6 | **0** |
| signer-demo | 9 | **0** |
| chain-client-demo | 2 | **0** |
| cloud-storage-demo | 0 | 0 |
| contracts-demo | 2 | 2 |
| statement-store-demo | 10 | 9 |
| tx-demo | 6 | 3 |
| **suites** | **1 pass / 8 fail** | **6 pass / 3 fail** |

The single suite passing on `host-api-test-sdk` is `cloud-storage-demo`, which
is skipped upstream, so it has no real passes against current main. The cause is
the handshake, not anything product-specific: `storage-demo`, the simplest
chain-free suite, dies on `page.waitForFunction: Test timeout` -- the host page
never becomes ready.

**Across the consumers:**

| product | `host-api-test-sdk` | this test host |
| --- | --- | --- |
| product-sdk, 9 suites @ truapi 0.16.0 | 1 / 8 | **6 / 3** |
| t3rminal, 16 tests, codec-2 stack | 1 / 15 (21m) | **9 / 7** (3.9m) |
| t3rminal, codec-1 stack (its own) | 7 / 9 | 1 / 15 |
| host-playground * | -- | cannot run: `productAccounts`, `chain:` |
| playground-app * | -- | cannot run: `productAccounts`, `accounts: [{uri}]` |

\* Measured against the LOCAL clones, which diverge from their remotes -- this
tree's `host-playground` carries a different manifest shape entirely, and its
`playground-app` has twice the spec count. Treat both rows as "a fixture of
this shape cannot run", not as a verdict on what those repos hold today.

The third row is what keeps this honest: on t3rminal's own old stack the old
package wins 7 to 1. Neither host crosses the codec boundary. But product-sdk
main is now past it, and on that side `host-api-test-sdk` cannot serve the SDK
its own consumers are about to install.

The last two rows are a blocker rather than a result. Both fixtures fail at
construction on options this host rejects by design, so neither has ever been
measured; that is suite-side rework, not a host gap.

**Reproducing it.** Copy, do not symlink: Next will not resolve a linked
package outside the project root, which fails as `Module not found` against the
package that is plainly present. The umbrella `@parity/product-sdk` also ships
no `dist` in the monorepo and has to be built first; `tsup`'s declaration step
fails, but the JavaScript emits and that is enough to run.

## 20. The consumer fleet: 34 repos, one of them adoptable today

A sweep of every repo depending on `@parity/host-api-test-sdk` -- found by
searching the org for the package in `package.json`, not only for its import,
which is what surfaces the private ones. 34 consumers. The four sitting on this
laptop are not a representative sample of them.

**One repo can connect today.** `browse` resolves `@parity/product-sdk` 0.28.0
-> `product-sdk-host` 0.20.0 -> `@parity/truapi` 0.16.0, so it is codec 2. Its
host setup is `createTestHostServer` in `app/tests/utils.ts`, it calls no
control method beyond `close()`, and its only rejected option is
`productAccounts`. It is the reference port.

**The other 33 are codec 1 and cannot connect at all.** They resolve
`@parity/truapi` 0.13.1 or lower, or carry no truapi dependency whatsoever.
`@parity/product-sdk-host` pins `@parity/truapi ^0.16.0` only from 0.20.0; at
0.19.1 it pins `^0.13.1`, and 0.3.0 / 0.6.1 declare no truapi at all. For those
repos a fixture edit changes nothing: every host call goes unanswered and the
suite fails on connection timeouts, which is the same signature as
host-playground#89.

### Blockers by reach

| blocker | repos |
| --- | --- |
| codec 1 -- resolves truapi <= 0.13.1, or none | **33 of 34** |
| `productAccounts` -- rejected by design | every repo with a fixture bar two |
| `chain:` -> `networks: [...]` | the older vintage only |
| a throwing control method | statements, payments, `setLoginBehavior` |
| `accounts: [{name, uri}]` | three repos |

`chain:` versus `networks:` is a vintage marker rather than a preference: the
option was renamed in `host-api-test-sdk`, so a consumer's spelling dates it.
Tooling has to accept both.

### `productAccounts` needs one answer, not thirty

Four independent sweeps found the same thing: every `productAccounts` site
carries a comment saying it exists to stop the host deriving
`//Alice//<dotns>/<n>`, and that the mapped account is FUNDED. It is not a
rename. TrUAPI derives a product account from (session root, product id), so a
migrated suite signs with an address nobody funded, and a write test hangs
rather than fails -- the failure mode playground-app's own guard was written to
prevent after a day lost to it.

This is the same wall `tx-demo`, `contracts-demo` and `playground-app` hit
independently. Solve it once, centrally, before any repo is touched.

### Several of these are not migrations

`localdot-community`, `master-of-coin`, `browse-legacy`, `mercado-community`,
`spotlight`, `polkadot-apps`, `host-api-example`, `trax-id` and
`polkadot-testnet-faucet` sit on `@novasamatech/host-api` 0.8.x-0.10.x with no
truapi anywhere. They need a client-SDK generation bump before the seam swap
means anything. `browse-legacy` never adopted `createTestHostFixture` at all.

### What is cheap

`w3s-apps`/`t3rminal-internal` and `festival`/`w3s-conference-app` are
near-identical forks -- one patch covers two repos each. `mercado-community`,
`terminal-community` and `productivity` pass only accepted options and call no
throwing method: pure SDK bumps.

### Two traps for whoever writes the migration tooling

`polkadot-testnet-faucet` has zero `*.spec.ts` -- its host tests are
`*.test.ts` with an inline fixture, so a script keyed on `*.spec.ts` skips it
silently. And `majority` carries a hand-rolled init-script shim that drops
legacy `Uint8Array` window frames to force the MessagePort transport; it must
be deleted on migration, not ported, or it will interfere with the codec-2
handshake.

**So the order is:** ship the release, consumers bump `@parity/product-sdk` to
0.28.0 or later, then the seam swap -- which is genuinely small for most of
them. Nothing in that sequence is blocked on this branch.

## 21. Two realms, and which one this serves

`@parity/host-api-test-sdk` is often described as "already on truapi". Reading
its source, that is true of its transport and false of its protocol, and the
distinction decides what compatibility with it can mean.

Its `src/browser/truapi-port-handoff.ts` says so directly: it serves two
channel generations -- `@novasamatech/host-api-wrapper` (truapi 0.3, raw
`Uint8Array` frames on window postMessage) and `@parity/truapi/sandbox`
(truapi 0.4, a transferred `MessagePort` after a `truapi-ready` ping) -- and
notes that "wire frames are identical on both channels". It wraps
`createIframeProvider` from `@novasamatech/host-container` and types its
provider as `@novasamatech/host-api`'s.

So the package adopted truapi's **channel handshake** so that
truapi-bootstrapped products could reach a host whose **protocol** is Nova's.
Its only `@parity/truapi` dependency is a devDependency at `^0.6.0`, used in
that one file. That is why its `SCALE_CODEC_PROTOCOL_ID` is 1 in every
published version, and why no dependency bump can make it serve codec 2: the
protocol changed underneath it, not the transport.

### What that means for compatibility

Adhering to `host-api-test-sdk` therefore means adhering to its **control
surface** -- `TestHostAPI`, the fixture options, the server options, the
exported constants and log-entry types. It does not mean adhering to its
protocol, which is the realm being left.

| | old realm | this test host |
| --- | --- | --- |
| protocol | `@novasamatech/host-api`, codec 1 | truapi, codec 2 |
| product channel | window frames **and** MessagePort | MessagePort only |
| host behaviour | reimplemented in TypeScript | the shipping Rust core |

The MessagePort path is the one current products take:
`@parity/truapi/sandbox` posts `truapi-ready` and waits for `truapi-init`
carrying a port, and `create-iframe-host.ts` answers exactly that. The legacy
window-frame channel is deliberately not served, and does not need to be --
a product old enough to use it is codec 1 and could not complete a handshake
anyway.

### What the new realm needed, and now has

- the full `TestHostAPI` control surface, guarded against regression
- the fixture options consumers actually pass, including `chain` as the older
  spelling of `networks`, so a suite of that vintage needs no edit
- `createTestHostServer` accepting host configuration, not just a port --
  the entry point four consumers use instead of the fixture
- both entry points sharing one URL builder, so an option cannot be added to
  one and forgotten by the other
- ESM and CommonJS, since a consumer without `"type": "module"` resolves the
  `require` condition

### What it deliberately does not carry over

`productAccounts` cannot be honoured: `product_keypair_with_owner`
(`runtime/signing_host.rs:323`) derives from the session root entropy, the
product id and the derivation index, entirely inside the core. A host cannot
supply that account, so the option is refused with the reason rather than
accepted and ignored.

`setLoginBehavior` belongs to a pairing host's login flow; this is a signing
host, which answers `request_login` with `AlreadyConnected`.

Neither is a gap to close. Both are the old realm's shape showing through.

## 22. What the two codec-2 products found

Two products ship on TrUAPI today. Running both against this host surfaced one
real compatibility gap and corrected two claims made earlier in this document.

### `window.__TEST_HOST__` is public surface, and the gap was the name

`@parity/host-api-test-sdk` publishes its control object on
`window.__TEST_HOST__`. That is documented surface, not an internal: it is in
that package's README, typed in its `dist/types.d.ts` as "Shape of
window.__TEST_HOST__ -- shared between browser bundle and Playwright fixture",
and its own Playwright fixture is a thin wrapper of `page.evaluate` calls over
it.

A suite that drives the host page directly, rather than through the fixture,
therefore names the global. browse does, in `navigateToTestHost`: it navigates
to the host URL and waits for `window.__TEST_HOST__` to appear. Against this
host that wait timed out on every spec that used it -- 19 of browse's 41 tests
failed and 22 never ran, all from one missing name.

This host already published the identical object, as
`window.__TRUAPI_TEST_HOST__`. The entire gap was the name, so the host page now
publishes both, and clears both on dispose. `test-host-surface.test.ts` asserts
the two names are assigned *the same identifier*, not merely that both are
assigned -- a copy would let them drift -- and carries a parse floor so a rename
that made the patterns match nothing cannot pass vacuously.

### The dependency range excluded the only version that worked

`truapi-host`'s generated adapter imports `HostPocketListSubscribeItem` and
`HostPocketRemoveCardRequest`. `@parity/truapi` 0.16.0 does not export either;
0.17.0 does. The package depended on `^0.16.0`, and for a 0.x version npm reads
that as `~0.16.0` -- so the declared range resolved only the line that lacks the
types, and could never reach the one that has them. The floor is now `^0.17.0`.

This corrects the earlier conclusion recorded here that no published
`@parity/truapi` could satisfy the adapter. 0.17.0 satisfies it. The defect was
one range in our own manifest, not a gap in the registry.

### Section 19's headline no longer holds

Section 19 says nothing published is on codec 2. `@parity/product-sdk-host`
0.21.0 pins `@parity/truapi` `^0.17.0`, and host-playground's main is on
`@parity/product-sdk` 0.29.0 above it. Installed from the registry with nothing
stood in, that tree resolves a single `@parity/truapi` 0.17.0 -- codec 2, from
npm. The prerequisite in section 19 is still the right prerequisite; the claim
that nothing meets it is out of date.

### A product account follows the host account (corrected in section 28)

This section previously claimed the opposite, on the strength of a probe that
could not have detected a change: it read the oldest log row rather than the
newest, so it compared the first result against itself. The refusal text's
original wording was right -- a switch does change the product account, on the
next call. Section 28 has the measurement and the three traps behind the error.

## 23. Three gaps host-playground closed, and the one it cannot

### Allowance allocation is compiled out of the wasm core

`account.get_user_id` and the notification log were fixable in the test host.
Resource allocation is not, and the reason is in the core rather than the mock:
`runtime/statement_allowance.rs` is declared `#[cfg(not(target_arch =
"wasm32"))]`, and all three allocators in `sso_responder.rs` carry a wasm32 stub
returning `NativeOnly`. `allocate_resources` catches that, logs it, and pushes
`AllocationOutcome::NotAvailable`, which the product renders as "Requested
resource is unavailable".

A native CLI host allocates allowances; the browser-hosted wasm core cannot.
Closing it means porting a 2,547-line native-only module to wasm32, which is a
Rust project rather than a test-host change. It accounts for 15 of
host-playground's failures: the four allowance flows, the four allocation
requests, and the statement, preimage, bulletin and contract-write tests that
each need an allowance first.

### The core's reasons were unreadable from a test

The core logs why a call failed before mapping it to a protocol answer, but by
default it runs in a Web Worker, whose console `page.on("console")` does not
observe. A failing call therefore arrived as a bare outcome with no reason
attached, which is how the allowance stub stayed hidden behind three wrong
guesses.

`topology` and `logLevel` are now fixture options. `"main-thread"` puts the core
on the page so its output reaches the page console; `logLevel` sets the level at
boot on either topology. With both, the diagnosis is one line:

```
WARN truapi_server::runtime::signing_host: direct resource allocation item failed
  {product_id=localhost:5199, reason=signing host: statement-store allowance allocation is native-only}
```

### A session had no name

`account.get_user_id` answered `Unknown { reason: "No primary username for this
session" }` because the test host activated sessions through
`activateLocalSession`, which leaves the session anonymous. The core has a
second entry point that takes one. The host page now activates under the active
account's name, matching what `@parity/host-api-test-sdk` answers. The worker
protocol's activation message carries the name so both topologies behave
identically.

### Notification ids started at zero

`getNotificationLog` returned the raw requests, with no `id` or `cancelled`, so
a suite could not assert that a cancel landed. Entries now carry the
`NotificationLogEntry` fields and `cancelled` flips in place on cancel.

The subtler half was the id. The counter started at 0, and a product that reads
0 as "no id" rejects it: host-playground validates the id as a positive integer,
so the first notification of every run was uncancellable. Ids start at 1.

## 24. browse's failures are not the migration's

browse fails 14 of 41 with 22 never reached. The cause is not the test host, and
a baseline settles it.

The host boots fine. Measured in browse's own harness, `window.__TEST_HOST__`
appears **69ms** after `goto`. What takes the time is the product: its
`.category-tab` ready selector resolves at **34.7s**, against a suite whose
per-test timeout is **10s**. So the failures are the app being slow to render,
not the host being slow to start.

Reverting browse to `@parity/host-api-test-sdk` 0.12.1 -- the original
`utils.ts` from git, that package linked back in -- and running the same
measurement, the old SDK does not reach a ready product frame **at all** within
180s. The suite is broken in this environment whichever host it runs against,
which is consistent with the dry PGAS funder in section 22: the app cannot
populate itself from a chain it has no funded account for.

Take the comparison as "the migration is not the cause", not as "the test host
is faster". One run each, on a network that was visibly degraded that day.

The lesson repeats: baseline the suite against its current host before
attributing a failure to the new one.

## 25. The allowance port was un-gating, not porting

Section 23 said closing the allowance gap meant porting a 2,547-line native-only
module to wasm32, and called it a Rust project rather than a test-host change.
That estimate was wrong, and wrong in a useful direction.

The module never needed porting. Its real dependencies were already
wasm-capable: `verifiable`, the ring-VRF prover, is an unconditional dependency
and was being compiled for wasm32 the whole time, and `subxt`/`subxt-rpcs` are
declared for wasm with their `web` feature. What kept the module out of the
browser was the `#[cfg(not(target_arch = "wasm32"))]` on its module declaration,
plus the same gate spread across the call path.

Removing the gate and compiling for wasm32 produced **11 errors**, not a port:

- `frame-metadata` and `scale-info` sat in the native-only dependency block,
  although metadata decoding is needed on both. They are now unconditional.
- `RpcClient::connect(url)` opens a socket by URL, which a browser cannot do
  from Rust. It is the one genuinely native-only piece, and it stays gated:
  `truapi-host-cli` uses it, and the browser gets its connection from the
  platform through `RpcClient::new`, which is what `chain_client` already did.
- `Instant::now()` and `SystemTime::now()` compile for wasm32 and panic when
  read. The crate already had the pattern -- `web_time` -- so the two allowance
  clocks now follow it.

The rest was lifting the gate off ~25 items that the allocators reach: the
renewal state on `SigningHost`, the chain-context cache on `RuntimeServices`,
`reserved_person_collection_candidates`, the RPC client accessors, and six
variants of `AllowanceAllocationError` whose constructors were all native-only.

The diff is 34 insertions against 89 deletions: mostly deleting the three
`NativeOnly` stubs and the gates. Native `cargo check`, `clippy -D warnings` and
the test suite are unchanged by it.

### What it revealed next

With the stub gone, allocation runs in the browser and reaches real chain reads.
The first failure after it was not a gap but a misconfiguration, and the logging
from section 23 is what showed it:

```
WARN statement_allowance: could not resolve this collection
  {collection=People, err=Members.Collections[People] missing}
```

Allowance registration reads personhood collections from the **People** chain,
and host-playground's fixture served only the hub. browse always passed
`[activeNetwork(), activePeopleChain()]`; host-playground now passes a
`paseo-people` network too. A suite that allocates allowances has to serve that
chain, which is a migration precondition rather than a defect.

## 26. Where the allowance path actually stops

With the wasm gates lifted, allocation runs the real path in the browser, and
two further problems surfaced in sequence. Each one was only visible because the
previous was fixed, which is the usual shape of this work.

### The hub was answering the People chain's reads

`fromNetworks` built every chain proxy without a genesis hash. That is right for
one chain -- an unhashed proxy takes every request, so a chain reset cannot
break routing -- but with a hub and a People chain both unhashed, the first
entry answered both. The core asked the People chain for personhood collections
and the hub replied that it has none:

```
WARN statement_allowance: chain reports a different genesis than the host configured
  {configured=4a2b5b73…(People), reported=4349b00e…(AssetHub)}
WARN statement_allowance: could not resolve this collection
  {collection=People, err=Members.Collections[People] missing}
```

Proxies are now hashed whenever there is more than one, and a lone proxy stays
unhashed for the reset-immunity that motivated it. The mock already supported
hash routing; only the fixture's expansion never used it.

### Dev accounts are not personhood ring members

With routing fixed, the People chain answers, collections resolve, ring scanning
runs, and the allocation stops on the condition that is actually true:

```
DEBUG statement_allowance: no ring includes our member key {collection=People}
WARN signing_host: direct resource allocation item failed
  {reason=signing account is not a personhood ring member;
   cannot grant statement-store allowance}
```

A statement-store allowance is granted against a proof of personhood ring
membership. The test host's accounts are derived from fixed dev entropy and are
not enrolled in any ring on the live People chain, so the proof cannot be built.
The core is behaving correctly; there is no key it could substitute.

This is the same shape as browse's dry PGAS funder in section 24: an on-chain
identity the suite must be given, not a gap the host can close. `@parity/host-api-test-sdk`
never met it because it had no core to enforce it -- it answered `Allocated`
without proving anything.

So a suite whose allowance specs passed against that package will not pass here
on dev accounts alone, and that is a true difference rather than a regression.
Closing it needs an enrolled identity on the target People chain, which belongs
with whoever owns that enrolment.

### The port did not move the pass count

host-playground before the port: 36 passed, 15 failed, 2 flaky. After it: **38
passed, 15 failed**, no flakes. The same fifteen specs fail, and the two signing
specs that were flaky are now stable.

What changed is the reason, not the score. Before, the fifteen failed because
the capability was compiled out of the wasm core and no configuration could have
reached it. Now they fail on an on-chain identity the accounts do not hold. The
first was ours to fix and is fixed; the second is not a defect at all.

Whether an enrolled identity turns those fifteen green is untested -- the
allocation stops at the membership proof, so nothing past that point has ever
run in the browser. Treat "enrol an identity and they pass" as the next
hypothesis to check, not as a result.

Re-measured after rebasing onto `origin/main` and rebuilding the wasm bundle:
**37 passed, 15 failed, 1 flaky**. The fifteen are the same specs; the drop from
38 is `signing-extended`, which flaked and passed on retry. Main's subscription
state-lock refactor and its extension of AutoSigning to the product signing APIs
and statement proofs moved nothing here, which was the change most likely to.

All of these are single runs against a live testnet, and `signing-extended`
shows the suite is not deterministic on it. The fifteen are dependable -- they
fail for one understood reason -- but read the pass count as plus or minus one.

## 27. What the allowance port changed about the statement-store refusal

The refusal behind `getSubmittedStatements`, `injectStatement` and
`clearStatements` said submission "is rejected inside the core before any RPC is
emitted". That was written when the allowance allocator was a wasm stub
returning `NativeOnly` immediately. Re-checked against the ported build by
running host-playground's statement specs and reading `getSentRpc`:

| claim | verdict |
| --- | --- |
| `statement_subscribeStatement` is visible | holds -- subscribe and unsubscribe both appear, the spec passes |
| rejected *before any RPC is emitted* | **false now** -- a submission emits 141 calls |
| submission unobservable on the transport | holds -- none of the 141 is a statement method |

The 141 are `state_getStorage` x134, `state_call` x3, `chain_getBlockHash`,
`state_getRuntimeVersion` and `chain_getFinalizedHead` x2: the allowance attempt
doing real chain work before it stops at ring membership.

So the refusal's conclusion survives and its stated mechanism did not. The text
now says no *statement* RPC reaches the chain, and warns that the failed
allowance attempt does show up as storage reads -- otherwise a reader debugging
a submission would be told to expect nothing in `getSentRpc` and find 141
entries.

The general point is worth keeping: an explanation that names a mechanism ages
with the mechanism. This one was accurate when written and became wrong without
anything editing it.

## 28. Auditing the rest of the refusals

Having found one refusal stale, the other five were checked the same way --
against the code they describe, and by probe where a probe could settle it.

| refusal | claim | verdict |
| --- | --- | --- |
| `NO_PAYMENT_SEAM` | every method in the core's payment capability errors and ignores its arguments | holds: all 13 return `Err` or `Subscription::interrupted`, every argument underscore-prefixed |
| `NO_CHAT_ACTION_SEAM` | `ChatPlatform` is create-room, register-bot, post-message and subscribe-rooms only | holds: exactly those four |
| `NO_DERIVATION_URI` | a session activates from 32 bytes of entropy; names are alice, bob, charlie, dave | holds: `entropyFor` fills 32 bytes, and those four are the roster |
| `LOGIN_BEHAVIOR_IS_CONSTRUCTION_TIME` | the host page reads it once at start | holds: `options.loginBehavior` is read at exactly one site, during boot |
| `NO_PINNED_PRODUCT_ACCOUNT` | see below | half wrong, in the half this document put there |

One near-miss worth recording: `ChatPlatform`'s fourth method is declared `fn`,
not `async fn`, so a grep for `async fn` reports three and makes the refusal look
one method too generous. It is not.

### The product-account claim: wrong twice, and the probe was the reason

The product account follows the host account. `switchAccount("charlie")` moves
`get_user_id` to charlie and the product's account from `0x2c981dbb...` to
`0xb44b7a93...` on the very next call -- no reconnect, no reload. That matches
`product_keypair_with_owner`, which derives from `root_entropy()`, the product
id and the derivation index against live shared state.

So the original wording -- expect a switch to change it, that is the real
behaviour -- was correct. This document replaced it twice and was wrong both
times: first with "stable across a host account switch", then, on finding that
unsupportable, by removing the claim entirely.

The cause was one bug in the probe, not in the host. The app **prepends** log
entries (`use-logs.ts`: `setLogs((prev) => [entry, ...prev])`), so the newest
row is `.first()`. Every probe read `.last()` -- the oldest row -- and therefore
compared the first result against itself. It reported "unchanged" no matter what
the host did, which is the worst kind of wrong: a measurement that cannot fail.

Two further traps sat on top of it, each producing its own false reading:

- `getActiveAccount` is `() => active?.name`, a variable on the host page. It
  reports what the page believes, not what the core did, so it cannot confirm a
  switch landed. `get_user_id` can, because the core answers it from the session.
- reloading the page to force a re-read re-boots the host, which re-activates the
  first roster entry and silently undoes the switch.

Worth carrying forward: when a probe reports "no change", check that it is
capable of reporting a change at all. Two of these three traps would have been
caught by asserting the before-value differs from a known-different control.

Note for anyone reading host-playground's helpers: its `runTest` also takes
`.last()`. That is safe there only because each test gets a fresh page and runs
one action, so the oldest row is the only row. A spec that calls it twice would
silently read the first result both times.

## Working notes

- **A fresh checkout does not compile.** `rust/crates/truapi-server/src/generated/` is
  gitignored and generated on demand, so `cargo test` fails with
  `error[E0583]: file not found for module 'generated'`. Run `./scripts/codegen.sh`
  (~2 min). Not `make codegen` — that also runs a playground `yarn install`.
- Read `origin/main` in product-sdk and host-api-test-sdk. Both working trees are on
  feature branches behind shipped (158 commits and 5 commits respectively), and both
  have already produced wrong answers when read directly.
- Never share `CARGO_TARGET_DIR` between worktrees.
