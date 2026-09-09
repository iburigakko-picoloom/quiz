-- Preserve existing RPC grants; old questions keep fixed choices.
alter table public.shared_questions
  add column if not exists distractors jsonb not null default '[]'::jsonb
    check (jsonb_typeof(distractors) = 'array' and jsonb_array_length(distractors) <= 50),
  add column if not exists shuffle_choices boolean;

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

  insert into public.shared_problem_sets (
    owner_id, local_set_id, author_name, title, description, subject, audience,
    difficulty, creation_method, source, visibility, question_count, published_at, updated_at
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
    now()
  )
  on conflict (owner_id, local_set_id) do update set
    author_name = excluded.author_name,
    title = excluded.title,
    description = excluded.description,
    subject = excluded.subject,
    audience = excluded.audience,
    difficulty = excluded.difficulty,
    creation_method = excluded.creation_method,
    source = excluded.source,
    visibility = excluded.visibility,
    question_count = excluded.question_count,
    updated_at = now()
  returning id, share_token into target_set_id, target_share_token;

  delete from public.shared_questions where set_id = target_set_id;
  delete from public.quiz_group_problem_sets where set_id = target_set_id;

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

  if target_visibility = 'group' then
    if jsonb_typeof(coalesce(p_set->'group_ids', '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_set->'group_ids', '[]'::jsonb)) = 0 then
      raise exception 'group required';
    end if;
    for group_id_text in select value from jsonb_array_elements_text(p_set->'group_ids')
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
CREATE OR REPLACE FUNCTION public.get_shared_problem_set(p_set_id uuid, p_share_token text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  set_row public.shared_problem_sets%rowtype;
  allowed boolean := false;
begin
  select * into set_row from public.shared_problem_sets where id = p_set_id;
  if not found then return null; end if;
  allowed := set_row.visibility = 'public'
    or set_row.owner_id = auth.uid()
    or (p_share_token is not null and p_share_token = set_row.share_token)
    or exists (
      select 1 from public.quiz_group_problem_sets links
      where links.set_id = set_row.id and public.is_quiz_group_member(links.group_id)
    );
  if not allowed then raise exception 'not authorized'; end if;

  return jsonb_build_object(
    'id', set_row.id,
    'owner_id', set_row.owner_id,
    'author_name', set_row.author_name,
    'title', set_row.title,
    'description', set_row.description,
    'subject', set_row.subject,
    'audience', set_row.audience,
    'difficulty', set_row.difficulty,
    'creation_method', set_row.creation_method,
    'source', set_row.source,
    'visibility', set_row.visibility,
    'question_count', set_row.question_count,
    'add_count', set_row.add_count,
    'published_at', set_row.published_at,
    'updated_at', set_row.updated_at,
    'questions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'question', question,
        'choices', choices,
        'distractors', distractors,
        'shuffle_choices', shuffle_choices,
        'answer_indexes', answer_indexes,
        'answer_text', answer_text,
        'explanation', explanation,
        'detailed_explanation', detailed_explanation,
        'source_page', source_page,
        'category', category,
        'difficulty', difficulty
      ) order by position)
      from public.shared_questions where set_id = set_row.id
    ), '[]'::jsonb)
  );
end;
$function$
;
