-- Public discovery and group membership are independent publication destinations.
CREATE OR REPLACE FUNCTION public.publish_problem_set(p_set jsonb, p_questions jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  current_user_id uuid := auth.uid();
  target_set_id uuid;
  target_share_token text;
  target_visibility text := coalesce(p_set->>'visibility', 'link');
  add_destinations boolean := coalesce((p_set->>'add_destinations')::boolean, false);
  requested_groups jsonb := coalesce(p_set->'group_ids', '[]'::jsonb);
  question_item jsonb;
  group_id_text text;
  answer_values integer[];
  choice_count integer;
begin
  if current_user_id is null then raise exception 'not authorized'; end if;
  if target_visibility not in ('group', 'link', 'public') then raise exception 'invalid visibility'; end if;
  if jsonb_typeof(p_questions) <> 'array' or jsonb_array_length(p_questions) < 1 or jsonb_array_length(p_questions) > 1000 then
    raise exception 'invalid questions';
  end if;
  if char_length(trim(coalesce(p_set->>'title', ''))) not between 1 and 160 then raise exception 'invalid title'; end if;

  if jsonb_typeof(requested_groups) <> 'array' then raise exception 'invalid groups'; end if;
  if target_visibility = 'group' and jsonb_array_length(requested_groups) = 0 then raise exception 'group required'; end if;

  if p_set ? 'folder_path' then
    if jsonb_typeof(p_set->'folder_path') <> 'array' then raise exception 'invalid folder path'; end if;
    if jsonb_array_length(p_set->'folder_path') > 2 then raise exception 'invalid folder depth'; end if;
    if exists (select 1 from jsonb_array_elements(p_set->'folder_path') item
      where jsonb_typeof(item) <> 'object'
      or jsonb_typeof(item->'id') is distinct from 'string'
      or jsonb_typeof(item->'name') is distinct from 'string'
      or char_length(trim(coalesce(item->>'id',''))) not between 1 and 200
      or char_length(trim(coalesce(item->>'name',''))) not between 1 and 200) then raise exception 'invalid folder path'; end if;
  end if;

  insert into public.shared_problem_sets (
    owner_id, local_set_id, author_name, title, description, subject, audience,
    difficulty, creation_method, source, visibility, question_count, published_at, updated_at, folder_path
  ) values (
    current_user_id,
    left(coalesce(p_set->>'local_set_id', ''), 200),
    left(coalesce(nullif(trim(p_set->>'author_name'), ''), 'Quiz Make ユーザー'), 40),
    trim(p_set->>'title'),
    left(coalesce(p_set->>'description', ''), 2000),
    left(coalesce(p_set->>'subject', ''), 80),
    left(coalesce(p_set->>'audience', ''), 80),
    left(coalesce(p_set->>'difficulty', 'basic'), 40),
    case when p_set->>'creation_method' in ('manual','bulk','chatgpt','copy','import','public-copy') then p_set->>'creation_method' else 'manual' end,
    left(coalesce(p_set->>'source', ''), 500),
    target_visibility,
    jsonb_array_length(p_questions),
    now(),
    now(),
    coalesce(p_set->'folder_path', '[]'::jsonb)
  )
  on conflict (owner_id, local_set_id) do update set
    folder_path = case when p_set ? 'folder_path' then excluded.folder_path else public.shared_problem_sets.folder_path end,
    author_name = excluded.author_name,
    title = excluded.title,
    description = excluded.description,
    subject = excluded.subject,
    audience = excluded.audience,
    difficulty = excluded.difficulty,
    creation_method = excluded.creation_method,
    source = excluded.source,
    visibility = case when add_destinations and public.shared_problem_sets.visibility = 'public' then 'public' else excluded.visibility end,
    question_count = excluded.question_count,
    updated_at = now()
  returning id, share_token, visibility into target_set_id, target_share_token, target_visibility;

  delete from public.shared_questions where set_id = target_set_id;
  if not add_destinations then
    delete from public.quiz_group_problem_sets where set_id = target_set_id;
  end if;

  for question_item in select value from jsonb_array_elements(p_questions)
  loop
    if question_item ? 'distractors' then
      if jsonb_typeof(question_item->'distractors') <> 'array' then raise exception 'invalid distractors'; end if;
      if jsonb_array_length(question_item->'distractors') > 50 then raise exception 'invalid distractors'; end if;
      if exists (select 1 from jsonb_array_elements(question_item->'distractors') item
        where jsonb_typeof(item) <> 'string' or char_length(trim(item #>> '{}')) not between 1 and 10000) then
        raise exception 'invalid distractors';
      end if;
    end if;
    if question_item ? 'shuffle_choices' and jsonb_typeof(question_item->'shuffle_choices') not in ('boolean', 'null') then
      raise exception 'invalid shuffle choices';
    end if;
    choice_count := jsonb_array_length(question_item->'choices');
    if choice_count not between 4 and 5 or char_length(trim(coalesce(question_item->>'question', ''))) = 0 then
      raise exception 'invalid question';
    end if;
    select array_agg(value::integer order by value::integer)
    into answer_values
    from jsonb_array_elements_text(question_item->'answer_indexes');
    if answer_values is null or exists (select 1 from unnest(answer_values) index_value where index_value < 0 or index_value >= choice_count) then
      raise exception 'invalid answer';
    end if;

    insert into public.shared_questions (
      set_id, position, question, choices, answer_indexes, answer_text, explanation,
      detailed_explanation, source_page, category, difficulty, distractors, shuffle_choices
    ) values (
      target_set_id,
      coalesce((question_item->>'position')::integer, 0),
      trim(question_item->>'question'),
      question_item->'choices',
      answer_values,
      left(coalesce(question_item->>'answer_text', ''), 10000),
      left(coalesce(question_item->>'explanation', ''), 30000),
      left(coalesce(question_item->>'detailed_explanation', ''), 60000),
      left(coalesce(question_item->>'source_page', ''), 500),
      left(coalesce(question_item->>'category', ''), 120),
      left(coalesce(question_item->>'difficulty', 'basic'), 40),
      coalesce(question_item->'distractors', '[]'::jsonb),
      (question_item->>'shuffle_choices')::boolean
    );
  end loop;

  if jsonb_array_length(requested_groups) > 0 then
    for group_id_text in select value from jsonb_array_elements_text(requested_groups)
    loop
      if not public.is_quiz_group_member(group_id_text::uuid, current_user_id) then raise exception 'not authorized'; end if;
      insert into public.quiz_group_problem_sets (group_id, set_id, shared_by)
      values (group_id_text::uuid, target_set_id, current_user_id)
      on conflict do nothing;
    end loop;
  end if;

  return jsonb_build_object('id', target_set_id, 'share_token', target_share_token, 'visibility', target_visibility);
end;
$function$
;
