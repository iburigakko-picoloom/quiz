-- Resume existing immutable uploads and remove quadratic progress lookup.
-- Patch the known function definition, preserving owner, ACL, locks and atomic commit.
-- Fail closed on schema drift. No canonical rows, snapshots or staging bodies are rewritten.
set local lock_timeout = '2s';
do $migration$
declare definition text:=replace(pg_get_functiondef('private.quiz_delta_sync(text,text,jsonb)'::regprocedure),chr(13)||chr(10),chr(10));
begin
  if strpos(definition,$before$touched text[]:='{}'; parent_deleted$before$)=0 then raise exception 'delta_resume_schema_mismatch_0'; end if;
  definition:=replace(definition,$before$touched text[]:='{}'; parent_deleted$before$,$after$touched text[]:='{}'; event_questions jsonb; parent_deleted$after$);
  if strpos(definition,$before$'revision',receipt.revision);
  end if;
  if p_action='history'$before$)=0 then raise exception 'delta_resume_schema_mismatch_1'; end if;
  definition:=replace(definition,$before$'revision',receipt.revision);
  end if;
  if p_action='history'$before$,$after$'revision',receipt.revision,'digest',receipt.digest,'parts',receipt.parts,'deviceId',receipt.device_id,'sequence',receipt.device_sequence,
      'received',(select coalesce(jsonb_agg(p.part order by p.part),'[]'::jsonb) from private.quiz_delta_parts p where p.sync_id=p_sync_id and p.operation_id=receipt.operation_id));
  end if;
  if p_action='history'$after$);
  if strpos(definition,$before$  rev:=h.revision+1;$before$)=0 then raise exception 'delta_resume_schema_mismatch_2'; end if;
  definition:=replace(definition,$before$  rev:=h.revision+1;$before$,$after$  -- Build the event lookup once instead of rescanning/detoasting all items for each progress row.
  select coalesce(jsonb_object_agg((v->>'raw')::jsonb->>'questionId',true),'{}'::jsonb) into event_questions
    from jsonb_array_elements(items) v where v->>'collection'='localStorage' and starts_with(v->>'id','quizMake:sync-event:')
      and (v->>'raw')::jsonb->>'questionId' is not null;
  rev:=h.revision+1;$after$);
  if strpos(definition,$before$exists(select 1 from jsonb_array_elements(items) v where v->>'collection'='localStorage' and starts_with(v->>'id','quizMake:sync-event:') and (v->>'raw')::jsonb->>'questionId'=item->>'id')$before$)=0 then raise exception 'delta_resume_schema_mismatch_3'; end if;
  definition:=replace(definition,$before$exists(select 1 from jsonb_array_elements(items) v where v->>'collection'='localStorage' and starts_with(v->>'id','quizMake:sync-event:') and (v->>'raw')::jsonb->>'questionId'=item->>'id')$before$,$after$event_questions ? (item->>'id')$after$);
  execute definition;
end $migration$;
create index if not exists quiz_sync_records_sync_revision_idx on private.quiz_sync_records(sync_id,revision);
