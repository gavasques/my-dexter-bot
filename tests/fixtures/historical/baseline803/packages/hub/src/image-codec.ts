import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import { MAX_IMAGE_ATTACHMENT_BYTES } from "@dexter/contracts";
import { HostError } from "./errors.js";

const SIGNATURE = Buffer.from([137,80,78,71,13,10,26,10]);
const CRC = new Uint32Array(256);
for (let i=0;i<256;i++) { let n=i;for(let j=0;j<8;j++)n=(n&1)?0xedb88320^(n>>>1):n>>>1;CRC[i]=n>>>0; }
const crc32=(data:Uint8Array):number=>{let n=0xffffffff;for(const byte of data)n=CRC[(n^byte)&255]!^(n>>>8);return(n^0xffffffff)>>>0;};
const refuse=():never=>{throw new HostError("invalid_input","Image must be a supported, bounded PNG.");};
/** Structural, CRC and bounded decompression checks precede any durable image write. No renderer is invoked. */
export function validatePng(input:Uint8Array):{data:Buffer;sha256:string;bytes:number;width:number;height:number} {
  if (!(input instanceof Uint8Array) || input.byteLength<57 || input.byteLength>MAX_IMAGE_ATTACHMENT_BYTES) refuse();
  const data=Buffer.from(input);
  if(!data.subarray(0,8).equals(SIGNATURE))refuse();
  let offset=8,width=0,height=0,depth=0,color=0,interlace=0,header=false,end=false,seenData=false,dataEnded=false,palette=false;
  const compressed:Buffer[]=[];
  let chunks=0;
  while(offset<data.length){
    if(++chunks>4096 || offset+12>data.length)refuse();
    const size=data.readUInt32BE(offset),next=offset+12+size;
    if(size>MAX_IMAGE_ATTACHMENT_BYTES || next>data.length)refuse();
    const type=data.toString("ascii",offset+4,offset+8),body=data.subarray(offset+8,offset+8+size);
    if(!/^[A-Za-z]{4}$/.test(type) || /[a-z]/.test(type[2]!) || crc32(data.subarray(offset+4,offset+8+size))!==data.readUInt32BE(offset+8+size))refuse();
    if(!header && type!=="IHDR")refuse();
    if(type==="IHDR"){
      if(header || size!==13)refuse();header=true;width=body.readUInt32BE(0);height=body.readUInt32BE(4);depth=body[8]!;color=body[9]!;interlace=body[12]!;
      if(width<1 || height<1 || width>4096 || height>4096 || width*height>16_000_000 || body[10]!==0 || body[11]!==0 || interlace>1)refuse();
      const allowed:Record<number,readonly number[]>={0:[1,2,4,8,16],2:[8,16],3:[1,2,4,8],4:[8,16],6:[8,16]};
      if(!allowed[color]?.includes(depth))refuse();
    }else if(type==="PLTE"){
      if(palette || seenData || size===0 || size%3!==0 || size>768 || color===0 || color===4)refuse();palette=true;
      if(color===3 && size/3>2**depth)refuse();
    }else if(type==="IDAT"){
      if(dataEnded || end || (color===3&&!palette))refuse();seenData=true;compressed.push(body);
    }else if(type==="IEND"){
      if(size!==0 || !seenData || end || next!==data.length)refuse();end=true;
    }else{
      if(type==="acTL" || type==="fcTL" || type==="fdAT" || /^[A-Z]/.test(type))refuse();
      if(seenData)dataEnded=true;
    }
    offset=next;
  }
  if(!end)refuse();
  const channels=({0:1,2:3,3:1,4:2,6:4} as Record<number,number>)[color]!,bits=channels*depth;
  const passes=interlace===0?[[0,0,1,1]]:[[0,0,8,8],[4,0,8,8],[0,4,4,8],[2,0,4,4],[0,2,2,4],[1,0,2,2],[0,1,1,2]];
  const rows:{count:number;size:number}[]=[];let expected=0;
  for(const [x,y,dx,dy] of passes){const w=Math.max(0,Math.ceil((width-x!)/dx!)),h=Math.max(0,Math.ceil((height-y!)/dy!));if(w&&h){const size=Math.ceil(w*bits/8);rows.push({count:h,size});expected+=h*(size+1);}}
  // Even a small compressed file cannot allocate an unbounded decoded image.
  if(expected>64*1024*1024)refuse();
  let inflated:Buffer;
  try{inflated=inflateSync(Buffer.concat(compressed),{maxOutputLength:expected});}catch{return refuse();}
  if(inflated.length!==expected)refuse();
  let cursor=0;for(const row of rows)for(let y=0;y<row.count;y++){if(inflated[cursor]!>4)refuse();cursor+=row.size+1;}
  return{data,sha256:createHash("sha256").update(data).digest("hex"),bytes:data.length,width,height};
}
/** Buffer.from tolerates junk/padding; this route deliberately accepts only canonical base64. */
export function decodePngBase64(value:string):ReturnType<typeof validatePng> {
  if(typeof value!=="string" || value.length>4*Math.ceil(MAX_IMAGE_ATTACHMENT_BYTES/3) || value.length%4!==0 || /[^A-Za-z0-9+/=]/.test(value))refuse();
  const data=Buffer.from(value,"base64");if(data.toString("base64")!==value)refuse();return validatePng(data);
}
