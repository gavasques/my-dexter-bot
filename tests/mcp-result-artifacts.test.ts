import assert from'node:assert/strict';import{test}from'node:test';import{mkdtempSync,rmSync,symlinkSync,unlinkSync}from'node:fs';import{tmpdir}from'node:os';import{join}from'node:path';
import{McpResultArtifacts}from'@dexter/context';
test('receipt spill keeps exact JSON under bot AND thread ACL, expires, and refuses a symlink',t=>{
  const dir=mkdtempSync(join(tmpdir(),'dx-mcp-artifact-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));let now=1000;
  const artifacts=new McpResultArtifacts(dir,()=>now),content={content:[{type:'image',data:'SYNTHETIC',mimeType:'image/png'},{type:'resource_link',uri:'https://example.test/no-fetch'}],structuredContent:{a:1}};
  const result=artifacts.save({botId:'bot_a',threadId:'thr_a',actionId:'act_a',requestHash:'a'.repeat(64),content}) as {artifactId:string};
  assert.deepEqual(artifacts.save({botId:'bot_a',threadId:'thr_a',actionId:'act_a',requestHash:'a'.repeat(64),content}),artifacts.save({botId:'bot_a',threadId:'thr_a',actionId:'act_a',requestHash:'a'.repeat(64),content}));
  assert.throws(()=>artifacts.read('bot_b','thr_a',result.artifactId));assert.throws(()=>artifacts.read('bot_a','thr_b',result.artifactId));
  assert.deepEqual(JSON.parse((artifacts.read('bot_a','thr_a',result.artifactId)as{content:string}).content),content);
  now+=3_600_000;assert.throws(()=>artifacts.read('bot_a','thr_a',result.artifactId));
  const path=join(dir,'mcp-result-artifacts',result.artifactId+'.json');unlinkSync(path);symlinkSync('/dev/null',path);assert.throws(()=>artifacts.read('bot_a','thr_a',result.artifactId));
});
