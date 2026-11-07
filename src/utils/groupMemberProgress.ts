import type { LevelCounts } from './groupLearning';
export interface MemberMaterialProgress {setId:string;versionId:string|null;state:'shared'|'not_shared'|'update_pending'|'reflection_pending';answered:number|null;total:number|null;levels:LevelCounts|null;reflectedAt:string|null}
export function parseMemberMaterialProgress(value:unknown):MemberMaterialProgress[] {
  if(!Array.isArray(value))throw new Error('教材別の進捗を確認できません。');
  const seen=new Set<string>();
  return value.map((item:unknown)=>{
    if(!item || typeof item!=='object')throw new Error('教材別の進捗が不正です。');
    const row=item as Record<string,unknown>;
    if(typeof row.set_id!=='string'||!row.set_id||seen.has(row.set_id)||!(row.version_id===null||typeof row.version_id==='string')||!['shared','not_shared','update_pending','reflection_pending'].includes(String(row.state)))throw new Error('教材別の進捗が不正です。');
    seen.add(row.set_id);
    let levels:LevelCounts|null=null;
    if(row.levels!==null){if(!Array.isArray(row.levels)||row.levels.length!==4||row.levels.some(n=>!Number.isSafeInteger(n)||n<0))throw new Error('レベル別の集計が不正です。');levels=row.levels as LevelCounts;}
    if(row.state==='shared'){
      if(typeof row.version_id!=='string'||!row.version_id||!Number.isSafeInteger(row.answered)||!Number.isSafeInteger(row.total)||Number(row.answered)<0||Number(row.total)<=0||Number(row.answered)>Number(row.total)||!levels||levels.reduce((a,b)=>a+b,0)!==row.total||typeof row.reflected_at!=='string'||!Number.isFinite(Date.parse(row.reflected_at)))throw new Error('教材別の進捗が不正です。');
    }else if(row.answered!==null||row.total!==null||levels!==null||row.reflected_at!==null)throw new Error('共有されていない進捗が含まれています。');
    return {setId:row.set_id,versionId:row.version_id as string|null,state:row.state as MemberMaterialProgress['state'],answered:row.answered as number|null,total:row.total as number|null,levels,reflectedAt:row.reflected_at as string|null};
  });
}
