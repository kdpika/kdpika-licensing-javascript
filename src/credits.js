import crypto from "node:crypto";

export class CreditOperationError extends Error {
  constructor(code="CREDIT_OPERATION_FAILED") {
    super("The credit operation could not be completed. Check the license or contact its publisher.");
    this.name="CreditOperationError";
    this.code=/^[A-Z_]{1,50}$/.test(code)?code:"CREDIT_OPERATION_FAILED";
  }
}
export class InsufficientCreditsError extends CreditOperationError {
  constructor(balance) {super("INSUFFICIENT_CREDITS");this.name="InsufficientCreditsError";this.message="There are not enough credits. Ask the software publisher to add more.";this.balance=balance;}
}
export const creditInteger=value=>Number.isSafeInteger(value)&&value>=0;
export const creditPolicy=p=>typeof p.metered==="boolean"&&creditInteger(p.credit_balance)&&creditInteger(p.total_allocated);
export function requestValues(amount,key,reason) {
  if(!creditInteger(amount)||amount===0)throw new TypeError("Use a positive whole number of credits within the supported range.");
  if(key!==null&&(typeof key!=="string"||!/^[A-Za-z0-9_.:-]{8,190}$/.test(key)))throw new TypeError("Use an 8–190 character request key: letters, numbers, dot, colon, underscore or hyphen.");
  if(reason!==null&&(typeof reason!=="string"||[...reason].length>190||/[\x00-\x1f\x7f]/.test(reason)))throw new TypeError("Use a short single-line credit note.");
}
export function consumption(payload,body,amount,key) {
  const r=payload.credit_transaction,expected=key===null?null:crypto.createHash("sha256").update(key).digest("hex");
  if(!r||r.type!=="consume"||typeof r.id!=="string"||!/^ctx_[A-Za-z0-9_-]{1,36}$/.test(r.id)||r.amount!==-amount||!creditInteger(r.balance_after)||!creditInteger(r.total_allocated_after)||r.idempotency_hash!==expected||typeof r.replayed!=="boolean"||body.transaction_id!==r.id||body.consumed!==amount||body.balance!==r.balance_after||body.replayed!==r.replayed)throw new CreditOperationError("INVALID_RECEIPT");
  // Replay balance is historical. getBalance() always fetches the current value.
  return Object.freeze({transactionId:r.id,consumed:amount,balance:r.balance_after,replayed:r.replayed});
}
