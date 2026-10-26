// TEST ONLY dependency binding for the explicitly approved loopback browser entrypoint.
import {isAbsolute,resolve,join} from 'node:path';
import {realpathSync,lstatSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
export const APPROVED_BROWSER_SOURCE_PINS=Object.freeze({
 'packages/devices/src/daemon-config.ts':'b9a556487691d82678f222839f086b9c9040dbd0fd50e80e478dddccb211321a',
 'packages/devices/src/daemon-main.ts':'d57796add47e6921d24ddcbbc5f1a54fcb39781f47e4ed180841648b85360a2a'
});
export function readReviewedBrowserSource(source){
 try{
  if(typeof source!=='string'||!isAbsolute(source)||resolve(source)!==source||!source.startsWith('/private/tmp/')||realpathSync(source)!==source)throw Error();
  const info=lstatSync(source);if(!info.isDirectory()||(info.mode&0o077)!==0||info.uid!==process.getuid())throw Error();
  const files=[];
  for(const [relative,expected] of Object.entries(APPROVED_BROWSER_SOURCE_PINS)){
   const path=join(source,relative),stat=lstatSync(path);
   if(realpathSync(path)!==path||!stat.isFile()||(stat.mode&0o022)!==0||stat.uid!==process.getuid())throw Error();
   const bytes=readFileSync(path),actual=createHash('sha256').update(bytes).digest('hex');if(actual!==expected)throw Error();
   files.push({relative,bytes,sha256:actual});
  }
  return {verified:files.length===Object.keys(APPROVED_BROWSER_SOURCE_PINS).length,files};
 }catch{throw Error('Approved browser source binding refused');}
}
