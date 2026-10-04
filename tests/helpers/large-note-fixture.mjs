import {deflateSync} from 'node:zlib';
const crcTable=Array.from({length:256},(_,i)=>{let c=i;for(let b=0;b<8;b++)c=c&1?0xedb88320^(c>>>1):c>>>1;return c>>>0});
function chunk(type,data){
  const header=Buffer.from(type),length=Buffer.alloc(4);length.writeUInt32BE(data.length);
  let crc=0xffffffff;for(const byte of Buffer.concat([header,data]))crc=crcTable[(crc^byte)&255]^(crc>>>8);
  const footer=Buffer.alloc(4);footer.writeUInt32BE((crc^0xffffffff)>>>0);
  return Buffer.concat([length,header,data,footer]);
}
// Valid deterministic RGBA PNG with enough entropy to exceed the record limit.
export function largePngDataUrl(){
  const width=1024,height=256,rows=Buffer.alloc((width*4+1)*height);let state=123456789;
  for(let y=0;y<height;y++)for(let x=0;x<width*4;x++){
    state^=state<<13;state^=state>>>17;state^=state<<5;
    rows[y*(width*4+1)+1+x]=state&255;
  }
  const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=6;
  const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(rows)),chunk('IEND',Buffer.alloc(0))]);
  return 'data:image/png;base64,'+png.toString('base64');
}
export function largeNoteRaw(stamp,problemSetId='s',category='category'){
  return JSON.stringify({problemSetId,category,currentPageIndex:0,updatedAt:stamp,pages:[{id:'page',dataUrl:largePngDataUrl(),updatedAt:stamp}]});
}
