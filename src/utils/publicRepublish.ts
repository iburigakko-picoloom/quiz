import type {PublicFolder,PublicSet} from './publicLibrary';

/** Only the user's explicit publication selection can undo catalog deletion. */
export async function restoreSelectedPublications(
  userId:string,
  library:{folders:PublicFolder[];sets:PublicSet[]},
  selection:{folderId?:string;sets:{id:string;cloudSetId?:string}[]},
  restore:(action:'restore'|'restore_set',id:string,metadata:{expected_deleted_at:string})=>Promise<unknown>,
) {
  const folder=library.folders.find(item=>item.ownerId===userId&&item.localFolderId===selection.folderId);
  if(selection.folderId&&folder?.deletedAt) await restore('restore',folder.id,{expected_deleted_at:folder.deletedAt});
  const localIds=new Set(selection.sets.map(set=>set.id));
  const cloudIds=new Set(selection.sets.map(set=>set.cloudSetId).filter(Boolean));
  for(const set of library.sets) {
    if(set.ownerId===userId&&set.deletedAt&&(localIds.has(set.localSetId)||cloudIds.has(set.id))) {
      await restore('restore_set',set.id,{expected_deleted_at:set.deletedAt});
    }
  }
}
