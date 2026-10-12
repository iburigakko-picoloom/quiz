-- Preserve the legacy read contract and ownership gate. Assemble already-valid
-- record JSON as text once, instead of reparsing and copying the growing app
-- JSONB for each collection. No records, history or access policies change.
set local lock_timeout = '2s';
create or replace function private.quiz_sync_materialize_snapshot(p_sync_id text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb; app text; settings jsonb; notes jsonb;
begin
  select data into result from public.quiz_sync_data where sync_id=p_sync_id;
  if not exists(select 1 from private.quiz_sync_heads where sync_id=p_sync_id) then return result; end if;
  select '{"version":1,' || string_agg(to_json(domain)::text || ':[' || entries || ']', ',' order by domain) || '}' into app
  from (
    select d.domain,coalesce(string_agg(r.raw,',' order by r.position,r.record_id),'') entries
    from unnest(array['folders','problemSets','questions','progress','answerLogs']) d(domain)
    left join private.quiz_sync_records r on r.sync_id=p_sync_id and r.collection=d.domain and r.raw is not null
    group by d.domain
  ) domains;
  select coalesce(jsonb_object_agg(r.record_id,r.raw),'{}') into settings
    from private.quiz_sync_records r where r.sync_id=p_sync_id and r.collection='localStorage' and r.raw is not null;
  select coalesce(jsonb_object_agg(r.record_id,r.raw),'{}') into notes
    from private.quiz_sync_records r where r.sync_id=p_sync_id and r.collection='indexedDbNotes' and r.raw is not null;
  settings := settings || jsonb_build_object('quiz-make-app-data-v1',app) ||
    (select coalesce(jsonb_object_agg('quizMake:image:'||r.record_id,r.raw),'{}')
      from private.quiz_sync_records r where r.sync_id=p_sync_id and r.collection='questionImages' and r.raw is not null);
  return (result - 'localStorage' - 'indexedDbNotes') || jsonb_build_object('localStorage',settings,'indexedDbNotes',notes);
end $$;
revoke all on function private.quiz_sync_materialize_snapshot(text) from public,anon,authenticated;
