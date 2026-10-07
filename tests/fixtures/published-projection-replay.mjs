// Frozen pre-IDB replay from published e57523d (localStorageRecords.ts).
// Kept here to test real backward rejection rather than the new implementation.
export async function publishedReplay(db, native) {
  const read=db.transaction('localProjections');
  const readDone=new Promise((r,j)=>{read.oncomplete=r;read.onabort=()=>j(read.error)});
  const keys=read.objectStore('localProjections').getAllKeys();
  const values=read.objectStore('localProjections').getAll();
  await readDone;
  for(let i=0;i<keys.result.length;i++) {
    const key=keys.result[i],raw=values.result[i];
    if(typeof key!=='string'||!(raw===null||typeof raw==='string')) throw Error('保存済みメモの形式を確認できませんでした。');
    if(raw===null)native.removeItem(key);else native.setItem(key,raw);
    if(native.getItem(key)!==raw)throw Error('メモの保存を確認できませんでした。再読み込みしてください。');
  }
}
