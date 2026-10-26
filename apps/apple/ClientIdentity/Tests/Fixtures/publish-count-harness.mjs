// Deterministic held-publication check: the reader runs at the exact instant the publisher is held mid-publication.
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
const {publishCount}=await import(new URL('./publish-count.mjs',import.meta.url));
const root=fs.mkdtempSync(path.join(os.tmpdir(),'dexter-publish-count-')),file=root+'/requests.txt';
try{
 publishCount(root,0);let held=0;const total=20;
 for(let n=1;n<=total;n++){
  publishCount(root,n,()=>{
   held++;const text=fs.readFileSync(file,'utf8');
   if(text!==String(n-1))throw new Error(`reader saw ${JSON.stringify(text)} while publishing ${n}; expected ${n-1}`);
  });
  const text=fs.readFileSync(file,'utf8');if(text!==String(n))throw new Error(`published ${JSON.stringify(text)}, expected ${n}`);
 }
 if(held!==total)throw new Error(`hold seam ran ${held} times, expected ${total}`);
 const left=fs.readdirSync(root);if(left.length!==1||left[0]!=='requests.txt')throw new Error('leftover files: '+left.join(','));
 const mode=fs.statSync(file).mode&0o777;if(mode!==0o600)throw new Error('mode '+mode.toString(8));
 process.stdout.write('OK held='+held+'\n');
}finally{fs.rmSync(root,{recursive:true,force:true})}
