# KDPika Licensing JavaScript SDK

## Desktop / Web plan controls — 2.2.0

This source adds Business-only per-software-plan app access: `desktop`, `web`, or `both`. Starter and Pro automatically allow both under the same App ID and cannot create app-specific restrictions. It applies equally to subscriptions, one-time purchases and lifetime access. Devices/seats/credits belong to the same license; choosing both does not double its limits.

Configure the host application, not a customer-editable field:

```
new LicenseClient({product: "YOUR_APP_ID", applicationType: "web", storageDir: "/private/web-license"})
```

Default: desktop. Configure the other app with the same App ID and key, its own context and private state folder. SDK storage namespaces include the context. All activation/validation/seat/credit requests send `X-Application-Type`, and the SDK checks signed `application_access` plus `application_type` on network and cached results. A scope-restricted license cannot activate without declaring a context. Errors: APPLICATION_NOT_ALLOWED, APPLICATION_TYPE_REQUIRED, APPLICATION_TYPE_MISMATCH, INVALID_APPLICATION_TYPE. Releasing a machine/seat remains possible after a restriction change.

Context is a declaration by trusted application code, not browser/hardware attestation. A user who controls executable code can modify it; valuable online operations need server-side authorization too. Offline clients learn changed policies only on reconnect and must obey the old signed deadline until then. Browser/WASM hardware fallback remains unsupported.

[Download the source ZIP](https://licensing.kdpika.com/docs/downloads/kdpika-javascript-sdk-2.2.0.zip) · [Desktop / Web setup and migration](https://licensing.kdpika.com/docs/v1/licensing/application-access)

## Install from npm

```sh
npm install @kdpika/license-sdk@2.2.0
```


Official SDK **2.2.0** for signed licensing, hardware binding, floating seats, metered credits and Desktop / Web access controls.

[Documentation](https://licensing.kdpika.com/docs/v1/sdks/javascript) · [Published package](https://www.npmjs.com/package/@kdpika/license-sdk/v/2.2.0) · [Download SDK ZIP](https://licensing.kdpika.com/docs/downloads/kdpika-javascript-sdk-2.2.0.zip)

## Supported licensing capabilities

| Capability | Behavior |
|---|---|
| Signed checks and offline access | Verify Ed25519 results; access never extends beyond signed expiry/offline policy. |
| Device matching | Required product-salted hardware hashes and X-Installation-ID; verify the signed device binding. Raw serials are not sent. |
| Floating licenses | Checkout, heartbeat and checkin with signed lease deadlines; handle ALL_SEATS_IN_USE. |
| Usage credits | Online-only consume with a persisted idempotency key; query balance and handle INSUFFICIENT_CREDITS. |
| Customer portal | Hosted self-service portal managed by the server, not an SDK payment or account feature. |

Advanced matching, floating seats, credits and portal availability depend on your workspace plan. Browser/WASM hardware fingerprint fallback is unsupported. Test on your target OS and in Sandbox before distributing your app.

## Install

```sh
npm install ./kdpika-license-sdk-2.2.0.tgz
```

Version 2.2.0 is published in its official package registry. Versioned source downloads and local package installation remain available.


## Release limitations and trust boundary

Version 1.0.1 verifies the server's exact `payload_json` signed bytes, fixing integral-float and Unicode cache round trips. Feature helpers reject invalid, unsigned or out-of-date decisions; keep the explicit validity/signature gate. Older envelopes use the canonical fallback: refresh an incompatible legacy cache online. Never bypass verification. Historical signing-key overlap is not implemented.

Your own store handles software-buyer payments. KDPika Licensing bills only your developer platform subscription. Package/import names remain unchanged for compatibility. No registry publication is implied by this local-download README. The short host-application excerpts are not a complete application; the upcoming documentation phases must supply executed, standalone samples before treating them as a quickstart.

Contact: [hi@kdpika.com](mailto:hi@kdpika.com). [Current documentation](https://licensing.kdpika.com/documentation), [security controls](https://licensing.kdpika.com/#security), [service health check](https://licensing.kdpika.com/healthz).

<!-- P7-QUALITY:START -->
## Complete integration guide and source distribution

Read the complete guide at https://licensing.kdpika.com/docs/v1/sdks/javascript.
The public documentation describes actual source versions, local install steps,
every constructor/member, synchronous/async behavior, storage, offline policy,
logging, framework integration, packaging, upgrades and removal. Downloads are
source packages with SHA-256 checksums; registry publication is not verified.

Use Sandbox explicitly in tests. An App ID is public; lmp_ developer keys belong
only on your trusted backend. Keep a random stable installation ID and private
state outside executable extraction/public web directories. A token-presence
property, HTTP200, true feature helper or successful deactivation is not a
current access grant. Require valid and signature verification before features.

### Current release limitations

Python 1.1.5 and PHP/JavaScript/C# 1.0.1 include the Phase 1 signed-response
and feature-guard protections. PHP requires8.2+; PHP8.5 can emit curl_close
deprecation. Old1.0.0 caches may require an online refresh. Never disable
Ed25519, strip signed fields or extend offline permission.
The complete guides provide source-derived boundaries and test vectors.

Python can prefer an installed usable OS keyring; Node/PHP/C# use permission-
protected files, not automatic encrypted vaults. Local machine owners can patch
an app. No universal OS/anti-tamper/security-certification guarantee is made.

### Package tests and examples

The examples folder contains exact documented session/member sources plus layout
instructions. Existing package tests use synthetic signing/transports; run real
Sandbox lifecycle and public verification vectors as separate acceptance tests.

Run `npm test` after installing the local package.

See LICENSE for existing license-information boundaries and CHANGELOG.md for verified observations; neither implies an invented public registry release.
<!-- P7-QUALITY:END -->


## Credit codes and store top-ups

These APIs require the matching credit-commerce server update and WooCommerce connector 0.8.0 or later. An active signed online license remains usable at zero credits. Included features and paid operations are separate.

| Language | Available packs | Redeem a code | Store checkout | History | Publisher-priced job |
|---|---|---|---|---|---|
| Python | `credit_packs()` | `redeem_credits(code, request_key)` | `create_credit_checkout(pack_id)` | `credit_history()` | `consume_action(action, request_key, expected_units)` |
| JavaScript (Node/Electron) | `creditPacks()` | `redeemCredits(code, requestKey)` | `createCreditCheckout(packId)` | `creditHistory()` | `consumeAction(action, requestKey, expectedUnits)` |
| Rust | `credit_packs()` | `redeem_credits(code, request_key)` | `create_credit_checkout(pack_id)` | `credit_history()` | `consume_action(action, request_key, expected_units)` |
| PHP | `creditPacks()` | `redeemCredits(code, requestKey)` | `createCreditCheckout(packId)` | `creditHistory()` | `consumeAction(action, requestKey, expectedUnits)` |
| C# | `CreditPacksAsync()` | `RedeemCreditsAsync(code, requestKey)` | `CreateCreditCheckoutAsync(packId)` | `CreditHistoryAsync()` | `ConsumeActionAsync(action, requestKey, expectedUnits)` |

Persist the request key **before** redeeming or consuming. If the response is lost, explicitly retry that same operation with the same key; never create another charge to recover it. Redemption units and balance are read from the signed response. Open `checkout_url` in the normal browser, never embed a developer API key in an app, and refresh the signed balance after returning. Pack prices are estimates; WooCommerce confirms tax, coupons and the actual payable amount.

`CREDIT_CODE_UNAVAILABLE` covers unknown, expired, exhausted or ineligible codes without exposing another account's promotion. `CREDIT_PRICE_CHANGED` makes the app refresh the price and ask for confirmation. `CREDIT_REVIEW_REQUIRED` blocks paid jobs pending publisher review, not the license's included features. Credit consumption remains online-only.


## Two practical apps — choose how you learn

Both examples remain available; Sudoku Studio does not replace License Lab.

| Example | Open or download | What it teaches |
|---|---|---|
| Original License Lab (PHP) | [Open demo](https://licensing.kdpika.com/license-lab) | Real license activation, signed replies, offline rules, devices and seats |
| Sudoku Studio (PHP web app) | [Open app](https://licensing.kdpika.com/sudoku-studio) · [Source ZIP](https://licensing.kdpika.com/docs/downloads/kdpika-sudoku-studio-php-1.0.0.zip) · [Step-by-step guide](https://licensing.kdpika.com/docs/v1/tutorials/php/sudoku) | A usable puzzle app with exports, plan features, crown balance, codes and store top-ups on the same license |
| Sudoku Studio (Python desktop) | [Source ZIP](https://licensing.kdpika.com/docs/downloads/kdpika-sudoku-studio-python-1.3.0.zip) · [Guide](https://licensing.kdpika.com/docs/v1/tutorials/python/desktop) | A PyQt6 desktop app; App ID, email/key and Live/Test are entered in the window |

![Sudoku Studio PHP application](https://licensing.kdpika.com/assets/sudoku/studio-preview.png)

The web app uses the PHP SDK; the desktop app uses the Python SDK. These are app examples, not claims that this package runs another language. The same credit endpoints are supported by all five SDKs. Enter your own software license in the UI, never a platform administration key. JPG is included, PNG uses `png_export`, collections use `batch_generation`, and paid packs use the publisher-priced `create_pack` action. Promotional code KDP100CR is an example: the publisher creates it before it can be redeemed.

A zero balance keeps included tools available. Real store payment confirmation grants units to the original license once; SDK requests cannot grant themselves credits. GitHub hosts the example source/download links, and this package-registry page includes the same guide.
