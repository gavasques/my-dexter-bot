import assert from "node:assert/strict";
import { createPrivateKey, generateKeyPairSync, X509Certificate } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer, request } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import test from "node:test";
import { createLabTlsIdentity, LabTlsMaterial, generateSyntheticIdentity, DeviceError, loadIdentity } from "@dexter/devices";
import { memoryTLS } from "./fixtures/online-memory-tls.js";

test("memory profiles have actual P256 named-curve signatures, SAN, EKU, validity and redaction", () => {
  for (const profile of ["device", "host", "client", "ca"] as const) {
    const material = createLabTlsIdentity({profile, name:`synthetic-${profile}`}), id = material.identity, cert = new X509Certificate(id.certPem);
    assert.equal(cert.publicKey.asymmetricKeyDetails?.namedCurve, "prime256v1");
    assert.equal(cert.verify(cert.publicKey), true); assert.equal(cert.checkPrivateKey(createPrivateKey(id.keyPem)), true);
    assert.equal(cert.ca, profile === "ca"); assert.ok(Date.parse(cert.validFrom) < Date.now()); assert.ok(Date.parse(cert.validTo) > Date.now());
    if (profile === "host") { assert.equal(cert.checkIP("127.0.0.1"), "127.0.0.1"); assert.equal(cert.checkHost("localhost"), "localhost"); assert.deepEqual(cert.keyUsage, ["1.3.6.1.5.5.7.3.1"]); }
    if (profile === "client") assert.deepEqual(cert.keyUsage, ["1.3.6.1.5.5.7.3.2"]);
    assert.ok(!JSON.stringify(material).includes("PRIVATE")); assert.ok(!inspect(material,{showHidden:true}).includes("PRIVATE"));
    assert.ok(!JSON.stringify(id).includes("PRIVATE")); assert.ok(!inspect(id,{showHidden:true}).includes("PRIVATE"));
  }
});
test("RFC5280 boundary uses UTCTime through2049, GeneralizedTime2050+, supported years2000..9999",()=>{
  // Independent TLV walk of the serialized certificate, not the factory's DER helpers.
  const items=(bytes:Buffer)=>{const out:{tag:number;value:Buffer}[]=[];let pos=0;while(pos<bytes.length){const tag=bytes[pos++]!,first=bytes[pos++]!;let n=first;if(first&128){n=0;for(let i=0;i<(first&127);i++)n=n*256+bytes[pos++]!;}out.push({tag,value:bytes.subarray(pos,pos+n)});pos+=n;}assert.equal(pos,bytes.length);return out;};
  const cert=new X509Certificate(createLabTlsIdentity({profile:"host",name:"boundary",notBefore:new Date("2049-12-31T23:59:59Z"),notAfter:new Date("2050-01-01T00:00:00Z")}).identity.certPem);
  const fields=items(items(cert.raw)[0]!.value),tbs=items(fields[0]!.value),validity=items(tbs[4]!.value);
  assert.deepEqual(validity.map(v=>[v.tag,v.value.toString()]),[[0x17,"491231235959Z"],[0x18,"20500101000000Z"]]);assert.equal(cert.verify(cert.publicKey),true);
  for(const dates of [["1999-12-31T23:59:59Z","2000-01-01T00:00:00Z"],["9999-12-31T23:59:59Z","+010000-01-01T00:00:00Z"],["2049-01-01T00:00:00.100Z","2049-01-01T00:00:00.900Z"]])assert.throws(()=>createLabTlsIdentity({profile:"host",name:"outside",notBefore:new Date(dates[0]!),notAfter:new Date(dates[1]!)}),DeviceError);
});
test("issuer brand refuses public construction, prototype forgery and proxy; actual signer binding remains",()=>{
  const ca=createLabTlsIdentity({profile:"ca",name:"real-root"}),other=createLabTlsIdentity({profile:"ca",name:"other-root"}),keys=generateKeyPairSync("ec",{namedCurve:"prime256v1"});
  assert.throws(()=>Reflect.construct(LabTlsMaterial,[Symbol("lab issuance"),keys.privateKey,Buffer.from("forged"),true,new X509Certificate(ca.identity.certPem).raw]),DeviceError);
  for(const issuer of [Object.create(LabTlsMaterial.prototype),new Proxy(ca,{})])assert.throws(()=>createLabTlsIdentity({profile:"client",name:"forged",issuer}),DeviceError);
  const leaf=new X509Certificate(createLabTlsIdentity({profile:"client",name:"actual",issuer:ca}).identity.certPem);
  assert.equal(leaf.verify(new X509Certificate(ca.identity.certPem).publicKey),true);assert.equal(leaf.verify(new X509Certificate(other.identity.certPem).publicKey),false);assert.equal(leaf.checkIssued(new X509Certificate(other.identity.certPem)),false);
});
test("online adapter shares the factory and preserves dual EKU and loopback profile",()=>{
  const identity=memoryTLS(),cert=new X509Certificate(identity.certPem);
  assert.deepEqual(cert.keyUsage,["1.3.6.1.5.5.7.3.1","1.3.6.1.5.5.7.3.2"]);assert.equal(cert.checkIP("127.0.0.1"),"127.0.0.1");assert.equal(cert.checkHost("localhost"),"localhost");assert.equal(cert.checkPrivateKey(createPrivateKey(identity.keyPem)),true);
});
test("explicit containing CA interval issues good and expired client leaves; real mTLS admits only good",async t=>{
  const now=Date.now(),ca=createLabTlsIdentity({profile:"ca",name:"wide-root",notBefore:new Date(now-7*86400000),notAfter:new Date(now+7*86400000)}),
    host=createLabTlsIdentity({profile:"host",name:"current-host",issuer:ca}).identity,
    good=createLabTlsIdentity({profile:"client",name:"current-client",issuer:ca}).identity,
    expired=createLabTlsIdentity({profile:"client",name:"expired-client",issuer:ca,notBefore:new Date(now-2*86400000),notAfter:new Date(now-86400000)}).identity;
  assert.equal(new X509Certificate(expired.certPem).verify(new X509Certificate(ca.identity.certPem).publicKey),true);
  assert.throws(()=>createLabTlsIdentity({profile:"client",name:"outside-issuer",issuer:ca,notBefore:new Date(now-8*86400000),notAfter:new Date(now-86400000)}),DeviceError);
  let admitted=0;const server=createServer({key:host.keyPem,cert:host.certPem,ca:ca.identity.certPem,requestCert:true,rejectUnauthorized:true,minVersion:"TLSv1.3",maxVersion:"TLSv1.3"},(_q,r)=>{admitted++;r.end("synthetic");});
  await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));t.after(()=>new Promise<void>(r=>{server.close(()=>r());server.closeAllConnections();}));
  const call=(identity:typeof good)=>new Promise<void>((resolve,reject)=>{const q=request({host:"127.0.0.1",port:(server.address() as AddressInfo).port,ca:ca.identity.certPem,key:identity.keyPem,cert:identity.certPem,agent:false,minVersion:"TLSv1.3",maxVersion:"TLSv1.3"},r=>{r.resume();r.on("end",resolve);});q.on("error",reject);q.end();});
  await call(good);await assert.rejects(call(expired));assert.equal(admitted,1);
});
test("public certificate directory never becomes a production private-key identity", t => {
  const dir = mkdtempSync(join(tmpdir(),"dx-pki-"));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,"identity"), id=generateSyntheticIdentity(path,"public");
  assert.deepEqual(readdirSync(path),["cert.pem"]); assert.equal(existsSync(join(path,"key.pem")),false);
  assert.equal(new X509Certificate(id.certPem).verify(new X509Certificate(id.certPem).publicKey),true);
  assert.throws(()=>loadIdentity(path),e=>e instanceof DeviceError&&e.code==="forbidden");
});
test("invalid contexts are refused and expired/wrong-SAN negative profiles remain real certificates", () => {
  const issuer=createLabTlsIdentity({profile:"client",name:"not-ca"});
  for(const value of [{profile:"other",name:"x"},{profile:"host",name:"bad\nname"},{profile:"host",name:"x",san:["IP:::1"]},
    {profile:"ca",name:"x",san:["DNS:localhost"]},{profile:"client",name:"x",issuer},
    {profile:"host",name:"x",notBefore:new Date(10),notAfter:new Date(1)}, {profile:"host",name:"x",unknown:true}]) {
    assert.throws(()=>createLabTlsIdentity(value as never),e=>e instanceof DeviceError&&e.code==="invalid_input");
  }
  let accessed=false; assert.throws(()=>createLabTlsIdentity({get profile(){accessed=true;return "host" as const;},name:"x"}));assert.equal(accessed,false);
  const expired=new X509Certificate(createLabTlsIdentity({profile:"host",name:"expired",notBefore:new Date(Date.now()-120000),notAfter:new Date(Date.now()-60000)}).identity.certPem);
  assert.ok(Date.parse(expired.validTo)<Date.now());
  const wrong=new X509Certificate(createLabTlsIdentity({profile:"host",name:"wrong",san:["DNS:wrong.example"]}).identity.certPem);assert.equal(wrong.checkIP("127.0.0.1"),undefined);
});
test("CA leaf signatures and actual TLS1.3 mutual authentication use only memory", async t => {
  const ca=createLabTlsIdentity({profile:"ca",name:"lab-root"}), host=createLabTlsIdentity({profile:"host",name:"lab-host",issuer:ca}).identity,
    client=createLabTlsIdentity({profile:"client",name:"lab-client",issuer:ca}).identity;
  assert.equal(new X509Certificate(host.certPem).verify(new X509Certificate(ca.identity.certPem).publicKey),true);
  assert.equal(new X509Certificate(client.certPem).checkIssued(new X509Certificate(ca.identity.certPem)),true);
  let accepted=0;
  const server=createServer({key:host.keyPem,cert:host.certPem,ca:ca.identity.certPem,requestCert:true,rejectUnauthorized:true,minVersion:"TLSv1.3",maxVersion:"TLSv1.3"},(q,r)=>{assert.equal((q.socket as import("node:tls").TLSSocket).authorized,true);accepted++;r.end("synthetic");});
  await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));t.after(()=>new Promise<void>(r=>{server.close(()=>r());server.closeAllConnections();}));
  const call=(identity:typeof client|null)=>new Promise<string>((resolve,reject)=>{
    const q=request({host:"127.0.0.1",port:(server.address() as AddressInfo).port,ca:ca.identity.certPem,...(identity?{key:identity.keyPem,cert:identity.certPem}:{}),agent:false,minVersion:"TLSv1.3",maxVersion:"TLSv1.3"},r=>{r.resume();r.on("end",()=>resolve("ok"));});q.on("error",reject);q.end();
  });
  assert.equal(await call(client),"ok");await assert.rejects(call(null));
  const outsider=createLabTlsIdentity({profile:"client",name:"untrusted"}).identity;await assert.rejects(call(outsider));assert.equal(accepted,1);
});

test("issuer containment compares encoded seconds and refuses every encoded interval outside CA", () => {
  const ca=createLabTlsIdentity({profile:"ca",name:"seconds-root",notBefore:new Date("2049-12-31T23:59:58.000Z"),notAfter:new Date("2050-01-01T00:00:02.000Z")});
  const issuer=new X509Certificate(ca.identity.certPem);
  const leaf=new X509Certificate(createLabTlsIdentity({profile:"client",name:"seconds-leaf",issuer:ca,notBefore:new Date("2049-12-31T23:59:58.999Z"),notAfter:new Date("2050-01-01T00:00:02.999Z")}).identity.certPem);
  assert.equal(leaf.validFrom,issuer.validFrom);assert.equal(leaf.validTo,issuer.validTo);assert.equal(leaf.verify(issuer.publicKey),true);
  for (const [before,after] of [["2049-12-31T23:59:57.999Z","2050-01-01T00:00:01.999Z"],["2049-12-31T23:59:59.999Z","2050-01-01T00:00:03.000Z"]]) {
    assert.throws(()=>createLabTlsIdentity({profile:"client",name:"outside-second",issuer:ca,notBefore:new Date(before!),notAfter:new Date(after!)}),DeviceError);
  }
  assert.throws(()=>createLabTlsIdentity({profile:"client",name:"collapsed-second",issuer:ca,notBefore:new Date("2050-01-01T00:00:01.100Z"),notAfter:new Date("2050-01-01T00:00:01.999Z")}),DeviceError);
});
