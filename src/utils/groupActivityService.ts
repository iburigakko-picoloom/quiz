import type { AppData, QuizResult } from '../types';
import { getCachedCloudAccountIdentity, groupProgressRpc, recordCloudCopy } from './cloudService';
import { assertAccountNetworkCurrent, sameLocalAccount, type LocalAccountIdentity } from './accountStorage';
import { activityOutbox, drainActivityOutbox } from './groupActivityOutbox';
import { buildStudyActivities, publishStudyActivity } from './groupActivity';
export const GROUP_ACTIVITY_UPDATED='quizmake:group-activity-updated';
export async function retryStudyActivities() {
  const identity=getCachedCloudAccountIdentity();if(!identity)return;
  await drainActivityOutbox(identity,async row=>{
    assertAccountNetworkCurrent(identity);
    await publishStudyActivity(row,async(name,args)=>{
      assertAccountNetworkCurrent(identity);
      // A failed import acknowledgement can be retried without creating another copy.
      if(name==='quiz_group_activity_publish'||name==='quiz_group_activity_publish_v2')await recordCloudCopy(row.setId,row.copyId);
      return groupProgressRpc(name as Parameters<typeof groupProgressRpc>[0],args,identity.userId);
    });
  });
  window.dispatchEvent(new Event(GROUP_ACTIVITY_UPDATED));
}
export async function queueCompletedStudy(data:AppData,result:Pick<QuizResult, 'sessionAnswers'|'studyTime'>, expectedIdentity:LocalAccountIdentity|null=getCachedCloudAccountIdentity()) {
  const identity=getCachedCloudAccountIdentity();if(!identity||!expectedIdentity||!sameLocalAccount(identity,expectedIdentity))return;
  assertAccountNetworkCurrent(identity);
  const events=buildStudyActivities(data,result);if(!events.length)return;
  await activityOutbox(identity).put(events);
  await retryStudyActivities();
}
