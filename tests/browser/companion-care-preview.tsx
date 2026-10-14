import React from 'react';
import { createRoot } from 'react-dom/client';
import App from '../../src/App';
import { AccountStorageSession, activateAccountStorage, accountLocalStorage } from '../../src/utils/accountStorage';
import { loadAppDataAsync, saveAppData } from '../../src/storage';
import { createInitialProgress } from '../../src/utils/quiz';
import type { AppData } from '../../src/types';
import '../../src/index.css';
import '../../src/ui-spec.css';
import '../../src/final-reference.css';
import '../../src/group-ui.css';

// Full App in an isolated anonymous browser context; synthetic records only.
async function preview() {
  if (!import.meta.env.DEV) return;
  activateAccountStorage(new AccountStorageSession(globalThis.localStorage, { identity: null, namespace: 'guest', legacyUnclaimed: false }));
  accountLocalStorage.setItem('quiz-make-welcome-v1', 'done');
  const count = Number(new URLSearchParams(location.search).get('answers') ?? 49);
  const timestamp = new Date().toISOString();
  if (!(await loadAppDataAsync()).questions.length) {
    const data: AppData = { version: 1,
      folders: [{ id: 'f', name: '育成の検証', createdAt: timestamp, updatedAt: timestamp }],
      problemSets: [{ id: 's', folderId: 'f', title: '確認クイズ', source: '', createdAt: timestamp, updatedAt: timestamp }],
      questions: [{ id: 'q', setId: 's', question: '正解の選択肢は？', choices: ['正解', '不正解', '選択肢C', '選択肢D'], answerIndex: 0, answerText: '正解', explanation: '正解はAです。', sourcePage: '', category: '検証', difficulty: 'basic', createdAt: timestamp, updatedAt: timestamp }],
      progress: [{ ...createInitialProgress('q'), answeredCount: count, correctCount: count, lastSelectedIndex: 0, lastAnswerCorrect: true, lastAnsweredAt: timestamp }],
      answerLogs: Array.from({ length: count }, (_, i) => ({ id: `baseline-${i}`, questionId: 'q', setId: 's', folderId: 'f', selectedIndex: 0, isCorrect: true, answeredAt: timestamp })),
    };
    if (!await saveAppData(data)) throw new Error('検証用の回答を保存できませんでした。');
  }
  createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
}
void preview();
