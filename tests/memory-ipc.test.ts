import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test, type TestContext } from "node:test";
import { createLabTlsIdentity } from "@dexter/devices";
import { sendMemoryIdentity } from "./fixtures/memory-identity-channel.js";
import { observeChild, childExitError } from "./fixtures/child-observation.js";
const moduleURL=new URL("./fixtures/memory-identity-channel.js",import.meta.url).href;
function child(t: TestContext, script: string) {
  const c=spawn(process.execPath,["--input-type=module","-e",script],{env:{PATH:"/usr/bin:/bin"},stdio:["ignore","pipe","pipe","ipc"]});
  const observed=observeChild(c);let stdout="";c.stdout!.on("data",b=>{stdout+=b.toString();if(stdout.length>1024)c.kill("SIGKILL");});
  t.after(async()=>{if(c.exitCode===null&&c.signalCode===null)c.kill("SIGKILL");await observed.closed;});
  return {c,observed,output:()=>stdout};
}
const receiver=(delay=0)=>`import {receiveMemoryIdentity} from ${JSON.stringify(moduleURL)};await new Promise(r=>setTimeout(r,${delay}));await receiveMemoryIdentity({timeoutMs:500});process.stdout.write("started");`;
test("delayed child listener installs before READY: identity follows request, ACK precedes continuation",async t=>{
  const id=createLabTlsIdentity({profile:"client",name:"ipc-client"}).identity,s=child(t,receiver(50)),trace:string[]=[];
  s.c.on("message",(v:unknown)=>trace.push((v as {kind:string}).kind));
  const original=s.c.send.bind(s.c);s.c.send=((v:unknown,...rest:unknown[])=>{assert.deepEqual(trace,["memory-ready"]);trace.push("identity");return Reflect.apply(original,s.c,[v,...rest]);}) as typeof s.c.send;
  await sendMemoryIdentity(s.c,id,1000);const closed=await s.observed.closed;
  assert.deepEqual(trace,["memory-ready","identity","memory-ack"]);assert.equal(s.output(),"started");assert.equal(closed.exitCode,0);assert.equal(closed.stderr.category,"none");
});
test("closed wire rejects extra fields and mismatched cert fingerprint before child continuation",async t=>{
  const id=createLabTlsIdentity({profile:"client",name:"ipc-invalid"}).identity;
  for(const extra of [{extra:true},{fingerprint:"0".repeat(64)}]) {
    const s=child(t,receiver()),trace:string[]=[];
    s.c.on("message",(v:unknown)=>{const kind=(v as {kind:string}).kind;trace.push(kind);if(kind==="memory-ready")s.c.send({kind:"memory-identity",version:1,cert:id.certPem,key:id.keyPem,fingerprint:id.fingerprint,...extra});});
    const closed=await s.observed.closed;assert.notEqual(closed.exitCode,0);assert.equal(closed.stderr.category,"memory_ipc");assert.equal(s.output(),"");assert.deepEqual(trace,["memory-ready"]);
  }
});
test("child startup failure exposes bounded sanitized category and actual exit metadata only",async t=>{
  const s=child(t,'process.stderr.write("ERR_MODULE_NOT_FOUND SYNTHETIC-PRIVATE-MARKER");process.exit(7);'),id=createLabTlsIdentity({profile:"client",name:"ipc-startup"}).identity;
  await assert.rejects(sendMemoryIdentity(s.c,id,1000),/memory IPC child_closed/);
  const observation=await s.observed.closed;assert.equal(observation.exitCode,7);assert.equal(observation.signal,null);assert.equal(observation.stderr.category,"module_resolution");
  assert.ok(!childExitError(observation).message.includes("SYNTHETIC-PRIVATE-MARKER"));assert.equal(observation.stderr.truncated,false);
});
test("no readiness times out and owned child signal is observed; stderr overflow stays redacted",async t=>{
  const id=createLabTlsIdentity({profile:"client",name:"ipc-timeout"}).identity,s=child(t,'process.stderr.write("SYNTHETIC-PRIVATE-MARKER".repeat(2000));setInterval(()=>{},1000);');
  await assert.rejects(sendMemoryIdentity(s.c,id,300),/memory IPC timeout/);s.c.kill("SIGTERM");
  const observation=await s.observed.closed;assert.equal(observation.exitCode,null);assert.equal(observation.signal,"SIGTERM");assert.equal(observation.stderr.category,"overflow");assert.equal(observation.stderr.truncated,true);assert.ok(!JSON.stringify(observation).includes("PRIVATE"));
});
