import { isChunkInternal } from './recordChunkFormat';
import type { RecordCollection } from './appRecordStorage';
import { hashJsonFragments, jsonFragments } from './incrementalJsonDigest';
export const wholeHash=async(text:string)=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(n=>n.toString(16).padStart(2,'0')).join('');
function stable(value:unknown):unknown{
  if(Array.isArray(value))return value.map(stable);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,row])=>[key,stable(row)]));
  return value;
}
/** Hash logical live content rather than chunk framing, transport receipts or
 * counters. PDF/image descriptors already identify verified separate bodies.
 * This avoids re-encoding media and sending the full dataset on each answer. */
export async function computeWholeRecordDigest(rows:readonly {key:string;collection:RecordCollection;id:string;raw:string|null;logicalRaw?:string;position:number}[]):Promise<string>{
  const ordered=rows.filter(row=>row.raw!==null&&!isChunkInternal(row.collection,row.id)).sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0);
  function* content():Generator<string>{
    yield '[';
    for(let index=0;index<ordered.length;index++){
    if(index)yield ',';
    const row=ordered[index];
    const raw=row.logicalRaw??row.raw!;let value:unknown=raw;
    try{value=JSON.parse(raw)}catch{/* Existing ordinary setting strings remain exact. */}
    if(row.collection==='questionImages'&&value&&typeof value==='object'){const {path:_path,...descriptor}=value as Record<string,unknown>;value=descriptor;}
    yield* jsonFragments({collection:row.collection,id:row.id,position:row.position,value:stable(value)});
    }
    yield ']';
  }
  return hashJsonFragments(content());
}
