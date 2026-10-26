// Node/Electron main only. Raw identifiers never leave this module or enter files/logs.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import {execFileSync} from "node:child_process";

const names = ["baseboard", "cpu", "disk", "nic", "machine"];
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const combined = components => sha(Object.keys(components).sort().map(name => `${name}=${components[name]}`).join("\n"));
const read = file => { try { return fs.readFileSync(file, "utf8").slice(0,65536).trim(); } catch { return ""; } };
const run = (file, args) => { try { return execFileSync(file,args,{encoding:"utf8",timeout:4000,maxBuffer:65536,windowsHide:true,stdio:["ignore","pipe","ignore"]}).trim(); } catch { return ""; } };
function usable(value) {
  if(typeof value!=="string")return "";
  const normalized=value.trim().toLowerCase().replace(/\s+/g," ");
  return !normalized||normalized.length>1024||["unknown","none","default string","to be filled by o.e.m.","system serial number","not specified","not applicable"].includes(normalized)||/^[0f:\- ]+$/.test(normalized)?"":normalized;
}
export function hashComponents(product,raw,isVirtual=null) {
  const salt=sha(`kdpika-hardware-v1|${product}`),components={};
  for(const name of Object.keys(raw).sort()) { const value=usable(raw[name]);if(names.includes(name)&&value)components[name]=sha(`${salt}|${name}|${value}`); }
  if(!Object.keys(components).some(name=>name!=="cpu"))throw new Error("Device information is unavailable.");
  return {version:1,hardware_id:combined(components),components,is_virtual:isVirtual};
}
export function collectFingerprint(product) {
  const raw={};let virtualText="";
  if(process.platform==="win32") {
    const command=`$ErrorActionPreference='SilentlyContinue';
      $board=(Get-CimInstance Win32_BaseBoard | Select-Object -First 1).SerialNumber;
      $cpu=(Get-CimInstance Win32_Processor | Select-Object -First 1).ProcessorId;
      $machine=(Get-CimInstance Win32_ComputerSystemProduct | Select-Object -First 1).UUID;
      $disk=(Get-Partition -DriveLetter $env:SystemDrive.Substring(0,1) | Get-Disk | Select-Object -First 1).SerialNumber;
      $nic=(Get-NetAdapter -Physical | Where-Object Status -eq 'Up' | Sort-Object InterfaceIndex | Select-Object -First 1).MacAddress;
      $model=(Get-CimInstance Win32_ComputerSystem).Model;
      @{baseboard=$board;cpu=$cpu;machine=$machine;disk=$disk;nic=$nic;model=$model} | ConvertTo-Json -Compress`;
    try {
      const data=JSON.parse(run("powershell.exe",["-NoLogo","-NoProfile","-NonInteractive","-Command",command]));
      for(const name of ["baseboard","cpu","disk","nic"])raw[name]=data[name];
      if(!usable(raw.baseboard))raw.machine=data.machine;
      virtualText=String(data.model??"");
    } catch {}
  } else if(process.platform==="darwin") {
    const registry=run("/usr/sbin/ioreg",["-rd1","-c","IOPlatformExpertDevice"]);
    raw.baseboard=registry.match(/"IOPlatformUUID"\s*=\s*"([^"\n]+)"/)?.[1]??"";
    raw.cpu=run("/usr/sbin/sysctl",["-n","machdep.cpu.brand_string"])||run("/usr/sbin/sysctl",["-n","hw.model"]);
    raw.nic=run("/sbin/ifconfig",["en0"]).match(/\bether\s+([0-9a-fA-F:]{17})/)?.[1]??"";
    virtualText=registry;
  } else if(process.platform==="linux") {
    raw.baseboard=read("/sys/class/dmi/id/board_serial")||read("/sys/class/dmi/id/product_uuid");
    if(!usable(raw.baseboard))raw.machine=read("/etc/machine-id")||read("/var/lib/dbus/machine-id");
    raw.cpu=read("/proc/cpuinfo").match(/^(?:model name|Hardware|Serial)\s*:\s*(.+)$/m)?.[1]??os.arch();
    try {
      for(const name of fs.readdirSync("/sys/class/block").sort()) {
        if(/^(loop|ram|dm-|sr)/.test(name)||fs.existsSync(`/sys/class/block/${name}/partition`))continue;
        const serial=read(`/sys/class/block/${name}/device/serial`);if(usable(serial)){raw.disk=serial;break;}
      }
      for(const name of fs.readdirSync("/sys/class/net").sort()) {
        if(!fs.existsSync(`/sys/class/net/${name}/device`)||read(`/sys/class/net/${name}/operstate`)!=="up")continue;
        raw.nic=read(`/sys/class/net/${name}/address`);break;
      }
    } catch {}
    virtualText=read("/sys/class/dmi/id/product_name")+" "+read("/sys/class/dmi/id/sys_vendor");
  } else throw new Error("Device information is unavailable.");
  return hashComponents(product,raw,virtualText?/vmware|virtualbox|virtual machine|qemu|kvm|parallels|xen/i.test(virtualText):null);
}
export function matchesBinding(binding,current) {
  if(!binding||binding.version!==1||!binding.components||Array.isArray(binding.components)||!binding.policy)return false;
  const saved=binding.components,policy=binding.policy,keys=Object.keys(saved),actual=current.components;
  if(!keys.length||keys.some(name=>!names.includes(name)||typeof saved[name]!=="string"||!/^[a-f0-9]{64}$/.test(saved[name]))||binding.hardware_id!==combined(saved))return false;
  if(policy.mode==="strict")return combined(saved)===combined(actual);
  if(policy.mode!=="fuzzy"||!Number.isInteger(policy.min_matches)||policy.min_matches<1||policy.min_matches>5)return false;
  if(["baseboard","cpu"].some(name=>saved[name]!==undefined&&saved[name]!==actual[name]))return false;
  return keys.filter(name=>saved[name]===actual[name]).length>=Math.min(keys.length,policy.min_matches);
}
