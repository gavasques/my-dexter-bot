// Fixture-only request-count publication. A reader sees the previous or the next complete value, never an empty or partial file.
import fs from 'node:fs';import crypto from 'node:crypto';
export function publishCount(root,value,hold){
 const tmp=root+'/requests.txt.tmp-'+crypto.randomBytes(8).toString('hex');
 try{
  const fd=fs.openSync(tmp,'wx',0o600);
  try{fs.writeSync(fd,String(value));fs.fsyncSync(fd)}finally{fs.closeSync(fd)}
  if(hold)hold('before-rename');
  fs.renameSync(tmp,root+'/requests.txt');
 }catch(error){fs.rmSync(tmp,{force:true});throw error}
}
