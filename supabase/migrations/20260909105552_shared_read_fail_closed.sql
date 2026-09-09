-- Reject NULL permission results for signed-out requests.
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
  if allowed is not true then raise exception 'not authorized'; end if;

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
