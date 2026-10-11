import {useState} from 'react';
import type {AppData} from '../types';
import type {PublicFolder} from '../utils/publicLibrary';
import {PublicFolderPicker} from './PublicFolderPicker';
import {publicationPurposes} from './PublicationDetails';
import {LibraryPane} from './LibraryPane';

export type PublicPublishFormValue={kind:'folder'|'set';localId:string;category:string;description:string;tags:string;destination?:PublicFolder};

export function PublicPublishForm({data,value,busy,error,onChange,onSubmit}:{data:AppData;value:PublicPublishFormValue;busy:boolean;error:string;onChange:(value:PublicPublishFormValue)=>void;onSubmit:()=>void}) {
  const [step,setStep]=useState(1);
  const name=value.kind==='folder'?data.folders.find(folder=>folder.id===value.localId)?.name:data.problemSets.find(set=>set.id===value.localId)?.title;
  return <div className="public-publish-wizard">
    <div className="public-segments" role="tablist" aria-label="公開の手順">
      <button type="button" role="tab" aria-selected={step===1} disabled={busy} onClick={()=>setStep(1)}>1. {value.kind==='folder'?'フォルダ選択':'問題セット選択'}</button>
      <button type="button" role="tab" aria-selected={step===2} disabled={busy||!value.localId} onClick={()=>setStep(2)}>2. カテゴリー・説明</button>
    </div>
    <LibraryPane viewKey={String(step)} depth={step}>
    <div className="public-form">
      {step===1?<>
        {value.kind==='folder'?<PublicFolderPicker data={data} value={value.localId} disabled={busy} onChange={id=>onChange({...value,localId:id})}/>:<label>公開する問題セット<select disabled={busy} value={value.localId} onChange={event=>{const set=data.problemSets.find(item=>item.id===event.target.value);onChange({...value,localId:event.target.value,category:set?.subject||set?.audience||value.category,description:set?.description??''});}}><option value="">選択してください</option>{data.problemSets.map(set=><option key={set.id} value={set.id}>{set.title}</option>)}</select></label>}
        <button type="button" className="public-primary" disabled={busy||!value.localId} onClick={()=>setStep(2)}>次へ</button>
      </>:<>
        <strong className="public-publish-selection">{name}</strong>
        <label>カテゴリー・用途<select required disabled={busy} value={value.category} onChange={event=>onChange({...value,category:event.target.value})}><option value="">選んでください</option>{value.category&&!publicationPurposes.includes(value.category)?<option>{value.category}</option>:null}{publicationPurposes.map(category=><option key={category}>{category}</option>)}</select></label>
        {!value.destination?<label>説明（任意）<textarea disabled={busy} rows={3} maxLength={value.kind==='folder'?1000:300} placeholder="内容やおすすめの使い方など" value={value.description} onChange={event=>onChange({...value,description:event.target.value})}/></label>:null}
        {value.kind==='folder'?<details className="public-publish-tags"><summary>タグを追加（任意）</summary><label>タグ<input disabled={busy} placeholder="カンマ区切りで入力" value={value.tags} onChange={event=>onChange({...value,tags:event.target.value})}/></label></details>:null}
        {error?<p role="alert">{error}</p>:null}
        <div className="public-publish-footer"><button type="button" className="public-secondary" disabled={busy} onClick={()=>setStep(1)}>選び直す</button><button type="button" className="public-primary" disabled={busy||!value.localId||!value.category.trim()} onClick={onSubmit}>{busy?'保存中…':value.destination?'このフォルダに追加':'公開する'}</button></div>
      </>}
    </div>
    </LibraryPane>
  </div>;
}
