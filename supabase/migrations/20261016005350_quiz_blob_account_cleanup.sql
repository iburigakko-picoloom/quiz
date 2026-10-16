-- Explicit account deletion still removes owned binaries through the Storage
-- API. Ordinary cache cleanup never calls this remote deletion permission.
create policy quiz_content_blobs_delete_owned on storage.objects for delete to authenticated
  using(bucket_id='quiz-content-blobs' and (storage.foldername(name))[1]=(select auth.uid())::text);
