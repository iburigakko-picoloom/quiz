import {writeFile,readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createPublicationDatabase,publicationQuestions,publicationMetadata,publicationCall} from './helpers/publication-db.mjs';
const pg=await createPublicationDatabase();
const result={environment:'PGlite PostgreSQL, synthetic content only',before:[]};
try {
  if(process.argv.includes('--after')) {
    await pg.exec(await readFile(new URL('../supabase/migrations/20261008151820_resumable_publication.sql',import.meta.url),'utf8'));
    result.after=[];
    for(const count of [10,100,1000,10000]){
      const id=randomUUID(),qs=publicationQuestions(count),meta=publicationMetadata('after-'+count),times=[];const start=performance.now();
      const measured=async(name,args,types)=>{const t=performance.now();const v=await publicationCall(pg,name,args,types);times.push({name,ms:performance.now()-t});return v;};
      await measured('quiz_publish_begin',[id,JSON.stringify(meta),count,'b'.repeat(64)],['uuid','jsonb','integer','text']);
      for(let position=0;position<count;position+=250)await measured('quiz_publish_part',[id,position,JSON.stringify(qs.slice(position,position+250))],['uuid','integer','jsonb']);
      await measured('quiz_publish_finish',[id],['uuid']);
      result.after.push({count,ms:Math.round(performance.now()-start),maxRpcMs:Math.round(Math.max(...times.map(row=>row.ms))),finishMs:Math.round(times.at(-1).ms),rpcCalls:times.length});console.log(result.after.at(-1));
    }
    const t=performance.now();await publicationCall(pg,'publish_problem_set',[JSON.stringify(publicationMetadata('legacy-after')),JSON.stringify(publicationQuestions(1000))],['jsonb','jsonb']);result.legacy1000Ms=Math.round(performance.now()-t);
    await writeFile('tmp/publication-benchmark-after.json',JSON.stringify(result,null,2));console.log('Legacy nonversioned 1,000 questions:',result.legacy1000Ms,'ms');
  } else {
  for(const count of [10,100,1000,10000]) {
    const questions=publicationQuestions(count),metadata=publicationMetadata('before-'+count);const start=performance.now();
    try {await publicationCall(pg,'publish_problem_set_versioned',[JSON.stringify(metadata),JSON.stringify(questions)],['jsonb','jsonb']);result.before.push({count,ms:Math.round(performance.now()-start),bytes:Buffer.byteLength(JSON.stringify(questions))});}
    catch(error){result.before.push({count,error:error.message});}
    console.log(result.before.at(-1));
  }
  await pg.exec(`create table private.fixture_trigger_calls(n integer);insert into private.fixture_trigger_calls values(0);
    create or replace function private.quiz_invalidate_publication_version() returns trigger language plpgsql security definer set search_path='' as $$ begin update private.fixture_trigger_calls set n=n+1;update public.shared_problem_sets set current_version_id=null where id=coalesce(new.set_id,old.set_id) and current_version_id is not null;return null;end $$;`);
  await publicationCall(pg,'publish_problem_set_versioned',[JSON.stringify(publicationMetadata('calls')),JSON.stringify(publicationQuestions(100))],['jsonb','jsonb']);
  result.triggerCallsFor100=(await pg.query('select n from private.fixture_trigger_calls')).rows[0].n;
  await writeFile('tmp/publication-benchmark-before.json',JSON.stringify(result,null,2));console.log('Invalidation trigger calls for 100 questions:',result.triggerCallsFor100);
  }
} finally {await pg.close();}
