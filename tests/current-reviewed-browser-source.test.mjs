import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,symlinkSync,rmSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import {readReviewedBrowserSource,APPROVED_BROWSER_SOURCE_PINS} from './fixtures/current-reviewed-browser-source.mjs';
const approved=process.env.DEXTER_REVIEWED_BROWSER_TEST_SOURCE;
function fixture(){
 assert.ok(approved,'explicit exact approved public source input required');
 const root=mkdtempSync('/private/tmp/dexter-public-browser-pins-'),source=join(root,'source');mkdirSync(source,{mode:0o700});
 for(const name of Object.keys(APPROVED_BROWSER_SOURCE_PINS)){const p=join(source,name);mkdirSync(join(source,'packages/devices/src'),{recursive:true});writeFileSync(p,readFileSync(join(approved,name)),{mode:0o600});}
 return {root,source,close(){rmSync(root,{recursive:true});}};
}
test('exact approved source is verified from read bytes before copy',()=>{const f=fixture();try{const result=readReviewedBrowserSource(f.source);assert.equal(result.verified,true);assert.deepEqual(Object.fromEntries(result.files.map(x=>[x.relative,x.sha256])),APPROVED_BROWSER_SOURCE_PINS);}finally{f.close();}});
for(const name of Object.keys(APPROVED_BROWSER_SOURCE_PINS))test('changed source is refused: '+name,()=>{const f=fixture();try{writeFileSync(join(f.source,name),'// public tampered fixture');assert.throws(()=>readReviewedBrowserSource(f.source),/^Error: Approved browser source binding refused$/);}finally{f.close();}});
test('traversal input is refused without accepting a lexical private prefix',()=>{assert.throws(()=>readReviewedBrowserSource('/private/tmp/../../Users/anyone/tree'),/binding refused/);});
test('symlinked source is refused',()=>{const f=fixture();try{const alias=join(f.root,'alias');symlinkSync(f.source,alias);assert.throws(()=>readReviewedBrowserSource(alias),/binding refused/);}finally{f.close();}});
test('symlinked file is refused even when it points to exact approved bytes',()=>{const f=fixture();try{const name=Object.keys(APPROVED_BROWSER_SOURCE_PINS)[0];rmSync(join(f.source,name));symlinkSync(join(approved,name),join(f.source,name));assert.throws(()=>readReviewedBrowserSource(f.source),/binding refused/);}finally{f.close();}});
test('nonprivate source directory is refused',()=>{const f=fixture();try{chmodSync(f.source,0o755);assert.throws(()=>readReviewedBrowserSource(f.source),/binding refused/);}finally{f.close();}});
