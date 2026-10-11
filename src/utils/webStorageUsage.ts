/** Approximate UTF-16 usage only. Never export keys, tokens or stored content. */
export function webStorageUsage(storage:Pick<Storage,'length'|'key'|'getItem'>):number|null {
  try{let bytes=0;for(let index=0;index<storage.length;index++){const key=storage.key(index);if(key!==null)bytes+=2*(key.length+(storage.getItem(key)?.length??0));}return bytes;}catch{return null;}
}
