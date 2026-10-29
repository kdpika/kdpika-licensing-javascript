import {applicationAllowed} from "./applications.js";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {collectFingerprint, matchesBinding} from "./fingerprint.js";
import {FloatingState,leaseValid,AllSeatsInUseError} from "./floating.js";
export {AllSeatsInUseError} from "./floating.js";
import {CreditOperationError,InsufficientCreditsError,creditPolicy,requestValues,consumption} from "./credits.js";
export {CreditOperationError,InsufficientCreditsError} from "./credits.js";

export class LicenseResult {
  #snapshot; #clock; #seatGuard;
  constructor({valid, source, payload = {}, errorCode = null, message = "", requestId = null, signatureValid = false, storageSecurity = "permission-protected-file", clock = () => new Date(), seatGuard = null}) {
    this.#snapshot = structuredClone(payload); this.#clock = clock;this.#seatGuard=seatGuard;
    Object.assign(this, {valid, source, payload:structuredClone(payload), errorCode, message, requestId, signatureValid, storageSecurity});
    Object.freeze(this);
  }
  #allowed() {
    const p=this.#snapshot,now=new Date(this.#clock()),server=timeValue(p.server_time),next=timeValue(p.next_validation_at),grace=timeValue(p.offline_grace_until),expiry=p.expires_at===null?null:timeValue(p.expires_at);
    const seatAllowed=p.floating===null?leaseValid(p,null,now):Boolean(this.#seatGuard?.(p));
    return creditPolicy(p)&&(!p.metered||(this.source==='online'))&&seatAllowed&&this.valid&&this.signatureValid&&p.status==='active'&&Number.isFinite(+now)&&server&&next&&grace&&next>=server&&grace>=server&&(p.expires_at===null||expiry)&&+now+300000>=+server&&(!expiry||now<expiry)&&(['cache','offline'].includes(this.source)?now<=grace:now<next);
  }
  feature(name, fallback = false) { if(!this.#allowed())return false;const value=this.#snapshot.features?.[name]??fallback;return value===true||(typeof value==='number'&&Number.isFinite(value)&&value>0); }
  featureValue(name, fallback = null) { return this.#allowed()?structuredClone(this.#snapshot.features?.[name]??fallback):null; }
}

export class LicenseClient {
  constructor({product, environment = "LIVE", baseUrl = "https://licensing.kdpika.com", applicationName = "Licensed Application", applicationVersion = "", applicationType = "desktop", verificationKey = null, storageDir = null, timeoutMs = 15000, fetchImpl = globalThis.fetch, clock = () => new Date()}) {
    if (!String(product ?? "").trim()) throw new Error("A Public App ID is required.");
    if (!safeBaseUrl(baseUrl)) throw new Error("The API base URL must use HTTPS; loopback HTTP is allowed for development.");
    const normalized = ({PRODUCTION: "LIVE", TEST: "SANDBOX"})[String(environment).toUpperCase()] ?? String(environment).toUpperCase();
    if (!["SANDBOX", "LIVE"].includes(normalized)) throw new Error("Environment must be SANDBOX or LIVE.");
    if (verificationKey && (!verificationKey.key_id || !verificationKey.public_key)) throw new Error("Pinned verification key is incomplete.");
    if (typeof fetchImpl !== "function") throw new Error("A fetch implementation is required.");
    if (!["desktop","web"].includes(applicationType)) throw new Error("Application type must be desktop or web.");
    this.applicationType=applicationType;
    this.product = product.trim(); this.environment = normalized; this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.applicationName = applicationName; this.applicationVersion = applicationVersion; this.verificationKey = verificationKey;
    this.timeoutMs = timeoutMs; this.fetchImpl = fetchImpl; this.clock = clock;
    const namespace = crypto.createHash("sha256").update(`${this.baseUrl.toLowerCase()}|${this.product}|${this.environment}|${this.applicationType}`).digest("hex").slice(0, 20);
    this.storageDir = path.join(storageDir ?? defaultStorageDir(applicationName), namespace);
    fs.mkdirSync(this.storageDir, {recursive: true, mode: 0o700}); try { fs.chmodSync(this.storageDir, 0o700); } catch {}
    const identity = this.readJson("installation.json");
    this.installationId = typeof identity.installation_id === "string" ? identity.installation_id : `lmp-install-${crypto.randomUUID()}`;
    if (!identity.installation_id) this.writeJson("installation.json", {installation_id: this.installationId});
    this._floating=new FloatingState(this);this._operations=Promise.resolve();this.lastFloatingError=null;
  }

  get activated() { return Boolean(this.token()); }

  _serialize(operation) {const pending=this._operations.then(operation,operation);this._operations=pending.catch(()=>{});return pending;}
  activate(licenseKey,email=null) {return this._serialize(async()=>{const result=await this._activate(licenseKey,email);this.startHeartbeat(result);return result;});}
  check(forceOnline=false) {return this._serialize(async()=>{const result=await this._check(forceOnline);this.startHeartbeat(result);return result;});}
  creditPacks() {return this._creditRequest("packs",{});}
  creditHistory() {return this._creditRequest("history",{});}
  createCreditCheckout(packId) {return this._creditRequest("checkout",{pack_id:packId});}
  redeemCredits(code,idempotencyKey) {requestValues(1,idempotencyKey,null);if(!idempotencyKey||typeof code!=="string")throw new CreditOperationError("INVALID_REQUEST");return this._creditRequest("redeem",{code,idempotency_key:idempotencyKey});}
  _creditRequest(operation,fields) {return this._serialize(async()=>{
    const token=this.token();if(!token)throw new CreditOperationError("NOT_ACTIVATED");
    const fingerprint=collectFingerprint(this.product);let response;
    try{response=await this.request("POST","/api/v1/credits/"+operation,{...fields,fingerprint,session_token:this.sessionToken()},{Authorization:`Bearer ${token}`,"X-Installation-ID":this.installationId});}catch{throw new CreditOperationError("NETWORK_ERROR");}
    if(!response.ok)throw new CreditOperationError(response.body?.error?.code);
    const checked=await this.verified(response.body.license,"online",response,fingerprint);
    if(!checked.valid||!checked.signatureValid)throw new CreditOperationError(checked.errorCode??"SIGNATURE_INVALID");
    await this.saveState(response.body.license);const {license,...data}=response.body;data.balance=checked.payload.credit_balance;
    if(operation==="redeem"){const r=checked.payload.credit_transaction;const expected=crypto.createHash("sha256").update("code:"+crypto.createHash("sha256").update(fields.idempotency_key).digest("hex")).digest("hex");if(r?.type!=="grant"||r.idempotency_hash!==expected||r.id!==data.transaction_id)throw new CreditOperationError("INVALID_RECEIPT");data.added=r.amount;data.replayed=r.replayed;}
    return Object.freeze(data);
  });}
  getBalance() {return this._serialize(async()=>{
    const result=await this._check(true);
    if(!result.signatureValid||(!result.valid&&result.errorCode!=="INSUFFICIENT_CREDITS"))throw new CreditOperationError(result.errorCode??undefined);
    if(!result.payload.metered)throw new CreditOperationError("NOT_METERED_LICENSE");
    return result.payload.credit_balance;
  });}
  consumeAction(action,idempotencyKey,expectedUnits=1) {return this.consume(expectedUnits,idempotencyKey,null,action);}
  consume(amount,idempotencyKey=null,reason=null,action=null) {return this._serialize(async()=>{
    requestValues(amount,idempotencyKey,reason);
    const token=this.token();if(!token)throw new CreditOperationError("NOT_ACTIVATED");
    let fingerprint;try{fingerprint=collectFingerprint(this.product);}catch{throw new CreditOperationError("HARDWARE_UNAVAILABLE");}
    let response;
    try{response=await this.request("POST","/api/v1/licenses/consume",{amount,action,idempotency_key:idempotencyKey,reason,fingerprint,session_token:this.sessionToken()},{Authorization:`Bearer ${token}`,"X-Installation-ID":this.installationId});}
    catch{throw new CreditOperationError("NETWORK_ERROR");}
    if(!response.ok&&response.body?.error?.code!=="INSUFFICIENT_CREDITS"){this.remove("signed-state.json");throw new CreditOperationError(response.body?.error?.code);}
    let result;try{result=await this.verified(response.body.license,"online",response,fingerprint);}catch{throw new CreditOperationError("SIGNATURE_INVALID");}
    if(!result.signatureValid||(!result.valid&&result.errorCode!=="INSUFFICIENT_CREDITS"))throw new CreditOperationError(result.errorCode??"SIGNATURE_INVALID");
    if(!result.payload.metered)throw new CreditOperationError("NOT_METERED_LICENSE");
    if(!response.ok){
      if(response.status!==402||(action===null&&result.payload.credit_balance>=amount)||response.body.balance!==result.payload.credit_balance)throw new CreditOperationError("INVALID_RECEIPT");
      await this.saveState(response.body.license);throw new InsufficientCreditsError(result.payload.credit_balance);
    }
    if(action!==null){const delta=result.payload.credit_transaction?.amount;if(!Number.isSafeInteger(delta)||delta>=0)throw new CreditOperationError("INVALID_RECEIPT");amount=-delta;}
    const receipt=consumption(result.payload,response.body,amount,idempotencyKey);await this.saveState(response.body.license);return receipt;
  });}
  checkout() {return this._serialize(async()=>{const result=await this.seatRequest("checkout");if(result.errorCode==="ALL_SEATS_IN_USE")throw new AllSeatsInUseError();this.startHeartbeat(result);return result;});}
  heartbeat() {return this._serialize(()=>this.seatRequest("heartbeat"));}
  checkin() {this._floating.stop();return this._serialize(()=>this.seatRequest("checkin"));}
  deactivate() {this._floating.stop();return this._serialize(()=>this._deactivate());}
  async close() {this._floating.stop();if(this.sessionToken())await this.checkin();}
  sessionToken() {const token=this.readJson("floating-session.json").session_token;return typeof token==="string"&&/^flt_[A-Za-z0-9_-]{43}$/.test(token)?token:null;}
  startHeartbeat(result) {if(result.valid&&result.payload.floating)this._floating.start(result.payload.floating);}

  async seatRequest(action) {
    const token=this.token(),session=this.sessionToken();
    if(action==="checkin"){this.remove("floating-session.json");this.remove("signed-state.json");}
    if(!token)return this.error("NOT_ACTIVATED","Activate this installation first.","local");
    if(action!=="checkout"&&!session)return action==="heartbeat"?this.seatRequest("checkout"):this.error("SESSION_NOT_FOUND","Your shared seat needs to be reserved again.","local");
    let fingerprint;try{fingerprint=collectFingerprint(this.product);}catch{return this.error("HARDWARE_UNAVAILABLE","This device's information is unavailable.","local");}
    let response;
    try{response=await this.request("POST","/api/v1/licenses/"+action,{fingerprint,...(session?{session_token:session}:{})},{Authorization:`Bearer ${token}`,"X-Installation-ID":this.installationId});}
    catch{return this.error("NETWORK_ERROR","Connect to reserve or renew your shared seat.","local");}
    if(!response.ok){
      const result=this.responseError(response);this.remove("floating-session.json");this.remove("signed-state.json");
      if(action==="heartbeat"&&result.errorCode==="SESSION_NOT_FOUND")return this.seatRequest("checkout");
      return result;
    }
    if(action==="checkin")return response.body.checked_in===true?new LicenseResult({valid:true,source:"online",message:"Shared seat released."}):this.error("INVALID_RESPONSE","The seat release was not confirmed.","online",response);
    if(action==="checkout") {
      const held=response.body.session_token;
      if(typeof held!=="string"||!/^flt_[A-Za-z0-9_-]{43}$/.test(held)){this.remove("floating-session.json");this.remove("signed-state.json");return this.error("INVALID_RESPONSE","The shared seat could not be verified.","online",response);}
      this.writeJson("floating-session.json",{session_token:held});
    }
    let result;
    try{result=await this.verified(response.body.license,"online",response,fingerprint);}
    catch{result=this.error("SIGNATURE_INVALID","The shared seat could not be verified.","online",response);}
    if(result.valid||result.errorCode==="INSUFFICIENT_CREDITS"){await this.saveState(response.body.license);this.lastFloatingError=null;}
    else{this.remove("floating-session.json");this.remove("signed-state.json");}
    return result;
  }

  async _activate(licenseKey, email = null) {
    if (!String(licenseKey ?? "").trim()) return this.error("INVALID_LICENSE", "Enter a license key.", "local");
    let fingerprint;try { fingerprint=collectFingerprint(this.product); } catch { return this.error("HARDWARE_UNAVAILABLE","This device's information is unavailable. Contact the software publisher.","local"); }
    const body = {license_key: licenseKey.trim(), device_id: this.installationId, device_name: os.hostname() || this.applicationName, platform: process.platform, app_version: this.applicationVersion, fingerprint};
    if (email) body.email = String(email).trim();
    let response; try { response = await this.request("POST", "/api/v1/licenses/activate", body, {"X-App-ID": this.product, "X-Environment": this.environment}); }
    catch { return this.error("NETWORK_ERROR", "Activation requires an internet connection.", "local"); }
    if (!response.ok) return this.responseError(response);
    const token = response.body.activation_token, signed = response.body.license;
    if (typeof token !== "string" || !token.startsWith("act_") || !signed || typeof signed !== "object") return this.error("INVALID_RESPONSE", "The activation response was incomplete.", "online", response);
    let result; try { result = await this.verified(signed, "online", response, fingerprint); }
    catch (error) { await this.bestEffortDeactivate(token); return this.error("SIGNATURE_INVALID", error.message, "online", response); }
    if (!result.valid&&!["SESSION_REQUIRED","INSUFFICIENT_CREDITS"].includes(result.errorCode)) { await this.bestEffortDeactivate(token); return result; }
    this.atomicWrite("activation-token", token); await this.saveState(signed);return result.errorCode==="SESSION_REQUIRED"?this.seatRequest("checkout"):result;
  }

  async _check(forceOnline = false) {
    const token = this.token();
    if (!token) return this.error("NOT_ACTIVATED", "No activation is stored for this installation.", "local");
    let fingerprint;try { fingerprint=collectFingerprint(this.product); } catch { return this.error("HARDWARE_UNAVAILABLE","This device's information is unavailable. Contact the software publisher.","local"); }
    const state = this.readJson("signed-state.json");
    if (!forceOnline && state.signed_license) {
      try { const cached = await this.verified(state.signed_license, "cache", null, fingerprint); const next = timeValue(cached.payload.next_validation_at); if (cached.valid && next && this.now() < next) { this.checkpoint(); return cached; } }
      catch { this.remove("signed-state.json"); }
    }
    let response;
    try { response = await this.request("POST", "/api/v1/licenses/validate", {fingerprint,session_token:this.sessionToken()}, {Authorization: `Bearer ${token}`, "X-Installation-ID": this.installationId}); }
    catch { return this.offline(fingerprint); }
    if (!response.ok) {
      if(response.status===402&&response.body?.error?.code==="INSUFFICIENT_CREDITS"){
        try{const checked=await this.verified(response.body.license,"online",response,fingerprint);if(checked.signatureValid&&checked.errorCode==="INSUFFICIENT_CREDITS"){await this.saveState(response.body.license);return checked;}}catch{}
        return this.error("SIGNATURE_INVALID","The credit balance could not be verified.","online",response);
      }
      const result = this.responseError(response); this.remove("signed-state.json");
      this.remove("floating-session.json");
      if(result.errorCode==="SESSION_NOT_FOUND")return this.seatRequest("checkout");
      if (["INVALID_TOKEN","DEVICE_MISMATCH","FINGERPRINT_MISMATCH","LICENSE_REVOKED","LICENSE_EXPIRED","LICENSE_CANCELLED","LICENSE_SUSPENDED"].includes(result.errorCode)) this.remove("activation-token");
      return result;
    }
    if (!response.body.license || typeof response.body.license !== "object") { this.remove("floating-session.json");this.remove("signed-state.json");return this.error("INVALID_RESPONSE", "The validation response was incomplete.", "online", response); }
    let result; try { result = await this.verified(response.body.license, "online", response, fingerprint); }
    catch (error) { this.remove("floating-session.json");this.remove("signed-state.json");return this.error("SIGNATURE_INVALID", "The license reply could not be verified.", "online", response); }
    if (result.valid) await this.saveState(response.body.license); else {this.remove("floating-session.json");this.remove("signed-state.json");}return result;
  }

  validate() { return this.check(true); }

  async _deactivate() {
    const token = this.token(); if (!token) return this.error("NOT_ACTIVATED", "No activation is stored for this installation.", "local");
    let response; try { response = await this.request("POST", "/api/v1/licenses/deactivate", {}, {Authorization: `Bearer ${token}`}); }
    catch { return this.error("NETWORK_ERROR", "Deactivation requires an internet connection.", "local"); }
    if (!response.ok) return this.responseError(response);
    if(response.body.deactivated!==true)return this.error("INVALID_RESPONSE","The release was not confirmed.","online",response);
    this.remove("activation-token"); this.remove("signed-state.json");
    this.remove("floating-session.json");
    return new LicenseResult({valid: true, source: "online", message: "License deactivated.", requestId: response.body.request_id ?? null});
  }

  async feature(name, fallback = false) { return (await this.check()).feature(name, fallback); }

  async offline(fingerprint = null) {
    const signed = this.readJson("signed-state.json").signed_license;
    if (!signed) return this.error("OFFLINE_CACHE_MISSING", "Online validation is required because no verified cache is available.", "offline");
    try { const result = await this.verified(signed, "offline", null, fingerprint); if (result.valid) this.checkpoint(); return result; }
    catch (error) { this.remove("signed-state.json"); return this.error("OFFLINE_CACHE_INVALID", error.message, "offline"); }
  }

  async verified(signed, source, response = null, fingerprint = null) {
    const encoded = signed.payload_json;
    if(encoded!==undefined&&(typeof encoded!=="string"||Buffer.byteLength(encoded)>1048576))throw new Error("Invalid signed bytes.");
    // Exact signed bytes are authoritative; do not re-encode floats or cached Unicode.
    const payload = encoded===undefined?signed.payload:JSON.parse(encoded), signature = signed.signature;
    if (!payload || typeof payload !== "object" || Array.isArray(payload) || typeof signature !== "string" || signed.algorithm !== "Ed25519") throw new Error("The signed license envelope is incomplete.");
    const key = await this.getVerificationKey(signed);
    if (signed.key_id !== key.key_id) throw new Error("The license signature key does not match the trusted key.");
    const rawKey = decodeBase64Url(key.public_key); const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), rawKey]);
    if (!crypto.verify(null, Buffer.from(encoded??canonicalJson(payload)), {key: spki, format: "der", type: "spki"}, decodeBase64Url(signature))) throw new Error("The license signature is invalid.");
    if (payload.product_id !== this.product || String(payload.environment ?? "").toUpperCase() !== this.environment) throw new Error("The signed license belongs to another product or environment.");
    if (!applicationAllowed(payload,this.applicationType)) return this.error("APPLICATION_NOT_ALLOWED","This license does not include this type of app.",source,response,payload,true);
    const expected = crypto.createHash("sha256").update(this.installationId).digest("hex");
    if (payload.device?.installation_hash !== expected) throw new Error("The signed license belongs to another installation.");
    if (!fingerprint) {
      try { fingerprint=collectFingerprint(this.product); } catch { return this.error("HARDWARE_UNAVAILABLE","This device's information is unavailable. Contact the software publisher.",source,response); }
    }
    if (!matchesBinding(payload.device.fingerprint,fingerprint)) return this.error("FINGERPRINT_MISMATCH","This activation belongs to a different device. Contact the software publisher.",source,response,payload,true);
    const now = this.now(), state = this.readJson("signed-state.json"), checkpoint = timeValue(state.last_seen_at), server = timeValue(payload.server_time);
    const next=timeValue(payload.next_validation_at),signedGrace=timeValue(payload.offline_grace_until);
    if(!server||!next||!signedGrace||next<server||signedGrace<server||(payload.expires_at!==null&&!timeValue(payload.expires_at)))return this.error("INVALID_SIGNED_TIME","The license dates could not be verified.",source,response,payload,true);
    const latest = [checkpoint, server].filter(Boolean).sort((a,b)=>b-a)[0];
    if (latest && now.getTime() + 300000 < latest.getTime()) return this.error("CLOCK_ROLLBACK_DETECTED", "The system clock moved behind the last trusted license time.", source, response, payload, true);
    if (String(payload.status ?? "").toLowerCase() !== "active") return this.error("LICENSE_NOT_ACTIVE", "The license is not active.", source, response, payload, true);
    const expires = timeValue(payload.expires_at); if (expires && now >= expires) return this.error("LICENSE_EXPIRED", "The license has expired.", source, response, payload, true);
    const grace = timeValue(payload.offline_grace_until); if (["cache","offline"].includes(source) && (!grace || now > grace)) return this.error("OFFLINE_GRACE_EXPIRED", "The offline grace period ended; connect to validate the license.", source, response, payload, true);
    const policy=payload.floating;
    if(policy&&(!Number.isInteger(policy.heartbeat_interval_seconds)||policy.heartbeat_interval_seconds<30||policy.heartbeat_interval_seconds>600))return this.error("INVALID_RESPONSE","The shared-seat settings could not be verified.",source,response,payload,true);
    if(policy&&policy.session===null)return this.error("SESSION_REQUIRED","Reserve a shared seat before using this app.",source,response,payload,true);
    if(!leaseValid(payload,this.sessionToken(),now))return this.error("SESSION_EXPIRED","Your shared seat expired. Connect to reserve a seat again.",source,response,payload,true);
    if(!creditPolicy(payload))return this.error("INVALID_RESPONSE","The credit settings could not be verified.",source,response,payload,true);
    if(payload.metered&&source!=="online")return this.error("METERED_ONLINE_REQUIRED","Connect to the internet to check or use credits.",source,response,payload,true);
    return new LicenseResult({valid:true,source,payload,requestId:response?.body?.request_id??null,signatureValid:true,clock:()=>this.now(),seatGuard:snapshot=>leaseValid(snapshot,this.sessionToken(),this.now())});
  }

  async getVerificationKey(signed) {
    if (this.verificationKey) return this.verificationKey;
    const cached = this.readJson("signed-state.json").verification_key; if (cached?.key_id === signed.key_id) return cached;
    const response = await this.request("GET", "/api/v1/public-key", null, {}), key = response.body.key;
    if (!response.ok || !key || key.key_id !== signed.key_id || key.algorithm !== "Ed25519") throw new Error("The server verification key could not authenticate this license.");
    this.verificationKey = key; return key;
  }

  async saveState(signed) { this.writeJson("signed-state.json", {version:1,signed_license:signed,verification_key:await this.getVerificationKey(signed),last_seen_at:this.now().toISOString()}); }
  checkpoint() { const state=this.readJson("signed-state.json");state.last_seen_at=this.now().toISOString();this.writeJson("signed-state.json",state); }
  token() { try { return fs.readFileSync(path.join(this.storageDir,"activation-token"),"utf8").trim() || null; } catch { return null; } }
  async bestEffortDeactivate(token) { try { await this.request("POST","/api/v1/licenses/deactivate",{}, {Authorization:`Bearer ${token}`}); } catch {} }

  async request(method, endpoint, body, headers) {
    const controller = new AbortController(), timeout = setTimeout(()=>controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.baseUrl + endpoint, {method, redirect:"manual", headers:{"X-Application-Type":this.applicationType,Accept:"application/json","User-Agent":"KDPika-JavaScript-SDK/1.0.1",...(body!==null?{"Content-Type":"application/json"}:{}),...headers}, body:body===null?undefined:JSON.stringify(body), signal:controller.signal});
      let decoded; try { decoded = await response.json(); } catch { decoded={success:false,error:{code:"INVALID_RESPONSE",message:"The server returned an invalid response."}}; }
      if(!decoded||typeof decoded!=="object"||Array.isArray(decoded))decoded={success:false,error:{code:"INVALID_RESPONSE",message:"The server returned an invalid response."}};
      return {ok:response.ok&&decoded.success===true,status:response.status,body:decoded};
    } finally { clearTimeout(timeout); }
  }
  responseError(response) { return this.error(response.body?.error?.code??"HTTP_ERROR",response.body?.error?.message??"The licensing service rejected the request.","online",response); }
  error(errorCode,message,source,response=null,payload={},signatureValid=false) { return new LicenseResult({valid:false,source,payload,errorCode,message,requestId:response?.body?.request_id??null,signatureValid}); }
  now() { const value=this.clock();return value instanceof Date?new Date(value):new Date(value); }
  readJson(name) { try { const value=JSON.parse(fs.readFileSync(path.join(this.storageDir,name),"utf8"));return value&&typeof value==="object"?value:{}; } catch { return {}; } }
  writeJson(name,value) { this.atomicWrite(name,JSON.stringify(value)); }
  atomicWrite(name,value) { const target=path.join(this.storageDir,name),temp=`${target}.${crypto.randomBytes(6).toString("hex")}`;fs.writeFileSync(temp,value,{mode:0o600});fs.renameSync(temp,target);try{fs.chmodSync(target,0o600);}catch{} }
  remove(name) { try { fs.unlinkSync(path.join(this.storageDir,name)); } catch {} }
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function decodeBase64Url(value) { return Buffer.from(value.replace(/-/g,"+").replace(/_/g,"/")+"=".repeat((4-value.length%4)%4),"base64"); }
function timeValue(value) { if (!value || typeof value!=="string") return null;const parsed=new Date(value);return Number.isNaN(parsed.getTime())?null:parsed; }
function safeBaseUrl(value) { try { const parsed=new URL(String(value).trim());return !parsed.username&&!parsed.password&&(parsed.protocol==="https:"||(parsed.protocol==="http:"&&["127.0.0.1","[::1]","localhost"].includes(parsed.hostname.toLowerCase()))); } catch { return false; } }
function defaultStorageDir(applicationName) { const safe=String(applicationName).replace(/[^A-Za-z0-9_-]+/g,"-").replace(/^-|-$/g,"")||"licensed-app";if(process.platform==="darwin")return path.join(os.homedir(),"Library","Application Support",safe,"License");if(process.platform==="win32")return path.join(process.env.APPDATA??os.homedir(),safe,"License");return path.join(process.env.XDG_DATA_HOME??path.join(os.homedir(),".local","share"),safe,"license"); }
