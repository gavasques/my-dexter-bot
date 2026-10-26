import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { X509Certificate, randomUUID } from "node:crypto";
import { test } from "node:test";
import { HostStore } from "@dexter/hub";
import { isTailscaleIPv4, openDesktopAppClientCustody } from "../packages/cli/src/desktop-app-client-custody.js";

test("desktop channel admits only exact canonical private-network IPv4 addresses",()=>{
  for(const value of ["100.64.0.1","100.127.255.254","100.64.0.102"])assert.equal(isTailscaleIPv4(value),true);
  for(const value of ["100.63.255.255","100.128.0.1","0.0.0.0","::","127.0.0.1","192.168.1.1","100.064.0.1","100.64.0.256","100.64.0.1.evil",null])assert.equal(isTailscaleIPv4(value),false);
});

test("explicit desktop creation seals a separate pinned leaf; unlock preserves it and never changes host identity",async t=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),"dx-desktop-channel-")));chmodSync(root,0o700);
  const store=new HostStore({dataDir:join(root,"host")}),file=join(root,"app.sealed"),address="100.64.0.99";
  t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
  const target={installationId:store.hostId,ownerId:store.ownerId};
  const original={host:store.hostId,owner:store.ownerId},password=Buffer.alloc(32,47);
  const createSecret=Buffer.from(password),created=await openDesktopAppClientCustody(store,file,"create",target,()=>createSecret,address);
  assert(createSecret.every(byte=>byte===0));
  const cert=new X509Certificate(created.appClients.identity.certPem),fingerprint=created.appClients.identity.fingerprint;
  assert.equal(cert.ca,false);assert.equal(cert.checkIP(address),address);assert.equal(cert.checkIP("127.0.0.1"),undefined);
  assert.equal(created.appClients.listenHost,address);assert.equal(created.appClients.port,0);
  assert.equal(created.appClients.offerTtlMs,300_000);
  const encrypted=readFileSync(file);assert.equal(encrypted.includes(Buffer.from("PRIVATE KEY")),false);
  assert.equal(encrypted.includes(Buffer.from(created.appClients.identity.keyPem)),false);
  await created.custody.close();
  const unlockSecret=Buffer.from(password),restored=await openDesktopAppClientCustody(store,file,"unlock",target,()=>unlockSecret,address,4319);
  assert(unlockSecret.every(byte=>byte===0));assert.equal(restored.appClients.identity.fingerprint,fingerprint);
  assert.equal(restored.appClients.port,4319);assert.deepEqual({host:store.hostId,owner:store.ownerId},original);
  assert.deepEqual(readFileSync(file),encrypted);await restored.custody.close();
  // A second create and a different advertised address refuse without replacing ciphertext/trust.
  await assert.rejects(openDesktopAppClientCustody(store,file,"create",target,()=>Buffer.from(password),address));
  await assert.rejects(openDesktopAppClientCustody(store,file,"unlock",target,()=>Buffer.from(password),"100.64.0.100"));
  assert.deepEqual(readFileSync(file),encrypted);
  const other=new HostStore({dataDir:join(root,"other")});
  try {await assert.rejects(openDesktopAppClientCustody(other,file,"unlock",target,()=>Buffer.from(password),address));}
  finally {other.close();password.fill(0);}
});

test("desktop setup refuses unsafe metadata before reading any private input or writing custody",async t=>{
  const root=mkdtempSync(join(tmpdir(),"dx-desktop-refuse-"));chmodSync(root,0o700);
  const store=new HostStore({dataDir:join(root,"host")}),file=join(root,"not-created.sealed");let reads=0;
  const target={installationId:store.hostId,ownerId:store.ownerId};
  t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
  for(const [path,address,port] of [["relative","100.64.0.99",4319],[file,"0.0.0.0",4319],[file,"100.64.0.1",65536]] as const)
    await assert.rejects(openDesktopAppClientCustody(store,path,"create",target,()=>{reads++;return Buffer.alloc(32,7);},address,port));
  for(const expected of [{...target,installationId:"other-host"},{...target,ownerId:"other-owner"}])
    await assert.rejects(openDesktopAppClientCustody(store,file,"create",expected,()=>{reads++;return Buffer.alloc(32,7);},"100.64.0.99"));
  assert.equal(reads,0);assert.equal(existsSync(file),false);
});

test("explicit renewal replaces expired private-IP trust with a new sealed identity without changing the old custody",async t=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),"dx-desktop-renew-")));chmodSync(root,0o700);
  const store=new HostStore({dataDir:join(root,"host")});
  const target={installationId:store.hostId,ownerId:store.ownerId},originalHost={...target};
  const oldFile=join(root,`channel-${randomUUID()}.sealed`),newFile=join(root,`channel-${randomUUID()}.sealed`);
  const oldAddress="100.64.0.99",newAddress="100.64.0.100",oldPassword=Buffer.alloc(32,63),newPassword=Buffer.alloc(32,91);
  t.after(()=>{oldPassword.fill(0);newPassword.fill(0);store.close();rmSync(root,{recursive:true,force:true});});
  const now=Date.now(),clock=t.mock.method(Date,"now",()=>now-366*86400_000);
  let oldPin: string;
  try {
    const old=await openDesktopAppClientCustody(store,oldFile,"create",target,()=>Buffer.from(oldPassword),oldAddress);
    oldPin=old.appClients.identity.fingerprint;await old.custody.close();
  } finally {clock.mock.restore();}
  const original=readFileSync(oldFile);
  await assert.rejects(openDesktopAppClientCustody(store,oldFile,"unlock",target,()=>Buffer.from(oldPassword),oldAddress),"expired certificate cannot be restored");
  assert.deepEqual(readFileSync(oldFile),original);
  const renewed=await openDesktopAppClientCustody(store,newFile,"create",target,()=>Buffer.from(newPassword),newAddress,4319);
  const cert=new X509Certificate(renewed.appClients.identity.certPem),newPin=renewed.appClients.identity.fingerprint;
  assert.notEqual(newPin,oldPin!);assert.equal(cert.checkIP(newAddress),newAddress);assert.equal(cert.checkIP(oldAddress),undefined);
  assert.equal(renewed.appClients.listenHost,newAddress);assert.equal(renewed.appClients.port,4319);
  await renewed.custody.close();
  assert.deepEqual(readFileSync(oldFile),original,"renewal never edits/deletes old ciphertext");
  assert.notDeepEqual(readFileSync(newFile),original);
  const restored=await openDesktopAppClientCustody(store,newFile,"unlock",target,()=>Buffer.from(newPassword),newAddress,4319);
  assert.equal(restored.appClients.identity.fingerprint,newPin);await restored.custody.close();
  await assert.rejects(openDesktopAppClientCustody(store,newFile,"unlock",target,()=>Buffer.from(oldPassword),newAddress));
  await assert.rejects(openDesktopAppClientCustody(store,oldFile,"create",target,()=>Buffer.from(newPassword),newAddress));
  assert.deepEqual(readFileSync(oldFile),original);assert.deepEqual({installationId:store.hostId,ownerId:store.ownerId},originalHost);
});
