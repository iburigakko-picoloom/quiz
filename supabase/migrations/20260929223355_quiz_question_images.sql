-- Immutable content-addressed question images. Existing local images remain on
-- their devices until explicitly migrated; private reads require the owner JWT.
insert into storage.buckets (id,name,public,file_size_limit,allowed_mime_types)
values ('quiz-question-images','quiz-question-images',false,52428800,array['image/png','image/jpeg','image/webp','image/heic','image/heif'])
on conflict (id) do nothing;
create policy "quiz_question_images_owner_read" on storage.objects for select to authenticated
using (bucket_id='quiz-question-images' and (storage.foldername(name))[1]=(select auth.uid())::text);
create policy "quiz_question_images_owner_insert" on storage.objects for insert to authenticated
with check (bucket_id='quiz-question-images' and (storage.foldername(name))[1]=(select auth.uid())::text
  and name ~ '^[0-9a-f-]{36}/[0-9a-f]{64}\.(png|jpg|webp|heic|heif)$');
