alter table public.quiz_groups add column photo text check(photo is null or (char_length(photo)<=100000 and photo ~ '^data:image/jpeg;base64,[A-Za-z0-9+/]+={0,2}$'));

create function quiz_private.group_icon_owner_guard() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if (new.photo is distinct from old.photo or new.icon is distinct from old.icon or new.accent is distinct from old.accent) and auth.uid() is distinct from old.owner_id then raise exception 'not authorized';end if;
 return new;
end $$;
revoke all on function quiz_private.group_icon_owner_guard() from public,anon,authenticated;
create trigger quiz_group_icon_owner_guard before update of photo,icon,accent on public.quiz_groups for each row execute function quiz_private.group_icon_owner_guard();

create function quiz_private.group_photo(p_group_id uuid,p_photo text) returns boolean language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null then raise exception 'not authorized';end if;
 perform 1 from public.quiz_groups where id=p_group_id and owner_id=auth.uid() for update;
 if not found then raise exception 'not authorized';end if;
 if p_photo is not null and (char_length(p_photo)>100000 or p_photo !~ '^data:image/jpeg;base64,[A-Za-z0-9+/]+={0,2}$') then raise exception 'invalid group photo';end if;
 update public.quiz_groups set photo=p_photo,updated_at=now() where id=p_group_id;
 return true;
end $$;
create function public.quiz_group_photo(p_group_id uuid,p_photo text) returns boolean language sql security invoker set search_path='' as $$select quiz_private.group_photo(p_group_id,p_photo);$$;
revoke all on function quiz_private.group_photo(uuid,text),public.quiz_group_photo(uuid,text) from public,anon;
grant execute on function quiz_private.group_photo(uuid,text),public.quiz_group_photo(uuid,text) to authenticated;

create or replace function public.list_my_groups() returns jsonb language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',g.id,'name',g.name,'icon',g.icon,'accent',g.accent,'photo',g.photo,'role',m.role,
 'member_count',(select count(*) from public.quiz_group_members where group_id=g.id),
 'set_count',(select count(*) from public.quiz_group_problem_sets where group_id=g.id)) order by g.updated_at desc),'[]'::jsonb)
 from public.quiz_groups g join public.quiz_group_members m on m.group_id=g.id and m.user_id=auth.uid();
$$;
