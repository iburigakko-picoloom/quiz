-- Remote migration version: 20260919153531. Existing sync rows/tables are untouched.
-- PDF objects are private and immutable.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('quiz-material-pdfs', 'quiz-material-pdfs', false, 52428800, array['application/pdf']);

create policy quiz_material_pdf_read on storage.objects for select to authenticated
using (bucket_id = 'quiz-material-pdfs' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy quiz_material_pdf_insert on storage.objects for insert to authenticated
with check (bucket_id = 'quiz-material-pdfs'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and name ~ '^[a-f0-9-]{36}/[a-f0-9]{64}\.pdf$');

-- No UPDATE policy: content-addressed PDFs must never be overwritten.
create policy quiz_material_pdf_delete on storage.objects for delete to authenticated
using (bucket_id = 'quiz-material-pdfs' and (storage.foldername(name))[1] = (select auth.uid())::text);
