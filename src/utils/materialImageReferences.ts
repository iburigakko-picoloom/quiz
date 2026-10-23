import { getAccountStorageSession } from './accountStorage';

export interface MaterialImageReference { id: string; page: string; number: number; x: number; y: number; image: Blob }
export function referencePoint(x: number, y: number, rect: { left: number; top: number; width: number; height: number }) {
  if (![x,y,rect.left,rect.top,rect.width,rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) throw new Error('配置位置を確認できません。');
  return { x: Math.max(0,Math.min(1,(x-rect.left)/rect.width)), y: Math.max(0,Math.min(1,(y-rect.top)/rect.height)) };
}
export function imageReferenceLabel(number: number) { return number <= 20 ? String.fromCodePoint(0x2460 + number - 1) : `(${number})`; }
export function validateReferenceImage(image: Blob) {
  if (!['image/png','image/jpeg','image/webp','image/gif'].includes(image.type) || !image.size || image.size > 10*1024*1024) throw new Error('10MB以下のPNG・JPEG・WebP・GIFを選んでください。');
}
// Deliberately separate from appData/categoryNotes/blobVault: never enters cloud exports.
export function localImageReferenceStore() {
  const owner = getAccountStorageSession();
  const assertOwner = () => { if (getAccountStorageSession() !== owner) throw new Error('アカウントが変わりました。資料を開き直してください。'); owner?.assertCurrent(); };
  const open = () => new Promise<IDBDatabase>((resolve,reject) => {
    assertOwner();
    const request = indexedDB.open(`quizmake-device-image-references-v1:${owner?.namespace ?? 'legacy'}`,1);
    request.onupgradeneeded = () => request.result.createObjectStore('references',{keyPath:'id'}).createIndex('page','page');
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('画像保存先を開けません。ほかの画面を閉じてください。'));
    request.onsuccess = () => resolve(request.result);
  });
  return {
    async load(page: string): Promise<MaterialImageReference[]> {
      const db=await open();
      try { assertOwner(); return await new Promise((resolve,reject)=>{
        const tx=db.transaction('references'), request=tx.objectStore('references').index('page').getAll(page);
        tx.oncomplete=()=>{ try { assertOwner(); resolve((request.result as MaterialImageReference[]).sort((a,b)=>a.number-b.number)); } catch(e) { reject(e); } };
        tx.onabort=()=>reject(tx.error);
      }); } finally { db.close(); }
    },
    async add(page: string, image: Blob, x: number, y: number): Promise<MaterialImageReference> {
      validateReferenceImage(image);
      if (!page || !Number.isFinite(x) || !Number.isFinite(y) || x<0 || x>1 || y<0 || y>1) throw new Error('配置位置が不正です。');
      const db=await open();
      try { assertOwner(); return await new Promise((resolve,reject)=>{
        const tx=db.transaction('references','readwrite'), store=tx.objectStore('references');
        const request=store.index('page').getAll(page); let value: MaterialImageReference;
        request.onsuccess=()=>{ value={id:crypto.randomUUID(),page,image,x,y,number:1+Math.max(0,...request.result.map((r: MaterialImageReference)=>r.number))}; store.add(value); };
        tx.oncomplete=()=>resolve(value); tx.onabort=()=>reject(tx.error ?? new Error('画像を保存できませんでした。'));
      }); } finally { db.close(); }
    },
  };
}
