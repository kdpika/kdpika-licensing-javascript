# KDPika Licensing JavaScript SDK

Official SDK **2.0.0** for the current KDPika API contract.

[Documentation](https://licensing.kdpika.com/docs/v1/sdks/javascript) · [Download SDK ZIP](https://licensing.kdpika.com/docs/downloads/kdpika-javascript-sdk-2.0.0.zip)

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
npm install ./kdpika-license-sdk-2.0.0.tgz
```

For JavaScript and C#, local package/source downloads are available; npm/NuGet publication is separate and must be confirmed before using a registry-only install command.


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
