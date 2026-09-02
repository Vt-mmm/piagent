import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Buffer as NativeBuffer } from "node:buffer";
import { TextDecoder as NativeTextDecoder, TextEncoder as NativeTextEncoder } from "node:util";
import { StringDecoder as NativeStringDecoder } from "node:string_decoder";
import { setTimeout as sleep } from "node:timers/promises";

export const NODE_PROFILE_ID = "node-workload-api-v1";
export const NODE_PROFILE_WORKER_VERSION = "quickjs-node-profile-worker-v1";
export const NODE_PROFILE_NODE_VERSION = "22.19.0";
export const NODE_PROFILE_ICU_VERSION = "77.1";
export const NODE_PROFILE_RUNTIME_IDENTITY = Object.freeze({
  baseImage: "piagent-da2-node-g0:20260831-1231",
  baseImageId: "sha256:ae73771c2e50bcbfd18c19efe4c01cb800dbb66c408e2fc17d2de7e28cd18339",
  platform: "linux", architecture: "arm64", execPath: "/usr/local/bin/node",
  nodeBinarySha256: "79e8b4bcffeb26e6062a162c80125ea725ad1500f72c97f134a453ec557be32f",
  versionsSha256: "063b626b3d286dc5b854d4b2b2e511c324e59cf543f33992aa0de7b1ae313b77",
  buildConfigSha256: "af6e5b7ca6b5102da4dea55fea4b97ce1bbde02ce4591055f078254f3a82039a",
  dependencyFiles: 51,
  dependencyClosureSha256: "08d23bf1fcb2a1198d12eacfbaa6cfd9f9fa4a7d983f71e81be752c444e29e3c"
});
export const MAX_NODE_SERVICE_CALLS = 1024;
export const MAX_LIVE_DECODERS = 16;
export const MAX_TIMER_SCHEDULES = 64;
export const MAX_LIVE_TIMERS = 16;
const MAX_SERVICE_BYTES = 64 * 1024;
const MAX_TIMER_DELAY_MS = 5000;
const HERE = dirname(fileURLToPath(import.meta.url));
const DIGEST_FILES = ["Dockerfile", "package-lock.json", "worker.mjs", "protocol.mjs", "values.mjs", "intrinsics.mjs", "module-graph.mjs",
  "guest.mjs", "budget.mjs", "capabilities.mjs", "callback-intrinsics.mjs", "jobs.mjs", "references.mjs",
  "reference-identity.mjs", "invocation.mjs", "node-profile.mjs"];

export const NODE_PROFILE_MODULE_SOURCES = Object.freeze({
  "node:buffer": "const Buffer=globalThis.Buffer;export{Buffer};export default Object.freeze({Buffer});",
  buffer: "const Buffer=globalThis.Buffer;export{Buffer};export default Object.freeze({Buffer});",
  "node:util": "const {TextDecoder,TextEncoder,__piagentNodeTypes:types}=globalThis;export{TextDecoder,TextEncoder,types};export default Object.freeze({TextDecoder,TextEncoder,types});",
  util: "const {TextDecoder,TextEncoder,__piagentNodeTypes:types}=globalThis;export{TextDecoder,TextEncoder,types};export default Object.freeze({TextDecoder,TextEncoder,types});",
  "node:string_decoder": "const {StringDecoder}=globalThis;export{StringDecoder};export default Object.freeze({StringDecoder});",
  string_decoder: "const {StringDecoder}=globalThis;export{StringDecoder};export default Object.freeze({StringDecoder});",
  "node:timers": "const {setTimeout,clearTimeout}=globalThis;export{setTimeout,clearTimeout};export default Object.freeze({setTimeout,clearTimeout});",
  timers: "const {setTimeout,clearTimeout}=globalThis;export{setTimeout,clearTimeout};export default Object.freeze({setTimeout,clearTimeout});",
  "node:timers/promises": "const setTimeout=(delay,value)=>new Promise(resolve=>globalThis.setTimeout(resolve,delay,value));export{setTimeout};export default Object.freeze({setTimeout});",
  "timers/promises": "const setTimeout=(delay,value)=>new Promise(resolve=>globalThis.setTimeout(resolve,delay,value));export{setTimeout};export default Object.freeze({setTimeout});"
});
export const NODE_PROFILE_IMPORTS = Object.freeze(Object.keys(NODE_PROFILE_MODULE_SOURCES));

const sha256 = value => createHash("sha256").update(value).digest("hex");
const stable = value => value && typeof value === "object" ? Array.isArray(value) ? value.map(stable)
  : Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
let verifiedDefaultRuntimeIdentity = null;

function dependencyIdentity(root) {
  const rows = [];
  function walk(directory) {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name), stat = lstatSync(path), item = relative(root, path);
      if (stat.isDirectory()) walk(path);
      else if (stat.isSymbolicLink()) rows.push(["L", item, readlinkSync(path)]);
      else if (stat.isFile()) rows.push(["F", item, stat.size, sha256(readFileSync(path))]);
      else rows.push(["O", item, stat.mode]);
    }
  }
  walk(root);
  return { dependencyFiles: rows.length, dependencyClosureSha256: sha256(JSON.stringify(rows)) };
}

export function assertNodeRuntimeIdentity(expected = NODE_PROFILE_RUNTIME_IDENTITY) {
  if (expected === NODE_PROFILE_RUNTIME_IDENTITY && verifiedDefaultRuntimeIdentity) {
    return verifiedDefaultRuntimeIdentity;
  }
  const actual = {
    platform: process.platform, architecture: process.arch, execPath: process.execPath,
    nodeBinarySha256: sha256(readFileSync(process.execPath)),
    versionsSha256: sha256(JSON.stringify(stable(process.versions))),
    buildConfigSha256: sha256(JSON.stringify(stable(process.config))),
    ...dependencyIdentity(join(HERE, "node_modules"))
  };
  for (const key of Object.keys(actual)) if (actual[key] !== expected[key]) throw new Error("Pinned Node profile runtime mismatch");
  const verified = Object.freeze(actual);
  if (expected === NODE_PROFILE_RUNTIME_IDENTITY) verifiedDefaultRuntimeIdentity = verified;
  return verified;
}

export function nodeProfileDigest(runtimeIdentity = NODE_PROFILE_RUNTIME_IDENTITY) {
  const files = DIGEST_FILES.map(name => [name, createHash("sha256").update(readFileSync(join(HERE, name))).digest("hex")]);
  return createHash("sha256").update(JSON.stringify({ id: NODE_PROFILE_ID, workerVersion: NODE_PROFILE_WORKER_VERSION,
    runtimeIdentity, node: NODE_PROFILE_NODE_VERSION, icu: NODE_PROFILE_ICU_VERSION, quickjs: "0.32.0", files,
    resources: [MAX_NODE_SERVICE_CALLS, MAX_LIVE_DECODERS, MAX_TIMER_SCHEDULES, MAX_LIVE_TIMERS, MAX_SERVICE_BYTES] })).digest("hex");
}

export function expectedNodeProfile() {
  return Object.freeze({ id: NODE_PROFILE_ID, digest: nodeProfileDigest(), workerVersion: NODE_PROFILE_WORKER_VERSION });
}

// The factory is evaluated before candidate code. It captures every intrinsic
// used by facades and returns private observer/scheduler methods only to Node.
const PROFILE_FACTORY = `((bridge) => {
  const apply=Reflect.apply, define=Object.defineProperty, descriptor=Object.getOwnPropertyDescriptor,create=Object.create,remove=Reflect.deleteProperty;
  const S=String,N=Number,B=Boolean,freeze=Object.freeze,stringSlice=String.prototype.slice,stringIndex=String.prototype.indexOf,stringEnds=String.prototype.endsWith;
  const U8=Uint8Array,AB=ArrayBuffer,DV=DataView,TE=TypeError,RE=RangeError,E=Error,P=Promise;
  const typed=Object.getPrototypeOf(U8.prototype), getBuffer=descriptor(typed,'buffer').get;
  const getOffset=descriptor(typed,'byteOffset').get,getLength=descriptor(typed,'byteLength').get;
  const dvBuffer=descriptor(DV.prototype,'buffer').get,dvOffset=descriptor(DV.prototype,'byteOffset').get;
  const dvLength=descriptor(DV.prototype,'byteLength').get,abLength=descriptor(AB.prototype,'byteLength').get;
  const abSlice=AB.prototype.slice,u8Subarray=U8.prototype.subarray,weakAdd=WeakSet.prototype.add,weakHas=WeakSet.prototype.has;
  const bufferBrand=new WeakSet(),decoderBrand=new WeakSet(),encoderBrand=new WeakSet(),stringDecoderBrand=new WeakSet();
  const TOKEN={},M=Map,timers=new M(),mapGet=M.prototype.get,mapSet=M.prototype.set,mapDelete=M.prototype.delete;
  const data=(value,enumerable=false)=>{const out=create(null);out.value=value;out.writable=true;out.configurable=true;out.enumerable=enumerable;return out;};
  function service(op,a,b,c,d) {
    const frame=bridge(op,a,b,c,d);if(typeof frame!=='string'||frame.length<2||frame[1]!==':')throw new E('node-profile-unavailable');
    const tag=frame[0],body=apply(stringSlice,frame,[2]);
    if(tag==='f')throw new E('node-profile-unavailable');
    if(tag==='e'){if(body==='R')throw new RE('native-api-error');throw new TE('native-api-error');}
    if(tag==='s')return body;if(tag==='n')return N(body);if(tag==='b')return body==='1';
    if(tag==='x') {const first=apply(stringIndex,body,[':']),second=apply(stringIndex,body,[':',first+1]);
      if(first<1||second<=first+1)throw new E('node-profile-unavailable');const out=create(null);
      out.read=N(apply(stringSlice,body,[0,first]));out.written=N(apply(stringSlice,body,[first+1,second]));out.backingBase64=apply(stringSlice,body,[second+1]);return out;}
    throw new E('node-profile-unavailable');
  }
  function base64Bytes(text) {
    const chars='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/', clean=S(text), pad=apply(stringEnds,clean,['=='])?2:apply(stringEnds,clean,['='])?1:0;
    const out=new U8(clean.length/4*3-pad);let at=0;
    for(let i=0;i<clean.length;i+=4){const a=apply(stringIndex,chars,[clean[i]]),b=apply(stringIndex,chars,[clean[i+1]]);
      const c=clean[i+2]==='='?0:apply(stringIndex,chars,[clean[i+2]]),d=clean[i+3]==='='?0:apply(stringIndex,chars,[clean[i+3]]);
      const value=(a<<18)|(b<<12)|(c<<6)|d;if(at<out.length)out[at++]=(value>>16)&255;if(at<out.length)out[at++]=(value>>8)&255;if(at<out.length)out[at++]=value&255;}
    return out;
  }
  function bytesBase64(view) {
    const chars='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/', length=view.length;let out='';
    for(let i=0;i<length;i+=3){const a=view[i],b=i+1<length?view[i+1]:0,c=i+2<length?view[i+2]:0,n=(a<<16)|(b<<8)|c;
      out+=chars[(n>>18)&63]+chars[(n>>12)&63]+(i+1<length?chars[(n>>6)&63]:'=')+(i+2<length?chars[n&63]:'=');}return out;
  }
  function viewInfo(value) {
    try { const buffer=apply(getBuffer,value,[]);return {buffer,offset:apply(getOffset,value,[]),length:apply(getLength,value,[]),kind:apply(weakHas,bufferBrand,[value])?'buffer':'uint8array'}; } catch {}
    try { return {buffer:apply(dvBuffer,value,[]),offset:apply(dvOffset,value,[]),length:apply(dvLength,value,[]),kind:'dataview'}; } catch {}
    try { const length=apply(abLength,value,[]);return {buffer:value,offset:0,length,kind:'arraybuffer'}; } catch { return null; }
  }
  function visibleBuffer(value) { const info=viewInfo(value);if(!info)throw new TE('Expected byte view');return apply(abSlice,info.buffer,[info.offset,info.offset+info.length]); }
  function encoded(value) { const info=viewInfo(value);if(!info)throw new TE('Expected byte view');return bytesBase64(new U8(info.buffer)); }
  class BufferFacade extends U8 {
    constructor(buffer,offset,length,token){if(token!==TOKEN){service('deny','buffer-constructor-unsupported');throw new TE('Use Buffer.from or Buffer.alloc');}
      super(buffer,offset,length);apply(weakAdd,bufferBrand,[this]);}
    static from(value,encodingOrOffset,length){
      if(typeof value==='string'){const bytes=base64Bytes(service('buffer-from-string',value,encodingOrOffset===undefined?0:1,encodingOrOffset===undefined?'':S(encodingOrOffset)));return new BufferFacade(bytes.buffer,0,bytes.length,TOKEN);}
      let ab;
      try { const size=apply(abLength,value,[]),offset=encodingOrOffset===undefined?0:N(encodingOrOffset),count=length===undefined?size-offset:N(length);
        if(!Number.isSafeInteger(offset)||!Number.isSafeInteger(count)||offset<0||count<0||offset+count>size)throw new RE('Invalid byte range');return new BufferFacade(value,offset,count,TOKEN); } catch(error){if(error instanceof RE)throw error;}
      const info=viewInfo(value);if(info){const copy=new U8(visibleBuffer(value));return new BufferFacade(copy.buffer,0,copy.length,TOKEN);}
      const copy=new U8(value);return new BufferFacade(copy.buffer,0,copy.length,TOKEN);
    }
    static alloc(size,fill=0,encoding){size=N(size);if(!Number.isSafeInteger(size)||size<0||size>4096)throw new RE('Invalid size');const out=new BufferFacade(new AB(size),0,size,TOKEN);return out.fill(fill,0,size,encoding);}
    static concat(list,totalLength){if(!Array.isArray(list))throw new TE('list must be an array');const views=list.map(value=>BufferFacade.from(value));
      const size=totalLength===undefined?views.reduce((n,v)=>n+v.length,0):N(totalLength);if(!Number.isSafeInteger(size)||size<0||size>4096)throw new RE('Invalid size');
      const out=BufferFacade.alloc(size);let at=0;for(const view of views){for(let i=0;i<view.length&&at<size;i++)out[at++]=view[i];}return out;}
    static isBuffer(value){return apply(weakHas,bufferBrand,[value]);}
    static isEncoding(value){return service('buffer-is-encoding',S(value));}
    static byteLength(value,encoding){return service('buffer-byte-length',S(value),encoding===undefined?0:1,encoding===undefined?'':S(encoding));}
    static compare(left,right){left=BufferFacade.from(left);right=BufferFacade.from(right);return service('buffer-compare',visibleBuffer(left),visibleBuffer(right));}
    toString(encoding='utf8',start=0,end=this.length){return service('buffer-to-string',S(encoding),N(start),N(end),visibleBuffer(this));}
    equals(other){return BufferFacade.compare(this,other)===0;}
    compare(other){return BufferFacade.compare(this,other);}
    copy(target,targetStart=0,sourceStart=0,sourceEnd=this.length){const info=viewInfo(target);if(!info)throw new TE('target must be byte view');
      targetStart=N(targetStart);sourceStart=N(sourceStart);sourceEnd=N(sourceEnd);let count=0;
      for(let i=sourceStart;i<sourceEnd&&i<this.length&&targetStart+count<info.length;i++)target[targetStart+count++]=this[i];return count;}
    fill(value,start=0,end=this.length,encoding){start=N(start);end=N(end);let pattern;
      if(typeof value==='number')pattern=new U8([value&255]);else if(typeof value==='string')pattern=BufferFacade.from(value,encoding);else pattern=BufferFacade.from(value);
      if(!pattern.length)throw new TE('Invalid fill value');for(let i=start;i<end&&i<this.length;i++)this[i]=pattern[(i-start)%pattern.length];return this;}
    write(value,offset=0,length=this.length-offset,encoding='utf8'){const bytes=BufferFacade.from(S(value),encoding);offset=N(offset);length=N(length);let count=0;
      for(;count<bytes.length&&count<length&&offset+count<this.length;count++)this[offset+count]=bytes[count];return count;}
    indexOf(value,offset=0,encoding){const needle=BufferFacade.from(value,encoding);offset=Math.max(0,N(offset)||0);outer:for(let i=offset;i+needle.length<=this.length;i++){for(let j=0;j<needle.length;j++)if(this[i+j]!==needle[j])continue outer;return i;}return -1;}
    lastIndexOf(value,offset=this.length-1,encoding){const needle=BufferFacade.from(value,encoding);for(let i=Math.min(N(offset),this.length-needle.length);i>=0;i--){let same=true;for(let j=0;j<needle.length;j++)same&&=this[i+j]===needle[j];if(same)return i;}return -1;}
    includes(value,offset=0,encoding){return this.indexOf(value,offset,encoding)!==-1;}
    subarray(start=0,end=this.length){const own=viewInfo(this),plain=new U8(own.buffer,own.offset,own.length),view=apply(u8Subarray,plain,[start,end]);
      const info=viewInfo(view);return new BufferFacade(info.buffer,info.offset,info.length,TOKEN);}
    slice(start=0,end=this.length){return this.subarray(start,end);}
    toJSON(){const values=[];for(let i=0;i<this.length;i++)values.push(this[i]);return {type:'Buffer',data:values};}
  }
  class Decoder {
    #id;constructor(label='utf-8',options={}){this.#id=service('decoder-new',S(label),B(options.fatal)?1:0,B(options.ignoreBOM)?1:0);apply(weakAdd,decoderBrand,[this]);}
    decode(input=new U8(),options={}){return service('decoder-decode',this.#id,B(options.stream)?1:0,visibleBuffer(input));}
    get encoding(){return service('decoder-encoding',this.#id);}get fatal(){return service('decoder-fatal',this.#id);}get ignoreBOM(){return service('decoder-ignore-bom',this.#id);}
  }
  class Encoder {
    constructor(){apply(weakAdd,encoderBrand,[this]);}get encoding(){return 'utf-8';}
    encode(value=''){const bytes=base64Bytes(service('encoder-encode',S(value)));return new U8(bytes);}
    encodeInto(value,target){const info=viewInfo(target);if(!info||info.kind==='arraybuffer'||info.kind==='dataview')throw new TE('destination must be Uint8Array');
      const out=service('encoder-encode-into',S(value),info.length);const bytes=base64Bytes(out.backingBase64);for(let i=0;i<bytes.length;i++)target[i]=bytes[i];return {read:out.read,written:out.written};}
  }
  class StringDecoderFacade {
    #id;constructor(encoding='utf8'){this.#id=service('string-decoder-new',S(encoding));apply(weakAdd,stringDecoderBrand,[this]);}
    write(value){return service('string-decoder-write',this.#id,visibleBuffer(value));}
    end(value){return value===undefined?service('string-decoder-end',this.#id):service('string-decoder-end',this.#id,visibleBuffer(value));}
  }
  const types=freeze({isUint8Array:value=>{const info=viewInfo(value);return !!info&&(info.kind==='uint8array'||info.kind==='buffer');},
    isTypedArray:value=>{const info=viewInfo(value);return !!info&&(info.kind==='uint8array'||info.kind==='buffer');},
    isArrayBuffer:value=>viewInfo(value)?.kind==='arraybuffer',isAnyArrayBuffer:value=>viewInfo(value)?.kind==='arraybuffer',isDataView:value=>viewInfo(value)?.kind==='dataview'});
  function schedule(callback,delay,...args){if(typeof callback!=='function')throw new TE('callback must be a function');delay=N(delay);if(!Number.isFinite(delay)||delay<0)delay=0;
    const id=service('timer-schedule',delay);apply(mapSet,timers,[id,{callback,args}]);return id;}
  function cancel(id){id=N(id);if(apply(mapDelete,timers,[id]))service('timer-cancel',id);}
  const denyInterval=()=>{service('deny','timer-interval-unsupported');};
  define(globalThis,'Buffer',data(BufferFacade));define(globalThis,'TextDecoder',data(Decoder));define(globalThis,'TextEncoder',data(Encoder));
  define(globalThis,'StringDecoder',data(StringDecoderFacade));define(globalThis,'setTimeout',data(schedule));define(globalThis,'clearTimeout',data(cancel));
  define(globalThis,'setInterval',data(denyInterval));define(globalThis,'clearInterval',data(denyInterval));define(globalThis,'__piagentNodeTypes',data(types));
  for(const [name,op] of [['normalize','normalize'],['toLowerCase','lower'],['toUpperCase','upper'],['toLocaleLowerCase','locale-lower'],['toLocaleUpperCase','locale-upper']])
    define(String.prototype,name,data(function(arg){return service('unicode',op,S(this),arg===undefined?0:1,arg===undefined?'':S(arg));},false));
  function makeTyped(kind,base64,offset,length){const bytes=base64Bytes(base64),buffer=bytes.buffer;if(kind==='arraybuffer')return buffer;
    if(kind==='buffer')return new BufferFacade(buffer,offset,length,TOKEN);if(kind==='dataview')return new DV(buffer,offset,length);return new U8(buffer,offset,length);}
  function observeTypedValue(value){const info=viewInfo(value);if(!info)return '';if(apply(abLength,info.buffer,[])>4096)throw 'typed-backing-limit';
    return '{"type":"'+info.kind+'","value":{"backingBase64":"'+encoded(value)+'","byteOffset":'+info.offset+',"byteLength":'+info.length+'}}';}
  function observeTyped(value){try{const typed=observeTypedValue(value);return typed?'{"typed":true,"value":'+typed+'}':'{"typed":false}';}
    catch(reason){return '{"reason":"'+(reason==='typed-backing-limit'?reason:'return-type-unsupported')+'"}';}}
  function fireTimer(id){const timer=apply(mapGet,timers,[id]);if(!timer)return false;apply(mapDelete,timers,[id]);apply(timer.callback,undefined,timer.args);return true;}
  function finishBootstrap(){remove(globalThis,'__piagentNodeTypes');remove(globalThis,'StringDecoder');}
  return {makeTyped,observeTyped,observeTypedValue,fireTimer,finishBootstrap};
})`;

const apiError = (error) => error instanceof RangeError ? "RangeError" : error instanceof TypeError ? "TypeError" : null;

/** Request-owned native services. Candidate values cross only as primitives or copied ArrayBuffers. */
export function createNodeProfile({ runtime, context, retain, interrupted }) {
  assertNodeRuntimeIdentity();
  const decoders = new Map(), stringDecoders = new Map(), timers = new Map();
  const trace = [], totals = { calls: 0, rawBytes: 0, textBytes: 0, decodersCreated: 0, timersScheduled: 0, denials: 0 };
  let counters = { calls: 0, rawBytes: 0, textBytes: 0, decodersCreated: 0, timersScheduled: 0, denials: 0 };
  let active = true, fault = null, faultOutcome = null, nextDecoder = 1, nextTimer = 1, timerSequence = 0;
  const count = (field, amount = 1) => { counters[field] += amount; totals[field] += amount; };
  const latch = (reason, outcome = "error") => { fault ??= reason; faultOutcome ??= outcome; return fault; };
  const accountText = value => { count("textBytes", NativeBuffer.byteLength(String(value))); if (counters.rawBytes + counters.textBytes > MAX_SERVICE_BYTES) latch("node-service-byte-limit"); };
  const accountBytes = value => { count("rawBytes", value.byteLength); if (counters.rawBytes + counters.textBytes > MAX_SERVICE_BYTES) latch("node-service-byte-limit"); };
  const frame = (kind, value = "") => context.newString(`${kind}:${value}`);
  const fail = (reason, outcome = "error") => frame("f", latch(reason, outcome));
  const text = handle => {
    if (context.typeof(handle) !== "string") return null;
    const value = context.getString(handle);
    if (NativeBuffer.byteLength(value) > 16384) { latch("node-service-metadata-limit"); return null; }
    accountText(value); return value;
  };
  const number = handle => context.typeof(handle) === "number" ? context.getNumber(handle) : NaN;
  const flag = handle => { const value = number(handle); return value === 0 ? false : value === 1 ? true : null; };
  const absent = handle => context.typeof(handle) === "undefined";
  const copied = handle => { const borrowed = context.getArrayBuffer(handle); try { const value = Uint8Array.from(borrowed.value); accountBytes(value); return value; } finally { borrowed.dispose(); } };
  function bridge(opHandle, a, b, c, d) {
    count("calls");
    if (!active || fault) return fail(fault ?? "node-profile-inactive");
    if (counters.calls > MAX_NODE_SERVICE_CALLS || interrupted()) return fail("node-service-call-limit");
    const op = text(opHandle);
    if (op === null || fault) return fail(fault ?? "node-service-shape");
    try {
      if (op === "deny") {
        const reason = text(a); if (reason === null || !absent(b) || !absent(c) || !absent(d)) return fail("node-service-shape");
        count("denials"); return fail(reason, "unsupported");
      }
      if (op === "decoder-new") {
        const label = text(a), fatal = flag(b), ignoreBOM = flag(c);
        if (label === null || fatal === null || ignoreBOM === null || !absent(d)) return fail("node-service-shape");
        if (decoders.size + stringDecoders.size >= MAX_LIVE_DECODERS) return fail("node-decoder-limit");
        const decoder = new NativeTextDecoder(label, { fatal, ignoreBOM }), id = nextDecoder++;
        decoders.set(id, decoder); count("decodersCreated"); return frame("n", id);
      }
      if (["decoder-encoding", "decoder-fatal", "decoder-ignore-bom"].includes(op)) {
        const id = number(a); if (!Number.isSafeInteger(id) || !decoders.has(id) || !absent(b) || !absent(c) || !absent(d)) return fail("node-service-shape");
        const key = op === "decoder-encoding" ? "encoding" : op === "decoder-fatal" ? "fatal" : "ignoreBOM";
        const value = decoders.get(id)[key]; return typeof value === "boolean" ? frame("b", value ? 1 : 0) : frame("s", value);
      }
      if (op === "decoder-decode") {
        const id = number(a), stream = flag(b);
        if (!Number.isSafeInteger(id) || !decoders.has(id) || stream === null || absent(c) || !absent(d)) return fail("node-service-shape");
        const value = decoders.get(id).decode(copied(c), { stream }); accountText(value); return fault ? fail(fault) : frame("s", value);
      }
      if (op === "encoder-encode") {
        const input = text(a); if (input === null || !absent(b) || !absent(c) || !absent(d)) return fail("node-service-shape");
        const value = new NativeTextEncoder().encode(input); accountBytes(value); return fault ? fail(fault) : frame("s", NativeBuffer.from(value).toString("base64"));
      }
      if (op === "encoder-encode-into") {
        const input = text(a), capacity = number(b);
        if (input === null || !Number.isSafeInteger(capacity) || capacity < 0 || capacity > 4096 || !absent(c) || !absent(d)) return fail("node-service-shape");
        const target = new Uint8Array(capacity), result = new NativeTextEncoder().encodeInto(input, target), value = target.subarray(0, result.written);
        accountBytes(value); return fault ? fail(fault) : frame("x", `${result.read}:${result.written}:${NativeBuffer.from(value).toString("base64")}`);
      }
      if (op === "string-decoder-new") {
        const encoding = text(a); if (encoding === null || !absent(b) || !absent(c) || !absent(d)) return fail("node-service-shape");
        if (decoders.size + stringDecoders.size >= MAX_LIVE_DECODERS) return fail("node-decoder-limit");
        const id = nextDecoder++; stringDecoders.set(id, new NativeStringDecoder(encoding)); count("decodersCreated"); return frame("n", id);
      }
      if (["string-decoder-write", "string-decoder-end"].includes(op)) {
        const id = number(a), hasBytes = !absent(b);
        if (!Number.isSafeInteger(id) || !stringDecoders.has(id) || !absent(c) || !absent(d)
          || op === "string-decoder-write" && !hasBytes) return fail("node-service-shape");
        const decoder = stringDecoders.get(id), bytes = hasBytes ? copied(b) : undefined;
        const value = op === "string-decoder-write" ? decoder.write(bytes) : decoder.end(bytes); accountText(value); return fault ? fail(fault) : frame("s", value);
      }
      if (op === "buffer-from-string") {
        const input = text(a), hasEncoding = flag(b), encoding = text(c);
        if (input === null || hasEncoding === null || encoding === null || !absent(d)) return fail("node-service-shape");
        const value = NativeBuffer.from(input, hasEncoding ? encoding : undefined); accountBytes(value); return fault ? fail(fault) : frame("s", value.toString("base64"));
      }
      if (op === "buffer-is-encoding") {
        const value = text(a); if (value === null || !absent(b) || !absent(c) || !absent(d)) return fail("node-service-shape");
        return frame("b", NativeBuffer.isEncoding(value) ? 1 : 0);
      }
      if (op === "buffer-byte-length") {
        const value = text(a), hasEncoding = flag(b), encoding = text(c);
        if (value === null || hasEncoding === null || encoding === null || !absent(d)) return fail("node-service-shape");
        return frame("n", NativeBuffer.byteLength(value, hasEncoding ? encoding : undefined));
      }
      if (op === "buffer-to-string") {
        const encoding = text(a), start = number(b), end = number(c);
        if (encoding === null || !Number.isFinite(start) || !Number.isFinite(end) || absent(d)) return fail("node-service-shape");
        const value = NativeBuffer.from(copied(d)).toString(encoding, start, end); accountText(value); return fault ? fail(fault) : frame("s", value);
      }
      if (op === "buffer-compare") {
        if (absent(a) || absent(b) || !absent(c) || !absent(d)) return fail("node-service-shape");
        return frame("n", NativeBuffer.compare(copied(a), copied(b)));
      }
      if (op === "unicode") {
        const operation = text(a), value = text(b), hasArg = flag(c), arg = text(d);
        if (operation === null || value === null || hasArg === null || arg === null) return fail("node-service-shape");
        const operations = { normalize: () => value.normalize(hasArg ? arg : undefined), lower: () => value.toLowerCase(), upper: () => value.toUpperCase(),
          "locale-lower": () => value.toLocaleLowerCase(hasArg ? arg : undefined), "locale-upper": () => value.toLocaleUpperCase(hasArg ? arg : undefined) };
        if (!operations[operation]) return fail("node-unicode-operation", "unsupported"); const output = operations[operation](); accountText(output);
        return fault ? fail(fault) : frame("s", output);
      }
      if (op === "timer-schedule") {
        const requested = number(a);
        if (!Number.isFinite(requested) || !absent(b) || !absent(c) || !absent(d)) return fail("node-service-shape");
        if (counters.timersScheduled >= MAX_TIMER_SCHEDULES || timers.size >= MAX_LIVE_TIMERS || requested > MAX_TIMER_DELAY_MS) return fail("node-timer-limit");
        const delay = Math.max(1, Math.trunc(requested)), id = nextTimer++; timers.set(id, { id, delay, due: performance.now() + delay });
        count("timersScheduled"); trace.push({ sequence: timerSequence++, event: "schedule", id, delay }); return frame("n", id);
      }
      if (op === "timer-cancel") {
        const id = number(a); if (!Number.isSafeInteger(id) || !absent(b) || !absent(c) || !absent(d)) return fail("node-service-shape");
        if (timers.delete(id)) trace.push({ sequence: timerSequence++, event: "cancel", id }); return frame("b", 1);
      }
      return fail("node-service-operation", "unsupported");
    } catch (error) {
      const kind = apiError(error); return kind ? frame("e", kind === "RangeError" ? "R" : "T") : fail("node-service-fault");
    }
  }
  const bridgeHandle = retain(context.newFunction("privateNodeProfileService", bridge));
  const factoryResult = context.evalCode(PROFILE_FACTORY);
  if (factoryResult.error) { factoryResult.error.dispose(); throw new Error("Node profile bootstrap failed"); }
  const factory = retain(factoryResult.value), installedResult = context.callFunction(factory, context.undefined, bridgeHandle);
  if (installedResult.error) { installedResult.error.dispose(); throw new Error("Node profile install failed"); }
  const installed = retain(installedResult.value), methods = {};
  for (const name of ["makeTyped", "observeTyped", "observeTypedValue", "fireTimer", "finishBootstrap"]) methods[name] = retain(context.getProp(installed, name));
  const preloadSource = NODE_PROFILE_IMPORTS.map((name, index) => `import * as profile${index} from ${JSON.stringify(name)};`).join("\n");
  const preload = context.evalCode(preloadSource, "piagent-node-profile-preload.mjs", { type: "module" });
  if (preload.error) { preload.error.dispose(); throw new Error("Node profile module preload failed"); }
  retain(preload.value);
  let preloadJobs = 0;
  while (runtime.hasPendingJob()) {
    if (interrupted() || preloadJobs++ >= 128) throw new Error("Node profile module preload stalled");
    const pending = runtime.executePendingJobs(1);
    if (pending.error) { pending.error.dispose(); throw new Error("Node profile module preload failed"); }
  }
  const finished = context.callFunction(methods.finishBootstrap, context.undefined);
  if (finished.error) { finished.error.dispose(); throw new Error("Node profile bootstrap cleanup failed"); }
  finished.value.dispose();
  return {
    methods,
    beginCase() { counters = { calls: 0, rawBytes: 0, textBytes: 0, decodersCreated: 0, timersScheduled: 0, denials: 0 }; },
    caseCounters() { return { ...counters }; },
    totals() { return { ...totals }; },
    fault() { return fault ? { reason: fault, outcome: faultOutcome } : null; },
    timerTrace() { return trace.map(item => ({ ...item })); },
    pendingTimers() { return timers.size; },
    async fireNext() {
      if (!timers.size || interrupted()) return false;
      const timer = [...timers.values()].sort((a, b) => a.due - b.due || a.id - b.id)[0], wait = Math.max(0, timer.due - performance.now());
      if (wait) await sleep(wait);
      if (!active || interrupted() || !timers.delete(timer.id)) return false;
      trace.push({ sequence: timerSequence++, event: "fire", id: timer.id, delay: timer.delay });
      const id = context.newNumber(timer.id), result = context.callFunction(methods.fireTimer, context.undefined, id); id.dispose();
      if (result.error) { result.error.dispose(); latch("node-timer-callback-fault"); return false; }
      result.value.dispose(); return true;
    },
    quiescence(receiverCount = 0) { return { pendingTimers: timers.size, liveDecoders: decoders.size + stringDecoders.size, receivers: receiverCount }; },
    dispose() { active = false; timers.clear(); decoders.clear(); stringDecoders.clear(); }
  };
}
