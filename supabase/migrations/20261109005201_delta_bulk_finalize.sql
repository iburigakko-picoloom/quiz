-- Preserve receipt IDs, staged bytes, validation, history and atomic commit.
set local lock_timeout = '2s';
do $migration$
declare definition text := replace(pg_get_functiondef('private.quiz_delta_sync(text,text,jsonb)'::regprocedure),chr(13)||chr(10),chr(10));
  old_insert text := $old$    insert into private.quiz_sync_records values(p_sync_id,key_value,item->>'collection',item->>'id',raw_value,(item->>'position')::integer,rev)
      on conflict(sync_id,record_key) do update set raw=excluded.raw,position=excluded.position,revision=excluded.revision;$old$;
begin
  if strpos(definition,'event_questions jsonb;')=0 or strpos(definition,old_insert)=0 or strpos(definition,'  parent_deleted:=exists')=0 then
    raise exception 'delta_bulk_schema_mismatch';
  end if;
  definition := replace(definition,'event_questions jsonb;','event_questions jsonb; bulk_rows private.quiz_sync_records[] := ''{}'';');
  definition := replace(definition,old_insert,$new$    bulk_rows := array_append(bulk_rows, row(p_sync_id,key_value,item->>'collection',item->>'id',raw_value,(item->>'position')::integer,rev)::private.quiz_sync_records);$new$);
  definition := replace(definition,'  parent_deleted:=exists',$new$  -- Input keys are unique (validated above), so deferred writes cannot affect
  -- another input row's previous value. Publish before cascades and events.
  insert into private.quiz_sync_records select b.* from unnest(bulk_rows) b
    on conflict(sync_id,record_key) do update set raw=excluded.raw,position=excluded.position,revision=excluded.revision;
  parent_deleted:=exists$new$);
  execute definition;
end $migration$;
-- Only this sync RPC gets room for large legacy operations; other APIs retain
-- their existing budgets. The client waits longer than the database deadline.
alter function public.quiz_delta_sync(text,text,jsonb) set statement_timeout = '60s';
