import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {LicenseClient, canonicalJson} from "../src/index.js";

test("activation, signature, cache, offline grace and deactivation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kdpika-js-sdk-"));
  const keys = crypto.generateKeyPairSync("ed25519");
  const rawPublic = keys.publicKey.export({format:"der",type:"spki"}).subarray(-32).toString("base64url");
  let now = new Date("2026-10-10T12:00:00Z"), mode = "online", calls = [];
  const signed = installationId => {
    const payload = {license_id:"lic_test",product_id:"app_test",product:"Test",plan:"pro",status:"active",environment:"sandbox",expires_at:new Date(now.getTime()+30*86400000).toISOString(),features:{pdf_export:true,seat_count:5},device:{id:"dev_test",installation_hash:crypto.createHash("sha256").update(installationId).digest("hex"),name:"Test",platform:"test",app_version:"1.0"},server_time:now.toISOString(),next_validation_at:new Date(now.getTime()+86400000).toISOString(),offline_grace_until:new Date(now.getTime()+7*86400000).toISOString()};
    const fingerprint=calls.find(call=>call.body?.fingerprint)?.body.fingerprint;
    payload.device.fingerprint={...fingerprint,policy:{mode:"fuzzy",min_matches:2}};
    payload.floating=null;
    Object.assign(payload,{metered:false,credit_balance:0,total_allocated:0,credit_transaction:null});
    return {payload,signature:crypto.sign(null,Buffer.from(canonicalJson(payload)),keys.privateKey).toString("base64url"),algorithm:"Ed25519",key_id:"ed25519_test"};
  };
  const fetchImpl = async (url, options={}) => {
    const endpoint = new URL(url).pathname, body = options.body ? JSON.parse(options.body) : null; calls.push({endpoint,body,headers:options.headers});
    if (mode === "network" && endpoint.endsWith("/validate")) throw new Error("offline");
    let response;
    if(endpoint.endsWith("/public-key"))response={success:true,key:{algorithm:"Ed25519",key_id:"ed25519_test",public_key:rawPublic}};
    else if(endpoint.endsWith("/activate"))response={success:true,activation_token:"act_test_token",license:signed(body.device_id),request_id:"req_activate"};
    else if(endpoint.endsWith("/validate"))response={success:true,license:signed(options.headers["X-Installation-ID"]),request_id:"req_validate"};
    else response={success:true,deactivated:true,request_id:"req_deactivate"};
    return {ok:true,status:200,json:async()=>response};
  };
  const client = new LicenseClient({product:"app_test",environment:"SANDBOX",baseUrl:"https://licenses.example.test",applicationName:"JS SDK Test",storageDir:root,fetchImpl,clock:()=>now});
  const activated=await client.activate("TEST-AAAA-BBBB-CCCC","customer@example.test");assert.equal(activated.valid,true);assert.equal(activated.signatureValid,true);assert.equal(activated.feature("pdf_export"),true);
  const before=calls.length,cached=await client.check();assert.equal(cached.source,"cache");assert.equal(calls.length,before);
  now=new Date(now.getTime()+25*3600000);mode="network";const offline=await client.check();assert.equal(offline.valid,true);assert.equal(offline.source,"offline");
  now=new Date(now.getTime()+8*86400000);const expired=await client.validate();assert.equal(expired.valid,false);assert.equal(expired.errorCode,"OFFLINE_GRACE_EXPIRED");
  mode="online";now=new Date("2026-10-10T12:00:00Z");const deactivated=await client.deactivate();assert.equal(deactivated.valid,true);assert.equal(client.activated,false);
});
