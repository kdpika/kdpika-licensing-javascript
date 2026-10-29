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
    if(["redeem","packs","checkout","history"].includes(op)){
      assert.equal(options.headers['X-Installation-ID'],installation);assert.ok(body.fingerprint);
      if(op==="redeem"){
        if(body.code!=="KDP100CR")return reply({success:false,error:{code:"CREDIT_CODE_UNAVAILABLE"}},422);
        const k=body.idempotency_key,old=state.ledger.get(k);let r;
        if(old)r={...old,replayed:true};else{state.balance+=100;r={id:"ctx_redeem_fixture",type:"grant",amount:100,balance_after:state.balance,total_allocated_after:105,idempotency_hash:crypto.createHash("sha256").update("code:"+crypto.createHash("sha256").update(k).digest("hex")).digest("hex"),replayed:false};state.ledger.set(k,r);}
        if(state.drop){state.drop=false;throw Error("lost response");}
        return reply({success:true,license:signed(r),transaction_id:r.id,added:999,balance:999,replayed:r.replayed});
      }
      return reply({success:true,license:signed(null),packs:op==="packs"?[{id:"cpk_fixture",units:100}]:undefined,checkout_url:op==="checkout"?"https://store.example.test/?kdpika_credit_checkout=opaque":undefined,transactions:op==="history"?[]:undefined});
    }
    if(op==="deactivate")return reply({success:true,deactivated:true});
    if(op==="consume"){
      const key=body.idempotency_key,old=key?state.ledger.get(key):null,amount=body.amount;
      if(old&&old.amount!==-amount)return reply({success:false,error:{code:"IDEMPOTENCY_CONFLICT"}},409);
      if(!old&&state.balance<amount)return reply({success:false,error:{code:"INSUFFICIENT_CREDITS"},balance:state.balance,license:signed(null)},402);
      let receipt;if(old)receipt={...old,replayed:true};else{state.balance-=amount;receipt={id:`ctx_fixture_${state.ledger.size}`,type:"consume",amount:-amount,balance_after:state.balance,total_allocated_after:5,idempotency_hash:key===null?null:crypto.createHash("sha256").update(key).digest("hex"),replayed:false};if(key)state.ledger.set(key,receipt);}
      if(state.drop){state.drop=false;throw new Error("response lost");}
      return reply({success:true,license:signed(receipt),balance:receipt.balance_after+Number(state.tamper),consumed:amount,transaction_id:receipt.id,replayed:receipt.replayed});
    }
    return reply({success:true,activation_token:"act_fixture_only",license:signed(null)});
  };
  const client=new LicenseClient({product:"app_fixture",environment:"SANDBOX",storageDir:directory,clock:()=>now,fetchImpl,verificationKey:{key_id:"ed25519_fixture",public_key:publicKey}});
  t.after(()=>{client._floating.stop();t.mock.restoreAll();syncBuiltinESMExports();Object.defineProperty(process,"platform",descriptor);fs.rmSync(directory,{recursive:true,force:true});});
  return {client,state};
}
test("credit codes use signed units and replay the original grant",async t=>{const {client,state}=fixture(t);await client.activate("FIXTURE");const result=await client.redeemCredits("KDP100CR","redeem-test-1");assert.equal(result.added,100);assert.equal(result.balance,105);assert.equal((await client.redeemCredits("KDP100CR","redeem-test-1")).replayed,true);assert.equal(state.balance,105);});
test("lost redemption response is retried explicitly with the same reference",async t=>{const {client,state}=fixture(t);await client.activate("FIXTURE");state.drop=true;await assert.rejects(client.redeemCredits("KDP100CR","lost-test-1"),e=>e.code==="NETWORK_ERROR");assert.equal(state.balance,105);assert.equal((await client.redeemCredits("KDP100CR","lost-test-1")).replayed,true);});
test("packs checkout history and bad codes stay scoped",async t=>{const {client}=fixture(t);await client.activate("FIXTURE");assert.equal((await client.creditPacks()).packs[0].units,100);assert.ok((await client.createCreditCheckout("cpk_fixture")).checkout_url.startsWith("https://store.example.test/"));assert.deepEqual((await client.creditHistory()).transactions,[]);await assert.rejects(client.redeemCredits("WRONGCODE","bad-test-1"),e=>e.code==="CREDIT_CODE_UNAVAILABLE");});
