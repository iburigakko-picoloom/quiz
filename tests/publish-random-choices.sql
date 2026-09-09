begin;
do $test$
declare uid uuid; result jsonb; loaded jsonb; payload jsonb; rejected boolean := false;
begin
  select id into uid from auth.users limit 1;
  if uid is null then raise exception 'no test user context'; end if;
  perform set_config('request.jwt.claim.sub',uid::text,true);
  payload := '[{"position":0,"question":"Round-trip test","choices":["a","b","c","d"],"answer_indexes":[0],"distractors":["e","f"],"shuffle_choices":true}]'::jsonb;
  result := public.publish_problem_set(jsonb_build_object('local_set_id',gen_random_uuid()::text,'title','Temporary transaction test','visibility','link'),payload);
  loaded := public.get_shared_problem_set((result->>'id')::uuid);
  if loaded->'questions'->0->'distractors' is distinct from '["e","f"]'::jsonb or loaded->'questions'->0->'shuffle_choices' is distinct from 'true'::jsonb then raise exception 'round trip failed'; end if;
  begin
    perform public.publish_problem_set(jsonb_build_object('local_set_id',gen_random_uuid()::text,'title','Invalid test','visibility','link'),jsonb_set(payload,'{0,distractors}','[123]'::jsonb));
  exception when others then
    if sqlerrm = 'invalid distractors' then rejected := true; else raise; end if;
  end;
  if not rejected then raise exception 'invalid payload accepted'; end if;
  perform set_config('request.jwt.claim.sub','',true);
  rejected := false;
  begin perform public.get_shared_problem_set((result->>'id')::uuid);
  exception when others then if sqlerrm = 'not authorized' then rejected := true; else raise; end if; end;
  if not rejected then raise exception 'private data exposed'; end if;
  loaded := public.get_shared_problem_set((result->>'id')::uuid,result->>'share_token');
  if loaded->'questions'->0->'shuffle_choices' is distinct from 'true'::jsonb then raise exception 'link read failed'; end if;
  perform set_config('request.jwt.claim.sub',uid::text,true);
  result := public.publish_problem_set(jsonb_build_object('local_set_id',gen_random_uuid()::text,'title','Legacy transaction test','visibility','public'), (payload #- '{0,distractors}') #- '{0,shuffle_choices}');
  perform set_config('request.jwt.claim.sub','',true);
  loaded := public.get_shared_problem_set((result->>'id')::uuid);
  if loaded->'questions'->0->'distractors' is distinct from '[]'::jsonb or loaded->'questions'->0->'shuffle_choices' is distinct from 'null'::jsonb then raise exception 'legacy default failed'; end if;
end $test$;
select 'round trip, legacy defaults, validation and access checks passed; test data rolled back' as result;
rollback;
