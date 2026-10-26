import crypto from "node:crypto";

export class AllSeatsInUseError extends Error {
  constructor() { super("All shared seats are in use. Try again when someone closes the app.");this.name="AllSeatsInUseError";this.code="ALL_SEATS_IN_USE"; }
}

export function leaseValid(payload, token, now) {
  if(!Object.hasOwn(payload,"floating"))return false;
  const policy=payload.floating;
  if(policy===null)return true;
  if(!policy||!Number.isInteger(policy.max_concurrent_sessions)||policy.max_concurrent_sessions<1)return false;
  const session=policy.session;
  if(!session||!token||typeof session.expires_at!=="string")return false;
  const deadline=new Date(session.expires_at);
  return Number.isFinite(+deadline)&&now<deadline&&session.token_hash===crypto.createHash("sha256").update(token).digest("hex");
}

export class FloatingState {
  constructor(client) {
    this.client=client;this.timer=null;this.stopped=false;
    const reference=new WeakRef(client);
    this.shutdown=()=>{
      const owner=reference.deref();
      if(owner?.sessionToken())void owner.close().catch(()=>{});
    };
  }
  start(policy) {
    if(this.timer||!policy||!this.client.sessionToken())return;
    this.stopped=false;
    process.removeListener("beforeExit",this.shutdown);
    process.once("beforeExit",this.shutdown);
    this.timer=setTimeout(async()=>{
      this.timer=null;
      try {
        const result=await this.client.heartbeat();
        this.client.lastFloatingError=result.errorCode;
        if(!this.stopped&&(result.valid||result.errorCode==="NETWORK_ERROR"))this.start(policy);
      } catch { this.client.lastFloatingError="SESSION_NOT_FOUND"; }
    },policy.heartbeat_interval_seconds*1000);
    this.timer.unref();
  }
  stop() {
    this.stopped=true;if(this.timer)clearTimeout(this.timer);this.timer=null;
    process.removeListener("beforeExit",this.shutdown);
  }
}
