import type { AppData } from '../../src/types';
import type { CloudGroup, CloudProblemSet } from '../../src/utils/cloudService';
import type { GroupLearningSnapshot } from '../../src/utils/groupLearningService';

const timestamp = '2026-10-08T00:00:00Z';
export const previewGroup: CloudGroup = { id: 'preview-group', name: '医学科3年', role: 'owner', icon: 'group', accent: 'blue', memberCount: 8, setCount: 6 };
export const previewSets: CloudProblemSet[] = ['心不全', '不整脈', '高血圧', '心電図', '糖尿病', '甲状腺'].map((title, i) => ({
  id: `set-${i}`, localSetId: `local-${i}`, ownerId: i < 3 ? 'you' : i < 4 ? 'sato' : 'yamada', authorName: i < 3 ? 'あなた' : i < 4 ? '佐藤' : '山田', title, description: '授業内容の確認に使う問題セットです。', subject: '医学', audience: 'CBT対策', difficulty: 'basic', creationMethod: 'manual', source: '', visibility: 'group', questionCount: i === 0 ? 45 : 30, addCount: 6, importCount: 6, publishedAt: timestamp, updatedAt: timestamp, versionId: `version-${i}`,
  questions: Array.from({ length: i === 0 ? 45 : 30 }, (_, j) => ({ logicalId: `question-${i}-${j}`, question: `${['心不全の分類', 'BNPの解釈', '急性心不全の初期対応'][j % 3]}\n次の選択肢から、授業で確認した内容に当てはまるものを選んでください。`, choices: ['選択肢A', '選択肢B', '選択肢C', '選択肢D'], answerIndexes: [0], answerText: '選択肢A', explanation: '', detailedExplanation: '', sourcePage: '', category: i < 4 ? '循環器' : '内分泌', difficulty: j % 2 ? 'standard' : 'basic' })),
}));
const folderNames = ['CBT対策', '循環器', '内分泌'];
export const previewSnapshot: GroupLearningSnapshot = {
  icon: 'group', accent: 'blue',
  folders: folderNames.map((name, i) => ({ id: `folder-${i}`, name, parentId: null, createdBy: ['you','sato','yamada'][i], creatorName: ['あなた','佐藤','山田'][i], createdAt: timestamp, updatedAt: timestamp, importCount: [8,5,6][i] })),
  placements: previewSets.map((set, i) => ({ setId: set.id, folderId: `folder-${i < 3 ? 0 : i < 4 ? 1 : 2}` })),
  members: ['あなた','佐藤','山田','鈴木','伊藤','田中','渡辺','小林'].map((displayName, i) => ({ userId: ['you','sato','yamada','suzuki','ito','tanaka','watanabe','kobayashi'][i], displayName, role: i === 0 ? 'owner' : 'member', importedSetCount: [3,2,4,2,3,1,0,0][i], levels: i < 6 ? ([[15,13,10,7],[13,14,10,8],[18,13,9,5],[10,12,14,9],[17,12,11,5],[45,0,0,0]][i] as [number,number,number,number]) : null, todayCount: i < 6 ? [82,46,31,28,25,0][i] : null, weekCount: i < 6 ? [240,155,120,98,87,0][i] : null, sharedSetCount: i < 6 ? 1 : 0 })),
};
export const previewData: AppData = { version: 1, folders: [], problemSets: [], questions: [], progress: [], answerLogs: [] };
