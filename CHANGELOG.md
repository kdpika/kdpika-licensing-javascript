# Current release: 2.0.0

- Required signed hardware binding, floating checkout/heartbeat/checkin and online idempotent usage credits.
- Updated installation, source links and cross-language capability documentation.
- Customer portal remains hosted; browser hardware fallback is unsupported.

# Package observations and documentation changes

## 2.0.0 — 2026-10-26

- Require product-salted hardware hashes and verify signed device/installation binding.
- Add floating checkout, heartbeat and checkin with signed lease expiry and seat exhaustion.
- Add online-only credit balance/consume, idempotent receipts and insufficient-credit errors.
- Breaking pre-launch server contract; older published clients are not compatible.
- Registry availability is recorded separately; a changelog is not proof of publication. Ed25519 is unchanged.

## Usage credits included in the current release

- Add online consume/getBalance, signed frozen receipts, request-key replay checks,
  and typed InsufficientCreditsError. No automatic consume retries.
- Require signed credit policy, preserve zero-balance activations for top-up, and
  deny cached/offline metered access. No package publication in this phase.

## Floating seats included in the current release

- Add serialized checkout/heartbeat/checkin and automatic signed-interval renewal,
  missing-session recovery and explicit graceful close.
- Enforce signed seat deadlines and private token binding for offline/cached access.
- Export AllSeatsInUseError for explicit checkout; no dependencies or publication.

## Unreleased — required hardware binding

- Collect product-salted component hashes in Node/Electron main, without dependencies.
- Send required fingerprints on activation/validation and enforce the signed matching
  policy for cached/offline grants. Raw identifiers are never stored or transmitted.
- Pre-launch breaking contract; no package publication or downloadable ZIP update yet.

## 1.0.1 — 2026-10-21

- Feature access fails closed for invalid, unsigned or out-of-date decisions, including enabling defaults. Positive numeric flags match Python semantics.
- Verify the additive API v1 `payload_json` exact signed bytes; use their decoded fields as authoritative. Fix PHP integral-float and cached Unicode round trips without bypassing Ed25519.
- Clear cached access on malformed or rejected validation; require a confirmed deactivation. Do not follow HTTP redirects with licensing requests.
- Existing envelopes remain supported through the canonicalization fallback. Refresh online to replace a legacy incompatible cache. No new runtime dependencies.

## 1.0.0 — observed current source, 2026-10-17

This is the version recorded in current package/project metadata (PHP uses the
existing versioned download label). It is not a reconstructed original release
date, a published registry release or an invented earlier-version history.

- Added complete source-install, lifecycle, storage/offline and known-limit
  documentation, license-information notice and runnable example links.
- Preserved runtime implementation, public APIs, response handling and package
  identity. Documentation changes do not silently fix known signing/cache gaps.
- PHP includes a new package-local standalone test entry; its legacy repository
  test remains unchanged and still assumes the repository-root autoload layout.

Future entries must identify the exact version, verified changes, compatibility
impact and tests. API v1 and SDK package versions are independent.
