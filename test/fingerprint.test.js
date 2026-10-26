import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import childProcess from "node:child_process";
import {syncBuiltinESMExports} from "node:module";
import {LicenseClient,canonicalJson} from "../src/index.js";
import {hashComponents,collectFingerprint,matchesBinding} from "../src/fingerprint.js";

const raw={baseboard:"TEST-BOARD-PRIVATE",cpu:"TEST-CPU-PRIVATE",disk:"TEST-DISK-PRIVATE"};
const bound=(fp,mode="strict",minimum=2)=>({...fp,policy:{mode,min_matches:minimum}});

function fixture(t) {
  const originalPlatform=Object.getOwnPropertyDescriptor(process,"platform");
  Object.defineProperty(process,"platform",{value:"win32",configurable:true});
  let current={...raw};
  t.mock.method(childProcess,"execFileSync",()=>JSON.stringify({...current,model:"Virtual Machine"}));
  syncBuiltinESMExports();
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"kdpika-fingerprint-"));
  t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();Object.defineProperty(process,"platform",originalPlatform);fs.rmSync(root,{recursive:true,force:true});});
  const pair=crypto.generateKeyPairSync("ed25519"),publicKey=pair.publicKey.export({format:"der",type:"spki"}).subarray(-32).toString("base64url");
  const state={offline:false,reject:false,binding:bound(hashComponents("app_test",raw,true)),calls:[]};
  const now=new Date("2026-10-24T12:00:00Z");let installationId;
  const fetchImpl=async(url,options)=>{
    const body=JSON.parse(options.body??"null");state.calls.push({url,body});
    if(state.offline)throw new Error("offline");
    if(state.reject)return {ok:false,status:403,json:async()=>({success:false,error:{code:"FINGERPRINT_MISMATCH",message:"This activation belongs to a different device."}})};
    if(url.endsWith("/deactivate"))return {ok:true,status:200,json:async()=>({success:true,deactivated:true})};
    installationId=body.device_id??options.headers["X-Installation-ID"];
    const payload={product_id:"app_test",environment:"sandbox",status:"active",expires_at:null,features:{export:true},floating:null,metered:false,credit_balance:0,total_allocated:0,credit_transaction:null,
      device:{installation_hash:crypto.createHash("sha256").update(installationId).digest("hex"),fingerprint:state.binding},
      server_time:now.toISOString(),next_validation_at:new Date(+now+3600000).toISOString(),offline_grace_until:new Date(+now+86400000).toISOString()};
    const payload_json=canonicalJson(payload),license={payload,payload_json,algorithm:"Ed25519",key_id:"ed25519_fixture",signature:crypto.sign(null,Buffer.from(payload_json),pair.privateKey).toString("base64url")};
    return {ok:true,status:200,json:async()=>({success:true,activation_token:"act_fixture_only",license})};
  };
  const client=new LicenseClient({product:"app_test",environment:"SANDBOX",storageDir:root,clock:()=>now,fetchImpl,verificationKey:{key_id:"ed25519_fixture",public_key:publicKey}});
  return {client,state,root,change:value=>{current=value;}};
}

test("product-scoped hashes, placeholders and CPU-only refusal",()=>{
  const one=hashComponents("app_one",raw),two=hashComponents("app_two",raw);
  assert.notEqual(one.hardware_id,two.hardware_id);
  assert.ok(Object.values(raw).every(value=>!JSON.stringify(one).includes(value)));
  assert.deepEqual(hashComponents("app_one",Object.fromEntries(Object.entries(raw).map(([key,value])=>[key,` ${value.toLowerCase()} `]))),one);
  assert.throws(()=>hashComponents("app_test",{baseboard:"To be filled by O.E.M.",cpu:"model"}));
});
test("strict/fuzzy matching, critical anchors, signed minimum and combined hash",()=>{
  const original=hashComponents("app_test",raw),disk=hashComponents("app_test",{...raw,disk:"NEW-DISK"});
  assert.equal(matchesBinding(bound(original),original),true);
  assert.equal(matchesBinding(bound(original),disk),false);
  assert.equal(matchesBinding(bound(original,"fuzzy"),disk),true);
  assert.equal(matchesBinding(bound(original,"fuzzy",3),disk),false);
  assert.equal(matchesBinding(bound(original,"fuzzy",1),hashComponents("app_test",{...raw,baseboard:"CLONED"})),false);
  assert.equal(matchesBinding(bound(original,"fuzzy",1),hashComponents("app_test",{baseboard:raw.baseboard,disk:raw.disk})),false);
  assert.equal(matchesBinding({...bound(original),hardware_id:"0".repeat(64)},original),false);
  assert.equal(matchesBinding(null,original),false);
});
test("activation/validation send only hashes; VM hint does not deny; private storage",async t=>{
  const {client,state}=fixture(t);
  assert.equal((await client.activate("FIXTURE-LICENSE-KEY")).valid,true);
  assert.equal(state.calls[0].body.fingerprint.is_virtual,true);
  assert.equal((await client.validate()).valid,true);
  assert.ok(state.calls.at(-1).body.fingerprint);
  const stored=fs.readFileSync(path.join(client.storageDir,"signed-state.json"),"utf8");
  assert.ok(Object.values(raw).every(value=>!stored.includes(value)));
});
test("cloned cache/offline access fail closed",async t=>{
  const {client,state,change}=fixture(t);
  assert.equal((await client.activate("FIXTURE-LICENSE-KEY")).valid,true);
  change({...raw,baseboard:"ANOTHER-BOARD"});state.offline=true;
  const result=await client.check();
  assert.equal(result.valid,false);assert.equal(result.errorCode,"FINGERPRINT_MISMATCH");assert.equal(result.feature("export"),false);
});
test("fuzzy cached disk change remains usable",async t=>{
  const {client,state,change}=fixture(t);state.binding=bound(hashComponents("app_test",raw,true),"fuzzy");
  assert.equal((await client.activate("FIXTURE-LICENSE-KEY")).valid,true);
  change({...raw,disk:"NEW-DISK"});assert.equal((await client.check()).valid,true);
});
test("authoritative mismatch clears cached grants and token",async t=>{
  const {client,state}=fixture(t);assert.equal((await client.activate("FIXTURE-LICENSE-KEY")).valid,true);
  state.reject=true;const result=await client.validate();
  assert.equal(result.errorCode,"FINGERPRINT_MISMATCH");assert.equal(client.activated,false);
  assert.equal(fs.existsSync(path.join(client.storageDir,"signed-state.json")),false);
});
test("missing signed binding is rejected",async t=>{
  const {client,state}=fixture(t);state.binding=null;
  const result=await client.activate("FIXTURE-LICENSE-KEY");assert.equal(result.valid,false);assert.equal(result.errorCode,"FINGERPRINT_MISMATCH");assert.equal(client.activated,false);
});
test("OS collector errors are generic and do not send requests",async t=>{
  const {client,state,change}=fixture(t);change({});
  assert.equal((await client.activate("FIXTURE-LICENSE-KEY")).errorCode,"HARDWARE_UNAVAILABLE");assert.equal(state.calls.length,0);
});
test("macOS and Linux collectors hash mocked OS data",t=>{
  const descriptor=Object.getOwnPropertyDescriptor(process,"platform"),originalRead=fs.readFileSync;
  t.mock.method(childProcess,"execFileSync",(file)=>file.endsWith("ioreg")?`"IOPlatformUUID" = "${raw.baseboard}" Virtual Machine`:file.endsWith("sysctl")?raw.cpu:"");
  t.mock.method(fs,"readFileSync",(file,...args)=>String(file).startsWith("/sys/")||String(file)==="/proc/cpuinfo"?({"/sys/class/dmi/id/board_serial":raw.baseboard,"/proc/cpuinfo":`model name : ${raw.cpu}`,"/sys/class/dmi/id/product_name":"Virtual Machine"}[file]??""):originalRead(file,...args));
  t.mock.method(fs,"readdirSync",()=>[]);syncBuiltinESMExports();
  t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();Object.defineProperty(process,"platform",descriptor);});
  for(const platform of ["darwin","linux"]) {
    Object.defineProperty(process,"platform",{value:platform,configurable:true});
    const collected=collectFingerprint("app_test");assert.equal(collected.is_virtual,true);
    assert.equal(collected.components.baseboard,hashComponents("app_test",raw).components.baseboard);
    assert.ok(Object.values(raw).every(value=>!JSON.stringify(collected).includes(value)));
  }
});
