import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import childProcess from "node:child_process";
import {syncBuiltinESMExports} from "node:module";
import {LicenseClient,CreditOperationError,InsufficientCreditsError,canonicalJson} from "../src/index.js";
import {hashComponents} from "../src/fingerprint.js";

function fixture(t){
  const descriptor=Object.getOwnPropertyDescriptor(process,"platform");Object.defineProperty(process,"platform",{value:"win32",configurable:true});
  const raw={baseboard:"FIXTURE-BOARD",cpu:"FIXTURE-CPU"};t.mock.method(childProcess,"execFileSync",()=>JSON.stringify(raw));syncBuiltinESMExports();
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"kdpika-credits-")),pair=crypto.generateKeyPairSync("ed25519");
  const publicKey=pair.publicKey.export({format:"der",type:"spki"}).subarray(-32).toString("base64url"),fingerprint={...hashComponents("app_fixture",raw,false),policy:{mode:"strict",min_matches:2}};
  const state={balance:5,ledger:new Map(),calls:[],offline:false,drop:false,tamper:false,badSignature:false,otherTenant:false,metered:true};
  const now=new Date("2026-10-24T12:00:00Z");let installation;
  const reply=(body,status=200)=>({ok:status===200,status,json:async()=>body});
  const signed=receipt=>{
    const payload={license_id:"lic_fixture",product_id:state.otherTenant?"app_other_tenant":"app_fixture",environment:"sandbox",status:"active",expires_at:null,
      features:{export:true},floating:null,metered:state.metered,credit_balance:state.balance,total_allocated:5,credit_transaction:receipt,
      device:{installation_hash:crypto.createHash("sha256").update(installation).digest("hex"),fingerprint},server_time:now.toISOString(),next_validation_at:new Date(+now+3600000).toISOString(),offline_grace_until:new Date(+now+7*86400000).toISOString()};
    const payload_json=canonicalJson(payload);
    return {payload,payload_json,signature:state.badSignature?Buffer.alloc(64).toString("base64url"):crypto.sign(null,Buffer.from(payload_json),pair.privateKey).toString("base64url"),algorithm:"Ed25519",key_id:"ed25519_fixture"};
  };
  const fetchImpl=async(url,options)=>{
    const op=new URL(url).pathname.split("/").at(-1),body=JSON.parse(options.body??"null");state.calls.push(op);if(state.offline)throw new Error("offline");
    if(op==="activate")installation=body.device_id;
    if(op==="deactivate")return reply({success:true,deactivated:true});
    if(op==="consume"){
      const key=body.idempotency_key,old=key?state.ledger.get(key):null,amount=body.amount;
      if(old&&old.amount!==-amount)return reply({success:false,error:{code:"IDEMPOTENCY_CONFLICT"}},409);
      if(!old&&state.balance<amount)return reply({success:false,error:{code:"INSUFFICIENT_CREDITS"},balance:state.balance,license:signed(null)},402);
      let receipt;if(old)receipt={...old,replayed:true};else{state.balance-=amount;receipt={id:`ctx_fixture_${state.ledger.size}`,type:"consume",amount:-amount,balance_after:state.balance,total_allocated_after:5,idempotency_hash:key===null?null:crypto.createHash("sha256").update(key).digest("hex"),replayed:false};if(key)state.ledger.set(key,receipt);}
      if(state.drop){state.drop=false;throw new Error("response lost");}
      return reply({success:true,license:signed(receipt),balance:receipt.balance_after+Number(state.tamper),consumed:amount,transaction_id:receipt.id,replayed:receipt.replayed});
    }
    if(op==="validate"&&state.metered&&state.balance===0)return reply({success:false,error:{code:"INSUFFICIENT_CREDITS"},balance:0,license:signed(null)},402);
    return reply({success:true,activation_token:"act_fixture_only",license:signed(null)});
  };
  const client=new LicenseClient({product:"app_fixture",environment:"SANDBOX",storageDir:directory,clock:()=>now,fetchImpl,verificationKey:{key_id:"ed25519_fixture",public_key:publicKey}});
  t.after(()=>{client._floating.stop();t.mock.restoreAll();syncBuiltinESMExports();Object.defineProperty(process,"platform",descriptor);fs.rmSync(directory,{recursive:true,force:true});});
  return {client,state};
}
test("last-credit receipt succeeds, replay is historical, fresh balance is zero",async t=>{
  const {client,state}=fixture(t);assert.equal((await client.activate("CREDIT-FIXTURE")).valid,true);
  const first=await client.consume(2,"first-job-fixture");assert.equal(first.balance,3);assert.equal(first.replayed,false);
  assert.equal((await client.consume(3,"last-job-fixture")).balance,0);
  const replay=await client.consume(2,"first-job-fixture");assert.equal(replay.replayed,true);assert.equal(replay.transactionId,first.transactionId);assert.equal(replay.balance,3);
  assert.equal(await client.getBalance(),0);assert.equal(state.ledger.size,2);
  const zero=await client.validate();assert.equal(zero.errorCode,"INSUFFICIENT_CREDITS");assert.equal(zero.signatureValid,true);assert.equal(zero.feature("export",true),false);
});
test("zero activation preserves credentials; top-up needs no reactivation",async t=>{
  const {client,state}=fixture(t);state.balance=0;assert.equal((await client.activate("CREDIT-FIXTURE")).errorCode,"INSUFFICIENT_CREDITS");assert.equal(client.activated,true);
  assert.equal(await client.getBalance(),0);state.balance=3;assert.equal(await client.getBalance(),3);
});
test("typed insufficient error, conflict and no double charge",async t=>{
  const {client,state}=fixture(t);await client.activate("CREDIT-FIXTURE");
  await assert.rejects(client.consume(6,"overdraw-fixture"),e=>e instanceof InsufficientCreditsError&&e.balance===5&&e.code==="INSUFFICIENT_CREDITS");assert.equal(state.ledger.size,0);
  await client.consume(1,"conflict-fixture");await assert.rejects(client.consume(2,"conflict-fixture"),e=>e.code==="IDEMPOTENCY_CONFLICT");assert.equal(state.balance,4);
});
test("metered checks bypass cache; offline checks and consumes fail closed",async t=>{
  const {client,state}=fixture(t);await client.activate("CREDIT-FIXTURE");assert.equal((await client.check()).source,"online");assert.equal(state.calls.at(-1),"validate");
  state.offline=true;const offline=await client.check();assert.equal(offline.valid,false);assert.equal(offline.errorCode,"METERED_ONLINE_REQUIRED");assert.equal(offline.feature("export",true),false);
  await assert.rejects(client.consume(1,"offline-fixture"),e=>e.code==="NETWORK_ERROR");await assert.rejects(client.getBalance(),CreditOperationError);
});
test("uncertain outcome has no automatic retry; explicit same-key retry replays",async t=>{
  const {client,state}=fixture(t);await client.activate("CREDIT-FIXTURE");state.drop=true;await assert.rejects(client.consume(2,"durable-job-fixture"));assert.equal(state.balance,3);assert.equal(state.ledger.size,1);
  assert.equal((await client.consume(2,"durable-job-fixture")).replayed,true);assert.equal(state.balance,3);
});
test("signed and unsigned tampering and tenant mismatch cannot produce receipts",async t=>{
  const {client,state}=fixture(t);await client.activate("CREDIT-FIXTURE");state.tamper=true;await assert.rejects(client.consume(1,"tampered-fixture"),e=>e.code==="INVALID_RECEIPT");
  state.tamper=false;state.badSignature=true;await assert.rejects(client.consume(1,"signature-fixture"),e=>e.code==="SIGNATURE_INVALID");state.badSignature=false;state.otherTenant=true;
  await assert.rejects(client.consume(1,"tenant-fixture"),e=>e.code==="SIGNATURE_INVALID");
});
test("amounts and request keys validated before sending; ordinary licenses supported",async t=>{
  const {client,state}=fixture(t);for(const amount of [0,-1,1.5,true,"1",9007199254740992])await assert.rejects(client.consume(amount,"invalid-fixture"),TypeError);
  await assert.rejects(client.consume(1,"bad key"),TypeError);assert.equal(state.calls.length,0);
  state.metered=false;assert.equal((await client.activate("ORDINARY-FIXTURE")).valid,true);await assert.rejects(client.getBalance(),e=>e.code==="NOT_METERED_LICENSE");
});
test("one client serializes parallel credit calls and preserves replay receipt",async t=>{
  const {client,state}=fixture(t);await client.activate("CREDIT-FIXTURE");const [a,b]=await Promise.all([client.consume(1,"parallel-fixture"),client.consume(1,"parallel-fixture")]);
  assert.equal(a.transactionId,b.transactionId);assert.equal(a.replayed,false);assert.equal(b.replayed,true);assert.equal(state.balance,4);
});
