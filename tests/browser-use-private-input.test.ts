import { strict as assert } from "node:assert";
import { test } from "node:test";
import { PassThrough } from "node:stream";
import { spawn, execFileSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, rmSync, writeSync, constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { bindBrowserUsePrivateInput } from "../packages/cli/src/browser-use-private-input.js";

const hostID = "host_synthetic", key = "synthetic-browser-use-key-0000";
const requestId = "00000000-0000-0000-0000-000000000001";
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function ownFifo(directory:string):number {
  const path=join(directory,"owned-private-input");
  execFileSync("/usr/bin/mkfifo",["-m","600",path],{stdio:"ignore"});
  return openSync(path,constants.O_RDWR);
}
test("owned pipe binds host identity, keeps acknowledgements secret-free and locks on close", async () => {
  const pipe = new PassThrough(), events:string[]=[], output:string[]=[];
  const bridge = bindBrowserUsePrivateInput(pipe,hostID,{set(value){assert.equal(value,key);events.push("set");},async lock(){events.push("lock");}},line=>output.push(line));
  const command = {schema:"dexter.browser-use-key/1",requestId,hostID,operation:"set",key};
  pipe.write(JSON.stringify({...command,hostID:"host_other"})+"\n");await tick();
  assert.deepEqual(events,[]);assert.equal(JSON.parse(output[0]!).status,"refused");
  const bytes=Buffer.from(JSON.stringify(command)+"\n");pipe.write(bytes.subarray(0,20));pipe.write(bytes.subarray(20));await tick();
  assert.deepEqual(events,["lock","set"]);assert.equal(JSON.parse(output[1]!).status,"ready");
  pipe.write(JSON.stringify(command)+"\n");await tick();assert.deepEqual(events,["lock","set","lock","set"]);
  assert.ok(output.every(line=>!line.includes(key)));await bridge.close();assert.deepEqual(events,["lock","set","lock","set","lock"]);
});
test("malformed or oversized private input locks and closes admission without echoing it", async()=>{
  for(const input of ["not a frame\n", "x".repeat(16_385)]){
    const pipe=new PassThrough(),output:string[]=[],events:string[]=[];
    const bridge=bindBrowserUsePrivateInput(pipe,hostID,{set(){events.push("set");},async lock(){events.push("lock");}},line=>output.push(line));
    pipe.write(input);await tick();pipe.write(JSON.stringify({schema:"dexter.browser-use-key/1",requestId,hostID,operation:"set",key})+"\n");await tick();
    assert.ok(events.includes("lock"));assert.ok(!events.includes("set"));assert.deepEqual(output,[]);await bridge.close();
  }
});
test("startup unlock consumes only one frame and leaves the same owned pipe usable for private keys", async()=>{
  const module=pathToFileURL(join(process.cwd(),"packages/cli/dist/browser-use-private-input.js")).href;
  const dir=mkdtempSync(join(tmpdir(),"dexter-browser-unlock-")),fd=ownFifo(dir);
  writeSync(fd,JSON.stringify({schema:"dexter.private-input/1",kind:"unlock",passwordBase64:Buffer.from("synthetic-custody-passphrase").toString("base64")})+"\n");
  writeSync(fd,JSON.stringify({schema:"dexter.browser-use-key/1",requestId,hostID,operation:"set",key})+"\n");
  const child=spawn(process.execPath,["--input-type=module","-e",`import {readBrowserUseUnlockFrame,bindBrowserUsePrivateInput} from ${JSON.stringify(module)}; const password=readBrowserUseUnlockFrame(); console.log(JSON.stringify({passwordBytes:password.length}));password.fill(0);const bridge=bindBrowserUsePrivateInput(process.stdin,'host_synthetic',{set(){},async lock(){}},line=>{console.log(line);setImmediate(()=>{void bridge.close().then(()=>process.exit(0));});});`],{stdio:[fd,"pipe","ignore"]});
  let text="";assert.ok(child.stdout);child.stdout.on("data",data=>{text+=data.toString();});
  const exited=new Promise<number|null>(resolve=>child.once("exit",code=>resolve(code)));
  const timeout=setTimeout(()=>child.kill("SIGKILL"),5000);
  try{
    for(let i=0;i<100&&!text.includes("dexter.browser-use-key-ack/1");i++)await new Promise(resolve=>setTimeout(resolve,20));
    const lines=text.trim().split("\n").map(line=>JSON.parse(line));assert.equal(lines[0].passwordBytes,28);assert.equal(lines[1].status,"ready");
    assert.ok(!text.includes("synthetic-custody-passphrase")&&!text.includes(key));assert.equal(await exited,0);
  }finally{clearTimeout(timeout);if(child.exitCode===null)child.kill("SIGKILL");closeSync(fd);rmSync(dir,{recursive:true,force:true});}
});
test("shipped local host receives a key only on owned stdin and status never serializes the value",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"dexter-browser-pipe-host-"));
  const fd=ownFifo(dir);
  const child=spawn(process.execPath,[join(process.cwd(),"packages/cli/dist/index.js"),"serve","--data-dir",join(dir,"state"),"--port","0","--browser-use-private-input"],{stdio:[fd,"pipe","ignore"]});
  let text="";assert.ok(child.stdout);child.stdout.on("data",data=>{text+=data.toString();});
  const exited=new Promise<number|null>(resolve=>child.once("exit",code=>resolve(code)));
  const timer=setTimeout(()=>child.kill("SIGKILL"),8000);
  const line=async(predicate:(value:Record<string,unknown>)=>boolean)=>{
    for(let n=0;n<200;n++){
      const readyEnd=text.indexOf("\n}\n");
      const frames=[...text.split("\n").filter(Boolean),...(readyEnd>=0?[text.slice(0,readyEnd+3)]:[])];
      for(const raw of frames){try{const v=JSON.parse(raw) as Record<string,unknown>;if(predicate(v))return v;}catch{}}
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    throw new Error("Owned host public acknowledgement did not arrive.");
  };
  try{
    const ready=await line(value=>value.status==="ready"&&typeof value.url==="string");assert.equal(typeof ready.hostId,"string");
    writeSync(fd,JSON.stringify({schema:"dexter.browser-use-key/1",requestId,hostID:ready.hostId,operation:"set",key})+"\n");
    assert.equal((await line(value=>value.schema==="dexter.browser-use-key-ack/1")).status,"ready");
    const status=await fetch(String(ready.url)+"/v1/browser-use/status").then(value=>value.json()) as {hostID:string,credential:{unlocked:boolean},authentication:string,available:boolean};
    assert.equal(status.hostID,ready.hostId);assert.equal(status.credential.unlocked,true);assert.equal(status.authentication,"unverified");assert.equal(status.available,false);
    assert.ok(!JSON.stringify(status).includes(key)&&!text.includes(key));
    child.kill("SIGTERM");assert.equal(await exited,0);
  }finally{clearTimeout(timer);if(child.exitCode===null)child.kill("SIGKILL");closeSync(fd);rmSync(dir,{recursive:true,force:true});}
});
