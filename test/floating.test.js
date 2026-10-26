import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import childProcess from "node:child_process";
import {syncBuiltinESMExports} from "node:module";
import {LicenseClient,AllSeatsInUseError,canonicalJson} from "../src/index.js";
import {hashComponents} from "../src/fingerprint.js";
import {FloatingState,leaseValid} from "../src/floating.js";

function fixture(t) {
  const descriptor=Object.getOwnPropertyDescriptor(process,"platform");
  Object.defineProperty(process,"platform",{value:"win32",configurable:true});
  const raw={baseboard:"FIXTURE-BOARD",cpu:"FIXTURE-CPU"};
  t.mock.method(childProcess,"execFileSync",()=>JSON.stringify(raw));syncBuiltinESMExports();
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"kdpika-floating-"));
  const pair=crypto.generateKeyPairSync("ed25519"),publicKey=pair.publicKey.export({format:"der",type:"spki"}).subarray(-32).toString("base64url");
  const state={now:new Date("2026-10-24T12:00:00Z"),held:false,full:false,offline:false,missingOnce:false,badHash:false,calls:[],sessionToken:"flt_"+"A".repeat(43)};
  const fingerprint={...hashComponents("app_fixture",raw,false),policy:{mode:"strict",min_matches:2}};
  let installation;
  const reply=(body,status=200)=>({ok:status===200,status,json:async()=>body});
  const refusal=code=>reply({success:false,error:{code,message:"Shared seat unavailable."}},409);
  const fetchImpl=async(url,options)=>{
    const op=new URL(url).pathname.split("/").at(-1),body=JSON.parse(options.body??"null");state.calls.push({op,body});
    if(state.offline)throw new Error("offline");
    if(op==="activate")installation=body.device_id;
    if(op==="checkout") {if(state.full)return refusal("ALL_SEATS_IN_USE");state.held=true;}
    if(op==="heartbeat"&&state.missingOnce) {state.missingOnce=false;state.held=false;return refusal("SESSION_NOT_FOUND");}
    if(op==="checkin") {state.held=false;return reply({success:true,checked_in:true});}
    if(op==="deactivate") {state.held=false;return reply({success:true,deactivated:true});}
    if(op==="validate"&&!state.held)return refusal("SESSION_NOT_FOUND");
    const session=state.held?{id:"ses_fixture",token_hash:state.badHash?"0".repeat(64):crypto.createHash("sha256").update(state.sessionToken).digest("hex"),checked_out_at:state.now.toISOString(),last_heartbeat_at:state.now.toISOString(),expires_at:new Date(+state.now+600000).toISOString()}:null;
    const payload={product_id:"app_fixture",environment:"sandbox",status:"active",expires_at:null,features:{export:true},metered:false,credit_balance:0,total_allocated:0,credit_transaction:null,
      device:{installation_hash:crypto.createHash("sha256").update(installation).digest("hex"),fingerprint},server_time:state.now.toISOString(),
      next_validation_at:new Date(+state.now+86400000).toISOString(),offline_grace_until:new Date(+state.now+7*86400000).toISOString(),
      floating:{max_concurrent_sessions:1,heartbeat_interval_seconds:180,session_timeout_seconds:600,session}};
    const payload_json=canonicalJson(payload);
    return reply({success:true,activation_token:"act_fixture_only",session_token:state.sessionToken,
      license:{payload,payload_json,signature:crypto.sign(null,Buffer.from(payload_json),pair.privateKey).toString("base64url"),algorithm:"Ed25519",key_id:"ed25519_fixture"}});
  };
  const client=new LicenseClient({product:"app_fixture",environment:"SANDBOX",storageDir:directory,fetchImpl,clock:()=>state.now,verificationKey:{key_id:"ed25519_fixture",public_key:publicKey}});
  t.after(()=>{client._floating.stop();client.remove("floating-session.json");t.mock.restoreAll();syncBuiltinESMExports();Object.defineProperty(process,"platform",descriptor);fs.rmSync(directory,{recursive:true,force:true});});
  return {client,state};
}
const activate=async client=>{const result=await client.activate("SYNTHETIC-FLOATING-LICENSE");assert.equal(result.valid,true);assert.equal(result.feature("export"),true);return result;};

test("activation auto-checkout, stable session token, one timer, validation binding",async t=>{
  const {client,state}=fixture(t);const result=await activate(client),timer=client._floating.timer;
  assert.equal(result.payload.floating.session.id,"ses_fixture");assert.ok(timer);assert.equal(timer.hasRef(),false);
  assert.equal((await client.checkout()).valid,true);assert.equal((await client.checkout()).valid,true);
  assert.equal(client._floating.timer,timer);assert.equal(client.sessionToken(),state.sessionToken);
  assert.equal((await client.validate()).valid,true);assert.equal(state.calls.at(-1).body.session_token,state.sessionToken);
});
test("parallel operations in one client reuse seat without racing local files",async t=>{
  const {client,state}=fixture(t);await activate(client);
  const replies=await Promise.all([client.checkout(),client.heartbeat(),client.validate()]);
  assert.ok(replies.every(reply=>reply.valid));assert.equal(client.sessionToken(),state.sessionToken);
});
test("explicit full-seat checkout raises typed error and invalidates retained result",async t=>{
  const {client,state}=fixture(t);const held=await activate(client);state.full=true;
  await assert.rejects(client.checkout(),AllSeatsInUseError);
  assert.equal(held.feature("export"),false);assert.equal(client.sessionToken(),null);
});
test("heartbeat re-checkouts once after missing server session",async t=>{
  const {client,state}=fixture(t);await activate(client);state.missingOnce=true;
  assert.equal((await client.heartbeat()).valid,true);assert.deepEqual(state.calls.slice(-2).map(call=>call.op),["heartbeat","checkout"]);
});
test("validation recovers after server cleanup",async t=>{
  const {client,state}=fixture(t);await activate(client);state.held=false;
  assert.equal((await client.validate()).valid,true);assert.equal(state.calls.at(-1).op,"checkout");
});
test("lease expiry denies cached/offline and held feature access before offline grace",async t=>{
  const {client,state}=fixture(t);const held=await activate(client);state.offline=true;
  state.now=new Date(+state.now+599000);assert.equal((await client.validate()).valid,true);assert.equal(held.feature("export"),true);
  state.now=new Date(+state.now+1000);assert.equal(held.feature("export"),false);
  const denied=await client.validate();assert.equal(denied.errorCode,"SESSION_EXPIRED");assert.equal(denied.feature("export",true),false);
});
test("checkin invalidates local grant even if network release fails",async t=>{
  const {client,state}=fixture(t);const held=await activate(client);state.offline=true;
  assert.equal((await client.checkin()).errorCode,"NETWORK_ERROR");assert.equal(held.feature("export"),false);
  assert.equal(client.sessionToken(),null);assert.equal(client._floating.timer,null);
  assert.equal(fs.existsSync(path.join(client.storageDir,"signed-state.json")),false);
});
test("close and checkin free the seat while retaining activation",async t=>{
  const {client,state}=fixture(t);const held=await activate(client);await client.close();
  assert.equal(state.held,false);assert.equal(client.activated,true);assert.equal(held.feature("export"),false);
  assert.equal((await client.checkout()).valid,true);assert.equal((await client.checkin()).valid,true);
});
test("wrong signed session hash never grants access",async t=>{
  const {client,state}=fixture(t);state.badHash=true;const result=await client.activate("SYNTHETIC-FLOATING-LICENSE");
  assert.equal(result.valid,false);assert.equal(result.errorCode,"SESSION_EXPIRED");assert.equal(client.sessionToken(),null);
});
test("timer invokes heartbeat at signed interval; graceful exit invokes close",async t=>{
  const {client}=fixture(t);await activate(client);client._floating.stop();
  const callbacks=[],delays=[];let beats=0,closed=0;
  t.mock.method(globalThis,"setTimeout",(callback,delay)=>{callbacks.push(callback);delays.push(delay);return {unref(){}};});
  t.mock.method(globalThis,"clearTimeout",()=>{});
  t.mock.method(client,"heartbeat",async()=>{beats++;return {valid:false,errorCode:"ALL_SEATS_IN_USE"};});
  t.mock.method(client,"close",async()=>{closed++;});
  const timer=new FloatingState(client);timer.start({heartbeat_interval_seconds:180});
  await callbacks[0]();assert.equal(beats,1);assert.deepEqual(delays,[180000]);assert.equal(client.lastFloatingError,"ALL_SEATS_IN_USE");
  timer.shutdown();await Promise.resolve();assert.equal(closed,1);timer.stop();
});
test("missing/malformed floating policy fails closed",()=>{
  assert.equal(leaseValid({},"flt_"+"A".repeat(43),new Date()),false);
  assert.equal(leaseValid({floating:null},null,new Date()),true);
  assert.equal(leaseValid({floating:{max_concurrent_sessions:true,session:{}}},"test",new Date()),false);
});
