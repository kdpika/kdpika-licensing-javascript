/** Sandbox session CLI; Node18.20+, official local SDK1.0.0 (ESM).
 * Run node session.mjs status|activate|check|validate|deactivate.
 * Set KDP_APP_ID,KDP_STATE_DIR; activate: KDP_LICENSE_KEY/optional customer email.
 * Expected safe JSON, no raw signed payload/activation token. Keep validity gate.
 */
import crypto from 'node:crypto';
import {LicenseClient} from '@kdpika/license-sdk';
function required(name){const value=(process.env[name]||'').trim();if(!value)throw Error('Missing configuration');return value;}
try{
 const action=process.argv.length===3?process.argv[2]:'';
 if(!['status','activate','check','validate','deactivate'].includes(action))throw Error('Choose an action');
 const base=(process.env.KDP_BASE_URL||'https://licensing.kdpika.com').replace(/\/+$/,'');const uri=new URL(base);
 const local=uri.protocol==='http:'&&['127.0.0.1','localhost'].includes(uri.hostname)&&process.env.KDP_ALLOW_LOOPBACK==='1';
 if(uri.username||uri.password||uri.pathname!=='/'||uri.search||uri.hash||(uri.protocol!=='https:'&&!local))throw Error('Use an HTTPS site origin');
 const client=new LicenseClient({product:required('KDP_APP_ID'),environment:'SANDBOX',baseUrl:base,
  applicationName:'KDPika SDK session example',applicationVersion:'1.0.0',storageDir:required('KDP_STATE_DIR')});
 if(action==='status')console.log(JSON.stringify({activated:client.activated,storage_security:'permission-protected-file',
  installation_hash:crypto.createHash('sha256').update(client.installationId).digest('hex')}));
 else{
  let result;
  if(action==='activate'){
   const key=required('KDP_LICENSE_KEY');if(!/^TEST[A-Z0-9]*-/i.test(key))throw Error('Use a Sandbox key');
   result=await client.activate(key,process.env.KDP_CUSTOMER_EMAIL||null);
  }else result=await client[action]();
  const active=action!=='deactivate'&&result.valid&&result.signatureValid;
  const limit=active?result.featureValue('seat_count'):null;
  console.log(JSON.stringify({valid:result.valid,source:result.source,error_code:result.errorCode,
   signature_valid:result.signatureValid,pdf_export_allowed:Boolean(active&&result.feature('pdf_export')),
   seat_count:Number.isSafeInteger(limit)&&limit>=0?limit:null,request_id:/^req_[a-f0-9]{24}$/.test(result.requestId||'')?result.requestId:null,
   message:action==='deactivate'&&result.valid?'This installation is deactivated.':result.valid?'Your license is ready.':'Your license could not be confirmed. Check your key or contact the software publisher.'}));
  if(!result.valid)process.exitCode=1;
 }
}catch{
 console.error('License check unavailable. Review configuration, connectivity and private storage permissions. Do not disable signature verification.');process.exitCode=2;
}
