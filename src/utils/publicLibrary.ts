import type {CloudProblemSet} from './cloudService';
import type {SharedFolderPart} from './sharedFolders';
export interface PublicSet extends CloudProblemSet {standalonePublic:boolean;tags:string[];memberPath?:SharedFolderPart[]}
export interface PublicFolder {id:string;ownerId:string;localFolderId?:string;name:string;description:string;category:string;tags:string[];authorName:string;published:boolean;setCount:number;questionCount:number;importCount:number;updatedAt:string;members?:PublicSet[]}
export interface PublicFilters {kind:'all'|'folder'|'set';category:string;minimum:number;maximum:number|null;sort:'popular'|'new'|'updated'}
export const initialPublicFilters:PublicFilters={kind:'all',category:'',minimum:0,maximum:null,sort:'popular'};
export function publicFilterArgs(query:string,filters:PublicFilters,offset=0){return {p_query:query.trim(),p_kind:filters.kind,p_category:filters.category,p_min:filters.minimum,p_max:filters.maximum,p_sort:filters.sort,p_offset:offset,p_limit:30};}
export function uniquePublicSets(sets:PublicSet[]){return [...new Map(sets.map(set=>[set.id,set])).values()];}
