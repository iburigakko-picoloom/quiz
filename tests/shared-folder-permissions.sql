begin;
do $test$
declare owner uuid; other_user uuid := gen_random_uuid(); result jsonb; loaded jsonb; group_result jsonb; path jsonb := '[{"id":"folder-test","name":"英語"},{"id":"child-test","name":"単語"}]'; payload jsonb := '[{"question":"test","choices":["a","b","c","d"],"answer_indexes":[0],"distractors":["e"],"shuffle_choices":true}]'; rejected boolean := false;
begin
select id into owner from auth.users limit 1;
perform set_config('request.jwt.claim.sub',owner::text,true);
result := public.publish_problem_set(jsonb_build_object('local_set_id',gen_random_uuid()::text,'title','Temporary folder test','visibility','public','folder_path',path),payload);
loaded := public.get_shared_problem_set((result->>'id')::uuid);
if loaded->'folder_path' is distinct from path then raise exception 'folder round trip failed'; end if;
perform set_config('request.jwt.claim.sub',other_user::text,true);
if public.unpublish_problem_set((result->>'id')::uuid) then raise exception 'non-owner could delete'; end if;
perform set_config('request.jwt.claim.sub',owner::text,true);
if not public.unpublish_problem_set((result->>'id')::uuid) then raise exception 'owner cannot delete'; end if;
group_result := public.create_quiz_group('Temporary folder test');
result := public.publish_problem_set(jsonb_build_object('local_set_id',gen_random_uuid()::text,'title','Temporary group test','visibility','group','group_ids',jsonb_build_array(group_result->>'id'),'folder_path',path),payload);
loaded := public.list_group_problem_sets((group_result->>'id')::uuid);
if loaded->0->'folder_path' is distinct from path then raise exception 'group folder round trip failed'; end if;
perform set_config('request.jwt.claim.sub',other_user::text,true);
if public.list_group_problem_sets((group_result->>'id')::uuid) <> '[]'::jsonb then raise exception 'non-member list exposure'; end if;
begin perform public.get_shared_problem_set((result->>'id')::uuid); exception when others then if sqlerrm = 'not authorized' then rejected := true; else raise; end if; end;
if not rejected then raise exception 'non-member read exposure'; end if;
end $test$;
select 'folder storage, group visibility and owner-only removal passed; rolled back' as result;
rollback;
