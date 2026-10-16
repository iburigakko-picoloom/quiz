-- Private, immutable, account-owned content. No public sharing policy changes.
insert into storage.buckets(id,name,public,file_size_limit)
values('quiz-content-blobs','quiz-content-blobs',false,52428800) on conflict(id) do nothing;
create policy quiz_content_blobs_read on storage.objects for select to authenticated
  using(bucket_id='quiz-content-blobs' and (storage.foldername(name))[1]=(select auth.uid())::text);
create policy quiz_content_blobs_insert on storage.objects for insert to authenticated
  with check(bucket_id='quiz-content-blobs' and name ~ '^[0-9a-f-]{36}/[0-9a-f]{64}$'
    and (storage.foldername(name))[1]=(select auth.uid())::text);
-- No UPDATE/DELETE grant: content hashes name immutable bytes, and old versions
-- may still be referenced by offline devices or a protected recovery original.
