import type { AppData, AppScreen, QuizResult } from '../types';

export function getScreenKey(screen: AppScreen): string {
  if (screen.name === 'settings') return `settings-${screen.page ?? 'main'}`;
  if (screen.name === 'questionDetail') return `question-${screen.questionId}`;
  if (screen.name === 'questionEdit') return `question-edit-${screen.questionId}`;
  if (screen.name === 'detailedAnswer') return `detailed-answer-${screen.questionId}-${Boolean(screen.editing)}`;
  if (screen.name === 'createProblemSet') return `create-${screen.editSetId ?? ''}-${screen.folderId ?? ''}`;
  if (screen.name === 'folder') return `folder-${screen.folderId}`;
  if (screen.name === 'community') return `community-${screen.tab ?? 'mine'}-${screen.groupPage ?? ''}-${screen.groupId ?? ''}-${screen.shareSetId ?? ''}`;
  if (screen.name === 'problemSetDetail') return `detail-${screen.setId}`;
  if (screen.name === 'problemList') return `problem-list-${screen.setId}-${screen.sortMode ?? 'ordered'}`;
  if (screen.name === 'noteList') return `note-list-${screen.setId}`;
  if (screen.name === 'noteDetail') return `note-detail-${screen.setId}-${screen.category}`;
  if (screen.name === 'import') return `import-${screen.folderId}`;
  if (screen.name === 'quiz') return `quiz-${screen.setId}-${screen.mode}`;
  if (screen.name === 'quizSession') return `quiz-session-${screen.session.setId ?? 'custom'}-${screen.session.initialIndex ?? 0}-${screen.session.questions.length}`;
  if (screen.name === 'result') return `result-${screen.result.title}-${screen.result.answered}`;
  return screen.name;
}

export function getBackNavigationSteps(stack: AppScreen[], target: AppScreen): number {
  const targetKey = getScreenKey(target);
  for (let index = stack.length - 2; index >= 0; index -= 1) {
    if (getScreenKey(stack[index]) === targetKey) {
      return Math.max(1, stack.length - 1 - index);
    }
  }
  return 1;
}

export function getCreateProblemSetBackScreen(
  screen: Extract<AppScreen, { name: 'createProblemSet' }>,
): AppScreen | null {
  if (screen.backScreen && screen.backScreen.name !== 'createProblemSet') return screen.backScreen;
  if (screen.editSetId) return { name: 'problemSetDetail', setId: screen.editSetId };
  if (screen.folderId) return { name: 'folder', folderId: screen.folderId };
  return null;
}

export function getResultReturnScreen(result: QuizResult, data: AppData): AppScreen {
  const target = result.returnScreen
    ?? result.retry?.backScreen
    ?? (result.setId ? { name: 'problemSetDetail', setId: result.setId } : { name: 'home' });

  if (target.name === 'folder') {
    return data.folders.some((folder) => folder.id === target.folderId) ? target : { name: 'home' };
  }
  if (target.name === 'problemSetDetail' || target.name === 'problemList' || target.name === 'noteList' || target.name === 'noteDetail') {
    return data.problemSets.some((set) => set.id === target.setId) ? target : { name: 'home' };
  }
  if (target.name === 'import') {
    return data.folders.some((folder) => folder.id === target.folderId) ? target : { name: 'home' };
  }
  if (target.name === 'quiz' || target.name === 'quizSession' || target.name === 'result') {
    return { name: 'home' };
  }
  return target;
}

export function getResultReturnLabel(target: AppScreen): string {
  if (target.name === 'problemSetDetail') return '問題セットへ戻る';
  if (target.name === 'problemList') return '問題一覧へ戻る';
  if (target.name === 'noteList') return 'ノート一覧へ戻る';
  if (target.name === 'folder') return 'フォルダへ戻る';
  if (target.name === 'community') {
    if (target.groupId) return target.shareSetId ? 'グループの問題へ戻る' : 'グループへ戻る';
    return target.shareSetId || target.shareToken ? '共有詳細へ戻る' : '共有画面へ戻る';
  }
  if (target.name === 'home') return 'ホームへ戻る';
  return '前の画面へ戻る';
}
