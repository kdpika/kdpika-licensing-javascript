// Isolated public-member conformance exercise, NOT a production access client.
// The ephemeral key signs synthetic in-memory data for an injected transport.
// It is never trusted by KDPika, written to disk, printed or used on the network.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {LicenseClient, LicenseResult, canonicalJson} from "@kdpika/license-sdk";

const covered = [];
const check = (member, condition) => { assert.ok(condition, `Member example failed: ${member}`); covered.push(member); };
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "kdpika-members-"));
fs.chmodSync(temporary, 0o700);
try {
  let now = new Date("2026-10-17T12:00:00Z"), mode = "online", releaseCalls = 0;
  const pair = crypto.generateKeyPairSync("ed25519");
  const publicBytes = pair.publicKey.export({type: "spki", format: "der"}).subarray(-32);
  const key = {key_id: "ed25519_example", algorithm: "Ed25519", public_key: publicBytes.toString("base64url")};
  let client;
  const signed = () => {
    const payload = {product_id: "YOUR_APP_ID", environment: "sandbox", status: "active",
      device: {installation_hash: crypto.createHash("sha256").update(client.installationId).digest("hex")},
      features: {pdf_export: true, seat_count: 2}, server_time: "2026-10-17T12:00:00Z",
      next_validation_at: "2026-10-18T12:00:00Z", offline_grace_until: "2026-10-20T12:00:00Z",
      expires_at: "2026-11-17T12:00:00Z"};
    return {payload, signature: crypto.sign(null, Buffer.from(canonicalJson(payload)), pair.privateKey).toString("base64url"),
      algorithm: "Ed25519", key_id: key.key_id};
  };
  const fetchImpl = async (url, options) => {
    const endpoint = new URL(url).pathname;
    assert.equal(new URL(url).origin, "https://licenses.example.invalid");
    assert.ok(options.signal instanceof AbortSignal);
    if (mode === "network") throw new Error("Synthetic transport outage");
    let body;
    if (endpoint === "/api/v1/public-key") body = {success: true, key};
    else if (endpoint === "/api/v1/licenses/deactivate") { releaseCalls++; body = {success: true, deactivated: true}; }
    else if (mode === "rejected") return {ok: false, status: 403, json: async () => ({success: false, error: {code: "LICENSE_REVOKED", message: "Example refusal"}})};
    else body = {success: true, activation_token: "UNUSABLE_EXAMPLE_TOKEN", license: signed(), request_id: "req_example"};
    // The actual SDK deliberately requires act_ at activation. This unusable,
    // local-only test value cannot be accepted by a real KDPika token lookup.
    if (endpoint === "/api/v1/licenses/activate") body.activation_token = "act_example_not_a_real_credential";
    return {ok: true, status: 200, json: async () => body};
  };
  client = new LicenseClient({product: "YOUR_APP_ID", environment: "SANDBOX", baseUrl: "https://licenses.example.invalid",
    storageDir: temporary, verificationKey: key, fetchImpl, clock: () => now});
  check("LicenseClient.constructor", client instanceof LicenseClient);
  for (const name of ["product", "environment", "baseUrl", "applicationName", "applicationVersion", "verificationKey",
    "timeoutMs", "fetchImpl", "clock", "storageDir", "installationId"]) check(`LicenseClient.${name}`, client[name] !== undefined);
  check("LicenseClient.activated", !client.activated);
  check("LicenseClient.token", client.token() === null);
  check("LicenseClient.now", client.now().toISOString() === now.toISOString());
  check("module.canonicalJson", canonicalJson({b: [1, true], a: "value"}) === '{"a":"value","b":[1,true]}');
  const example = new LicenseResult({valid: false, source: "example", payload: {features: {pdf_export: true, seat_count: 2}},
    errorCode: "EXAMPLE_ONLY", message: "Example", requestId: "req_example", signatureValid: false, storageSecurity: "unknown"});
  check("LicenseResult.constructor", Object.isFrozen(example));
  for (const [name, expected] of Object.entries({valid: false, source: "example", errorCode: "EXAMPLE_ONLY", message: "Example",
    requestId: "req_example", signatureValid: false, storageSecurity: "unknown"})) check(`LicenseResult.${name}`, example[name] === expected);
  check("LicenseResult.payload", example.payload.features.pdf_export === true);
  check("LicenseResult.feature", example.feature("pdf_export") && !example.feature("missing"));
  check("LicenseResult.featureValue", example.featureValue("seat_count") === 2 && example.featureValue("missing", 7) === 7);
  check("application.fail_closed", !(example.valid && example.signatureValid && example.feature("pdf_export")));
  check("LicenseClient.error", client.error("EXAMPLE_ONLY", "Example", "local").valid === false);
  check("LicenseClient.responseError", client.responseError({body: {error: {code: "INVALID_TOKEN", message: "Example"}}}).errorCode === "INVALID_TOKEN");
  const response = await client.request("GET", "/api/v1/public-key", null, {});
  check("LicenseClient.request", response.ok && response.status === 200 && response.body.key.algorithm === "Ed25519");
  check("LicenseClient.getVerificationKey", (await client.getVerificationKey(signed())).key_id === key.key_id);
  check("LicenseClient.verified", (await client.verified(signed(), "online")).signatureValid);
  await client.saveState(signed());
  check("LicenseClient.saveState", client.readJson("signed-state.json").signed_license.algorithm === "Ed25519");
  client.checkpoint();
  check("LicenseClient.checkpoint", client.readJson("signed-state.json").last_seen_at === now.toISOString());
  check("LicenseClient.offline", (await client.offline()).valid);
  client.writeJson("example.json", {local_example: true});
  check("LicenseClient.writeJson", fs.existsSync(path.join(client.storageDir, "example.json")));
  check("LicenseClient.readJson", client.readJson("example.json").local_example === true);
  client.atomicWrite("example.txt", "unusable local text");
  check("LicenseClient.atomicWrite", fs.readFileSync(path.join(client.storageDir, "example.txt"), "utf8") === "unusable local text");
  client.remove("example.txt");
  check("LicenseClient.remove", !fs.existsSync(path.join(client.storageDir, "example.txt")));
  const activated = await client.activate("TEST-UNUSABLE-EXAMPLE", "synthetic@example.invalid");
  check("LicenseClient.activate", activated.valid && activated.signatureValid && client.activated);
  check("LicenseClient.check", (await client.check()).source === "cache");
  check("LicenseClient.validate", (await client.validate()).source === "online");
  check("LicenseClient.feature", await client.feature("pdf_export"));
  const beforeRelease = releaseCalls;
  await client.bestEffortDeactivate("UNUSABLE_EXAMPLE_TOKEN");
  check("LicenseClient.bestEffortDeactivate", releaseCalls === beforeRelease + 1);
  now = new Date("2026-10-18T13:00:00Z"); mode = "network";
  assert.equal((await client.validate()).source, "offline");
  now = new Date("2026-10-21T12:00:00Z");
  assert.equal((await client.validate()).errorCode, "OFFLINE_GRACE_EXPIRED");
  now = new Date("2026-10-17T11:54:59Z");
  assert.equal((await client.offline()).errorCode, "CLOCK_ROLLBACK_DETECTED");
  now = new Date("2026-10-19T12:00:00Z"); mode = "rejected";
  assert.equal((await client.validate()).errorCode, "LICENSE_REVOKED");
  assert.equal(client.activated, false);
  mode = "online";
  assert.equal((await client.activate("TEST-UNUSABLE-EXAMPLE")).valid, true);
  const released = await client.deactivate();
  check("LicenseClient.deactivate", released.valid && !released.signatureValid && !client.activated);
  console.log(JSON.stringify({result: "PASS", members: covered, mode: "injected synthetic signing/transport; zero HTTP",
    access_granted: false, additional_cases: ["offline", "grace-expired", "clock-rollback", "explicit-revocation"]}));
} finally {
  // Only the exact fresh scratch directory from mkdtempSync is removed.
  fs.rmSync(temporary, {recursive: true});
}
