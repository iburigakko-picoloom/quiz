import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { AppData, AppScreen, Folder, ProblemSet, Question, QuizResult, QuizSession } from './types';
import {
  createEmptyAppData,
  establishCurrentAppDataAuthority,
  loadAppDataAsync,
  parseBackupJson,
  saveAppData,
  waitForPendingAppDataSaves,
} from './storage';
import { HomeScreen } from './screens/HomeScreen';
import { SharedImageReceiver } from './components/SharedImageReceiver';
import { appendSharedImage } from './utils/sharedImage';
import { FolderScreen } from './screens/FolderScreen';
import { QuestionDetailScreen } from './screens/QuestionDetailScreen';
import { applyQuestionExplanations } from './utils/weaknessNotes';
import { QuestionEditScreen } from './screens/QuestionEditScreen';
import { DetailedAnswerScreen } from './screens/DetailedAnswerScreen';
import { NoteOverviewScreen } from './screens/NoteOverviewScreen';
import { ProblemSetDetailScreen } from './screens/ProblemSetDetailScreen';
import { ProblemListScreen } from './screens/ProblemListScreen';
import { ResultScreen } from './screens/ResultScreen';
import { SessionAnswersScreen } from './screens/SessionAnswersScreen';
import { BackupScreen } from './screens/BackupScreen';
import { BackupCompleteScreen } from './screens/BackupCompleteScreen';
import { saveBackupPayload } from './utils/backupRepository';
import type { CreateProblemSetSubmission, LegacyImportTarget } from './screens/CreateProblemSetScreen';
import { lineLinkReturn } from './utils/lineAuthReturn';
import { AutoSyncController } from './components/AutoSyncController';
import { WelcomeGuide } from './components/WelcomeGuide';
import { ConfirmDialog } from './components/ConfirmDialog';
import { PrimaryBottomNav, type PrimaryNavItem } from './components/PrimaryBottomNav';
import { StorageRecoveryPanel } from './components/StorageRecoveryPanel';
import { createId } from './utils/id';
import { folderSubtreeIds } from './utils/folderHierarchy';
import { formatBackupDate, nowIso } from './utils/date';
import {
  getBackNavigationSteps,
  getCreateProblemSetBackScreen,
  getResultReturnLabel,
  getResultReturnScreen,
  getScreenKey,
} from './utils/navigation';
import {
  addFolder,
  deleteFolder,
  deleteProblemSet,
  getAnswerIndexes,
  recordAnswer,
  toggleAmbiguous,
  updateQuestionDetailedExplanation,
} from './utils/quiz';
import { validateImportJson } from './utils/importValidator';
import { getDraftAnswerIndexes } from './utils/bulkQuestionParser';
import { exportQuizMakeRecoveryData, getAutoSyncSettings, importQuizMakeData, setAutoSyncEnabled, summarizeSyncPayload, validateSyncPayload, type SyncPayload, type SyncPayloadSummary } from './utils/syncService';
import { waitForPendingCategoryNoteSaves } from './utils/noteStorage';
import { persistLibraryDeletion, type LibraryDeletionResult } from './utils/libraryDeletion';
import { saveJsonBackup } from './utils/nativePlatform';
import { createSampleAppData } from './utils/sampleData';
import { setActiveProtectedWorkReason, type ProtectedWorkReason } from './utils/protectedWork';
import {
  initializeCloudNativeAuth,
  onNativeAuthResult,
  type CloudProblemSet,
  type CloudPublishResult,
} from './utils/cloudService';
const CommunityScreen = lazy(() => import('./screens/CommunityScreen').then((module) => ({ default: module.CommunityScreen })));
const CreateProblemSetScreen = lazy(() => import('./screens/CreateProblemSetScreen').then((module) => ({ default: module.CreateProblemSetScreen })));
const QuizScreen = lazy(() => import('./screens/QuizScreen').then((module) => ({ default: module.QuizScreen })));
const QuizRunner = lazy(() => import('./screens/QuizRunner').then((module) => ({ default: module.QuizRunner })));
const NoteListScreen = lazy(() => import('./screens/NoteListScreen').then((module) => ({ default: module.NoteListScreen })));
const ImportScreen = lazy(() => import('./screens/ImportScreen').then((module) => ({ default: module.ImportScreen })));
const SettingsScreen = lazy(() => import('./screens/SettingsScreen').then((module) => ({ default: module.SettingsScreen })));
const SyncScreen = lazy(() => import('./screens/SyncScreen').then((module) => ({ default: module.SyncScreen })));
const PrivacyScreen = lazy(() => import('./screens/PrivacyScreen').then((module) => ({ default: module.PrivacyScreen })));
type PendingBackupImport =
  | { kind: 'sync'; payload: SyncPayload; summary: SyncPayloadSummary }
  | { kind: 'legacy'; data: AppData };
export default function App() {
  const [data, setData] = useState<AppData>(() => createEmptyAppData());
  const [storageReady, setStorageReady] = useState(false);
  const [receivingSharedImage,setReceivingSharedImage] = useState(()=>new URL(location.href).searchParams.has('sharedImage')||new URL(location.href).searchParams.has('sharedImageError'));
  const [storageLoadError, setStorageLoadError] = useState('');
  const [storageLoadAttempt, setStorageLoadAttempt] = useState(0);
  const dataRef = useRef(data);
  const durableDataRef = useRef(data);
  const [screen, setScreen] = useState<AppScreen>(lineLinkReturn ? { name: 'settings', page: 'account' } : { name: 'home' });
  const [transitionDirection, setTransitionDirection] = useState<'forward' | 'back' | 'replace'>('replace');
  const [waitingWorker, setWaitingWorker] = useState<ServiceWorker | null>(null);
  const [pendingExitTarget, setPendingExitTarget] = useState<AppScreen | null>(null);
  const [pendingExitReason, setPendingExitReason] = useState<'quiz' | 'create' | null>(null);
  const [createDraftDirty, setCreateDraftDirty] = useState(false);
  const [pendingBackupImport, setPendingBackupImport] = useState<PendingBackupImport | null>(null);
  const [backupImportBusy, setBackupImportBusy] = useState(false);
  const [backupImportError, setBackupImportError] = useState('');
  const [backupExportNotice, setBackupExportNotice] = useState('');
  const [authNotice, setAuthNotice] = useState('');
  const [storageRecoverySyncOpen, setStorageRecoverySyncOpen] = useState(false);
  const [libraryMutationBusy, setLibraryMutationBusy] = useState(false);
  const [storageError, setStorageError] = useState('');
  const navigationStackRef = useRef<AppScreen[]>(lineLinkReturn ? [{ name: 'home' }, { name: 'settings', page: 'account' }] : [{ name: 'home' }]);
  const noteExitGuardRef = useRef<((proceed: () => void) => Promise<boolean>) | null>(null);
  const noteHistoryPendingRef = useRef(false);
  const browserDepthRef = useRef(0);
  const pendingBackTargetRef = useRef<AppScreen | null>(null);
  const pendingBackStepsRef = useRef(1);
  const pendingExitTargetRef = useRef<AppScreen | null>(null);
  const pendingExitModeRef = useRef<'back' | 'replace'>('back');
  const confirmedProtectedExitRef = useRef(false);
  const createDraftDirtyRef = useRef(false);
  const screenRef = useRef<AppScreen>(lineLinkReturn ? { name: 'settings', page: 'account' } : { name: 'home' });
  const dataRevisionRef = useRef(0);
  const libraryMutationBusyRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setStorageReady(false);
    setStorageLoadError('');
    void loadAppDataAsync()
      .then((loadedData) => {
        if (cancelled) return;
        dataRef.current = loadedData;
        durableDataRef.current = loadedData;
        setData(loadedData);
        const url = new URL(window.location.href);
        const sharedSetId = url.searchParams.get('sharedSet') ?? '';
        const shareToken = url.searchParams.get('token') ?? '';
        if (sharedSetId) {
          const sharedScreen: AppScreen = { name: 'community', tab: 'discover', shareSetId: sharedSetId, shareToken };
          navigationStackRef.current = [sharedScreen];
          screenRef.current = sharedScreen;
          setScreen(sharedScreen);
        }
        setStorageReady(true);
      })
      .catch((error) => {
        if (cancelled) return;
        setStorageLoadError(error instanceof Error ? error.message : '保存データを読み込めませんでした。');
        setStorageReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [storageLoadAttempt]);

  useEffect(() => {
    screenRef.current = screen;
  }, [screen]);

  useEffect(() => {
    createDraftDirtyRef.current = createDraftDirty;
  }, [createDraftDirty]);

  const protectedWorkReason = receivingSharedImage ? 'import' : getSyncProtectedWorkReason(
    screen,
    createDraftDirty,
    pendingBackupImport !== null || backupImportBusy,
    libraryMutationBusy,
  );

  useEffect(() => {
    setActiveProtectedWorkReason(protectedWorkReason);
    return () => setActiveProtectedWorkReason(null);
  }, [protectedWorkReason]);

  useEffect(() => {
    window.history.replaceState({ quizMake: true }, '');

    const handlePopState = () => {
      const current = screenRef.current;
      const target = pendingBackTargetRef.current ?? navigationStackRef.current[navigationStackRef.current.length - 2] ?? { name: 'home' };
      const historySteps = pendingBackStepsRef.current;
      pendingBackTargetRef.current = null;
      pendingBackStepsRef.current = 1;

      if (current.name === 'noteDetail' && noteExitGuardRef.current) {
        if (noteHistoryPendingRef.current) {
          window.history.pushState({ quizMake: true }, '');
          return;
        }
        noteHistoryPendingRef.current = true;
        void noteExitGuardRef.current(() => applyBackNavigation(target, historySteps)).then((completed) => {
          if (!completed) window.history.pushState({ quizMake: true }, '');
        }).finally(() => { noteHistoryPendingRef.current = false; });
        return;
      }

      const exitReason = getProtectedExitReason(current, createDraftDirtyRef.current);
      if (exitReason && !confirmedProtectedExitRef.current) {
        window.history.pushState({ quizMake: true }, '');
        pendingExitTargetRef.current = target;
        pendingExitModeRef.current = 'back';
        setPendingExitReason(exitReason);
        setPendingExitTarget(target);
        return;
      }

      if (confirmedProtectedExitRef.current) {
        confirmedProtectedExitRef.current = false;
      }
      applyBackNavigation(target, historySteps);
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);
  useEffect(() => {
    const handleUpdate = (event: WindowEventMap['quiz-make-sw-update']) => {
      setWaitingWorker(event.detail.worker);
    };
    window.addEventListener('quiz-make-sw-update', handleUpdate);
    return () => window.removeEventListener('quiz-make-sw-update', handleUpdate);
  }, []);

  const commitData = async (nextData: AppData): Promise<boolean> => {
    if (libraryMutationBusyRef.current) {
      setStorageError('削除処理が完了するまでお待ちください。');
      return false;
    }
    const revision = dataRevisionRef.current + 1;
    dataRevisionRef.current = revision;
    dataRef.current = nextData;
    setData(nextData);
    const saved = await saveAppData(nextData);
    if (saved) {
      durableDataRef.current = nextData;
      if (dataRevisionRef.current === revision) setStorageError('');
      return true;
    }
    if (dataRevisionRef.current === revision) {
      dataRef.current = durableDataRef.current;
      setData(durableDataRef.current);
      setStorageError('端末への保存に失敗しました。保存前の状態に戻しました。空き容量やブラウザの保存設定を確認して、もう一度お試しください。');
    }
    return saved;
  };

  const persistThenCommitData = async (nextData: AppData): Promise<boolean> => {
    if (libraryMutationBusyRef.current) {
      setStorageError('削除処理が完了するまでお待ちください。');
      return false;
    }
    const revision = dataRevisionRef.current + 1;
    dataRevisionRef.current = revision;
    // Reserve the next snapshot immediately. Any action taken while this durable
    // save is pending will now build on top of it instead of an older snapshot.
    dataRef.current = nextData;
    const saved = await saveAppData(nextData);
    if (!saved) {
      if (dataRevisionRef.current === revision) {
        dataRef.current = durableDataRef.current;
        setData(durableDataRef.current);
        setStorageError('端末への保存に失敗しました。保存前の状態に戻しました。空き容量やブラウザの保存設定を確認して、もう一度お試しください。');
      }
      return false;
    }
    durableDataRef.current = nextData;
    // A newer mutation may already contain this snapshot plus further changes.
    // Do not roll the UI back to this older snapshot when that happens.
    if (dataRevisionRef.current === revision) {
      dataRef.current = nextData;
      setData(nextData);
    }
    setStorageError('');
    return true;
  };

  const navigate = (next: AppScreen) => {
    navigationStackRef.current = [...navigationStackRef.current, next];
    browserDepthRef.current += 1;
    window.history.pushState({ quizMake: true }, '');
    setTransitionDirection('forward');
    setScreen(next);
  };

  const applyBackNavigation = (target: AppScreen, historySteps = 1) => {
    const targetKey = getScreenKey(target);
    const stack = navigationStackRef.current;
    let targetIndex = -1;
    for (let index = stack.length - 1; index >= 0; index -= 1) {
      if (getScreenKey(stack[index]) === targetKey) {
        targetIndex = index;
        break;
      }
    }

    navigationStackRef.current = targetIndex >= 0 ? stack.slice(0, targetIndex + 1) : [target];
    browserDepthRef.current = Math.max(0, browserDepthRef.current - historySteps);
    pendingBackTargetRef.current = null;
    setTransitionDirection('back');
    setScreen(target);
  };

  const performBackNavigation = (target: AppScreen) => {
    pendingBackTargetRef.current = target;
    const desiredSteps = target.name === 'home'
      ? browserDepthRef.current
      : getBackNavigationSteps(navigationStackRef.current, target);
    if (browserDepthRef.current > 0) {
      const historySteps = Math.min(desiredSteps, browserDepthRef.current);
      pendingBackStepsRef.current = historySteps;
      window.history.go(-historySteps);
      return;
    }
    pendingBackTargetRef.current = null;
    pendingBackStepsRef.current = 1;
    applyBackNavigation(target, 0);
  };

  const goBackTo = (next: AppScreen) => {
    const exitReason = getProtectedExitReason(screenRef.current, createDraftDirtyRef.current);
    if (exitReason) {
      pendingExitTargetRef.current = next;
      pendingExitModeRef.current = 'back';
      setPendingExitReason(exitReason);
      setPendingExitTarget(next);
      return;
    }
    performBackNavigation(next);
  };

  const replaceScreen = (next: AppScreen) => {
    const stack = navigationStackRef.current;
    navigationStackRef.current = stack.length > 0 ? [...stack.slice(0, -1), next] : [next];
    window.history.replaceState({ quizMake: true }, '');
    setTransitionDirection('replace');
    setScreen(next);
  };

  useEffect(() => {
    let cancelled = false;
    let stopNativeListener: (() => Promise<void>) | null = null;
    const unsubscribeResult = onNativeAuthResult((event) => {
      if (cancelled) return;
      if (event.type === 'error') {
        setStorageError(event.message);
        return;
      }

      setAuthNotice(event.message);
      setStorageError('');
      const target: AppScreen = event.returnTarget ?? { name: 'settings' };
      if (getProtectedExitReason(screenRef.current, createDraftDirtyRef.current)) return;
      replaceScreen(target);
    });

    void initializeCloudNativeAuth()
      .then((stop) => {
        if (cancelled) void stop();
        else stopNativeListener = stop;
      })
      .catch(() => {
        if (!cancelled) setStorageError('ログインリンクを受け取る準備ができませんでした。アプリを開き直して、もう一度お試しください。');
      });

    return () => {
      cancelled = true;
      unsubscribeResult();
      if (stopNativeListener) void stopNativeListener();
    };
  }, []);

  const cancelProtectedExit = () => {
    pendingExitTargetRef.current = null;
    pendingExitModeRef.current = 'back';
    setPendingExitReason(null);
    setPendingExitTarget(null);
  };

  const confirmProtectedExit = () => {
    const target = pendingExitTargetRef.current ?? pendingExitTarget ?? { name: 'home' };
    const navigationMode = pendingExitModeRef.current;
    pendingExitTargetRef.current = null;
    pendingExitModeRef.current = 'back';
    setPendingExitReason(null);
    setPendingExitTarget(null);
    confirmedProtectedExitRef.current = true;
    if (navigationMode === 'replace') {
      confirmedProtectedExitRef.current = false;
      replaceScreen(target);
      return;
    }
    pendingBackTargetRef.current = target;
    const desiredSteps = target.name === 'home'
      ? browserDepthRef.current
      : getBackNavigationSteps(navigationStackRef.current, target);
    if (browserDepthRef.current > 0) {
      const historySteps = Math.min(desiredSteps, browserDepthRef.current);
      pendingBackStepsRef.current = historySteps;
      window.history.go(-historySteps);
      return;
    }
    confirmedProtectedExitRef.current = false;
    pendingBackTargetRef.current = null;
    pendingBackStepsRef.current = 1;
    applyBackNavigation(target, 0);
  };

  const goHome = () => {
    const url = new URL(window.location.href);
    if (url.searchParams.has('sharedSet') || url.searchParams.has('token')) {
      url.searchParams.delete('sharedSet');
      url.searchParams.delete('token');
      window.history.replaceState({ quizMake: true }, '', `${url.pathname}${url.search}${url.hash}`);
    }
    goBackTo({ name: 'home' });
  };

  const navigatePrimary = (item: PrimaryNavItem) => {
    const next: AppScreen = item === 'home'
      ? { name: 'home' }
      : item === 'discover'
        ? { name: 'community', tab: 'discover' }
        : item === 'groups'
          ? { name: 'community', tab: 'groups' }
          : item === 'create'
            ? { name: 'createProblemSet' }
            : { name: 'settings' };
    if (getScreenKey(screenRef.current) === getScreenKey(next)) return;
    if (item === 'home') {
      goHome();
      return;
    }
    const exitReason = getProtectedExitReason(screenRef.current, createDraftDirtyRef.current);
    if (exitReason) {
      pendingExitTargetRef.current = next;
      pendingExitModeRef.current = 'replace';
      setPendingExitReason(exitReason);
      setPendingExitTarget(next);
      return;
    }
    replaceScreen(next);
  };

  const handleCreateFolder = (name: string) => {
    void commitData(addFolder(dataRef.current, name));
  };

  const handleDeleteFolder = async (folderId: string) => {
    if (libraryMutationBusyRef.current) return;
    libraryMutationBusyRef.current = true;
    setLibraryMutationBusy(true);
    try {
      const result = await persistLibraryDeletion({
        buildPlan: (currentData) => ({
          nextData: deleteFolder(currentData, folderId),
          problemSetIds: currentData.problemSets
            .filter((set) => folderSubtreeIds(currentData.folders, folderId).has(set.folderId))
            .map((set) => set.id),
        }),
      });
      if (!applyLibraryDeletionResult(result, 'フォルダ')) return;
      goBackTo({ name: 'home' });
    } finally {
      libraryMutationBusyRef.current = false;
      setLibraryMutationBusy(false);
    }
  };

  const handleDeleteProblemSet = async (setId: string) => {
    if (libraryMutationBusyRef.current) return;
    libraryMutationBusyRef.current = true;
    setLibraryMutationBusy(true);
    try {
      const result = await persistLibraryDeletion({
        buildPlan: (currentData) => ({
          nextData: deleteProblemSet(currentData, setId),
          problemSetIds: [setId],
        }),
      });
      applyLibraryDeletionResult(result, '問題セット');
    } finally {
      libraryMutationBusyRef.current = false;
      setLibraryMutationBusy(false);
    }
  };

  const applyLibraryDeletionResult = (
    result: LibraryDeletionResult,
    targetLabel: 'フォルダ' | '問題セット' | '全データ',
  ): boolean => {
    if (!result.ok) {
      if (result.reason === 'notes-delete-failed') {
        setStorageError(`ノートを削除できなかったため、${targetLabel}の削除を取り消しました。もう一度お試しください。`);
      } else if (result.reason === 'rollback-failed') {
        setStorageError(`ノートの削除と${targetLabel}の復元に失敗しました。復旧用バックアップを書き出してから再読み込みしてください。`);
      } else if (result.reason === 'coordination-failed') {
        setStorageError('別のタブでデータが変更されたため、削除を中止しました。再読み込みしてからもう一度お試しください。');
      } else {
        setStorageError('端末へ保存できなかったため、削除を中止しました。空き容量や保存設定を確認してください。');
      }
      return false;
    }

    dataRevisionRef.current += 1;
    dataRef.current = result.data;
    durableDataRef.current = result.data;
    setData(result.data);
    setStorageError('');
    return true;
  };

  const handleImportProblemSet = async (
    folderId: string,
    newFolderName: string,
    titleOverride: string,
    jsonText: string,
    stayOnScreen = false,
  ): Promise<string | null> => {
    const validation = validateImportJson(jsonText);
    if (!validation.ok) {
      return validation.errors.join('\n');
    }

    const timestamp = nowIso();
    const setId = createId('set');
    const titleCandidate = titleOverride.trim() || validation.value.setTitle.trim() || '無題の問題セット';

    const questions: Question[] = validation.value.questions.map((question) => ({
      id: createId('q'),
      setId,
      question: question.question,
      choices: question.choices,
      distractors: question.distractors,
      shuffleChoices: question.shuffleChoices,
      answerIndex: question.answerIndex ?? question.answerIndexes?.[0] ?? 0,
      answerIndexes: question.answerIndexes,
      answerText: question.answerText ?? (question.answerIndexes ?? [question.answerIndex ?? 0])
        .map((index) => question.choices[index])
        .filter(Boolean)
        .join(' / '),
      explanation: question.explanation,
      detailedExplanation: question.detailedExplanation ?? '',
      sourcePage: question.sourcePage ?? '',
      category: question.category ?? '',
      difficulty: question.difficulty ?? 'basic',
      createdAt: timestamp,
      updatedAt: timestamp,
    }));

    const current = dataRef.current;
    const existingFolder = current.folders.find((folder) => folder.id === folderId);
    const requestedFolderName = newFolderName.trim();
    if (!existingFolder && !requestedFolderName) {
      return '保存先フォルダが見つかりません。作成画面へ戻って保存先を選び直してください。';
    }
    const nextFolders = existingFolder
      ? current.folders
      : [{ id: folderId, name: requestedFolderName, createdAt: timestamp, updatedAt: timestamp }, ...current.folders];
    const problemSet: ProblemSet = {
      id: setId,
      folderId,
      title: makeUniqueProblemSetTitle(current, folderId, titleCandidate),
      source: validation.value.source ?? '',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const saved = await persistThenCommitData({
      ...current,
      folders: nextFolders,
      problemSets: [problemSet, ...current.problemSets],
      questions: [...questions, ...current.questions],
      progress: [...current.progress, ...questions.map((question) => ({
        questionId: question.id,
        answeredCount: 0,
        correctCount: 0,
        wrongCount: 0,
        lastSelectedIndex: null,
        lastAnswerCorrect: null,
        lastAnsweredAt: null,
        isReview: false,
        isAmbiguous: false,
        reviewLevel: null,
        isGraduated: false,
      }))],
    });
    if (!saved) {
      return '問題セットを端末へ保存できませんでした。入力内容を残したまま、空き容量やブラウザの保存設定を確認してください。';
    }
    if (!stayOnScreen) {
      replaceScreen({ name: 'folder', folderId });
    }
    return null;
  };

  const handleAnswer = (question: Question, selectedIndexes: number[], isReviewMode: boolean) => {
    const answerLogId = createId('log');
    const answerResult = recordAnswer(dataRef.current, question, selectedIndexes, isReviewMode, answerLogId);
    const savePromise = commitData(answerResult.data);
    const levelLabel = answerResult.progress.isGraduated ? '卒業' : `Level ${answerResult.progress.reviewLevel ?? 1}`;
    return {
      isCorrect: answerResult.isCorrect,
      addedToReview: answerResult.addedToReview,
      levelLabel,
      savePromise,
      retrySave: () => commitData(recordAnswer(dataRef.current, question, selectedIndexes, isReviewMode, answerLogId).data),
    };
  };

  const handlePreviewAnswer = (question: Question, selectedIndexes: number[]) => {
    const expected = [...getAnswerIndexes(question)].sort((a, b) => a - b);
    const selected = [...new Set(selectedIndexes)].sort((a, b) => a - b);
    const isCorrect = expected.length === selected.length && expected.every((value, index) => value === selected[index]);
    return {
      isCorrect,
      addedToReview: false,
      levelLabel: 'お試し',
      saveStatusLabel: 'お試しのため学習履歴には記録しません',
      savePromise: Promise.resolve(true),
    };
  };

  const handleCreateProblemSet = async (submission: CreateProblemSetSubmission): Promise<string | null> => {
    const timestamp = nowIso();
    const current = dataRef.current;
    let folderId = submission.folderId;
    let folders = current.folders;
    if (!folderId) {
      folderId = createId('folder');
      const folder: Folder = {
        id: folderId,
        name: submission.newFolderName.trim() || 'マイ問題セット',
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      folders = [folder, ...folders];
    } else {
      folders = folders.map((folder) => folder.id === folderId ? { ...folder, updatedAt: timestamp } : folder);
    }

    const setId = createId('set');
    const questions: Question[] = submission.questions.map((question) => {
      const choices = question.choices.map((choice) => choice.trim()) as Question['choices'];
      const answerIndexes = getDraftAnswerIndexes({ ...question, choices });
      return {
        id: createId('q'),
        setId,
        question: question.question.trim(),
        choices,
        distractors: question.distractors,
        shuffleChoices: question.shuffleChoices,
        answerIndex: answerIndexes[0] ?? 0,
        answerIndexes: answerIndexes.length > 1 ? answerIndexes : undefined,
        answerText: answerIndexes.map((answerIndex) => choices[answerIndex]).filter(Boolean).join(' / '),
        explanation: question.explanation.trim(),
        detailedExplanation: question.detailedExplanation?.trim() ?? '',
        detailedAnswer: question.detailedAnswer,
        questionImageIds: question.questionImageIds,
        sourcePage: question.sourcePage.trim(),
        category: question.category.trim() || '未分類',
        difficulty: question.difficulty ?? submission.difficulty,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
    });
    const problemSet: ProblemSet = {
      id: setId,
      folderId,
      title: makeUniqueProblemSetTitle(current, folderId, submission.title),
      source: submission.source.trim(),
      description: submission.description.trim(),
      subject: submission.subject.trim(),
      audience: submission.audience.trim(),
      difficulty: submission.difficulty,
      creationMethod: submission.creationMethod,
      visibility: 'private',
      sourceSetId: submission.sourceSetId,
      copiedAt: submission.sourceSetId ? timestamp : undefined,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const saved = await persistThenCommitData({
      ...current,
      folders,
      problemSets: [problemSet, ...current.problemSets],
      questions: [...questions, ...current.questions],
      progress: [...current.progress, ...questions.map((question) => ({
        questionId: question.id,
        answeredCount: 0,
        correctCount: 0,
        wrongCount: 0,
        lastSelectedIndex: null,
        lastAnswerCorrect: null,
        lastAnsweredAt: null,
        isReview: false,
        isAmbiguous: false,
        reviewLevel: null,
        isGraduated: false,
      }))],
    });
    if (!saved) return '問題セットを端末へ保存できませんでした。空き容量や保存設定を確認してください。';
    if (screenRef.current.name === 'createProblemSet') {
      setCreateDraftDirty(false);
      replaceScreen({ name: 'problemSetDetail', setId });
    }
    return null;
  };

  const handleUpdateProblemSet = async (setId: string, submission: CreateProblemSetSubmission): Promise<string | null> => {
    const timestamp = nowIso();
    const current = dataRef.current;
    const existingSet = current.problemSets.find((problemSet) => problemSet.id === setId);
    if (!existingSet) return '編集する問題セットが見つかりません。';

    let folderId = submission.folderId;
    let folders = current.folders;
    if (!folderId) {
      folderId = createId('folder');
      folders = [{
        id: folderId,
        name: submission.newFolderName.trim() || 'マイ問題セット',
        createdAt: timestamp,
        updatedAt: timestamp,
      }, ...folders];
    } else {
      folders = folders.map((folder) => folder.id === folderId ? { ...folder, updatedAt: timestamp } : folder);
    }

    const previousQuestions = current.questions.filter((question) => question.setId === setId);
    const previousById = new Map(previousQuestions.map((question) => [question.id, question]));
    const resetProgressIds = new Set<string>();
    const nextQuestions: Question[] = submission.questions.map((draft) => {
      const previous = previousById.get(draft.id);
      const choices = draft.choices.map((choice) => choice.trim()) as Question['choices'];
      const answerIndexes = getDraftAnswerIndexes({ ...draft, choices });
      const id = previous?.id ?? createId('q');
      const nextQuestion: Question = {
        id,
        setId,
        question: draft.question.trim(),
        choices,
        distractors: draft.distractors,
        shuffleChoices: draft.shuffleChoices,
        answerIndex: answerIndexes[0] ?? 0,
        answerIndexes: answerIndexes.length > 1 ? answerIndexes : undefined,
        answerText: answerIndexes.map((answerIndex) => choices[answerIndex]).filter(Boolean).join(' / '),
        explanation: draft.explanation.trim(),
        detailedExplanation: draft.detailedExplanation?.trim() ?? '',
        detailedAnswer: draft.detailedAnswer ? { ...draft.detailedAnswer, body: draft.detailedExplanation?.trim() ?? draft.detailedAnswer.body } : previous?.detailedAnswer,
        questionImageIds: draft.questionImageIds ?? previous?.questionImageIds,
        sourcePage: draft.sourcePage.trim(),
        category: draft.category.trim() || '未分類',
        difficulty: draft.difficulty ?? submission.difficulty,
        createdAt: previous?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };
      if (!previous || hasQuestionLearningContentChanged(previous, nextQuestion)) resetProgressIds.add(id);
      return nextQuestion;
    });

    const nextQuestionIds = new Set(nextQuestions.map((question) => question.id));
    const removedQuestionIds = new Set(previousQuestions.filter((question) => !nextQuestionIds.has(question.id)).map((question) => question.id));
    const clearedQuestionIds = new Set([...resetProgressIds, ...removedQuestionIds]);
    const saved = await persistThenCommitData({
      ...current,
      folders,
      problemSets: current.problemSets.map((problemSet) => problemSet.id === setId ? {
        ...problemSet,
        folderId,
        title: makeUniqueProblemSetTitle(current, folderId, submission.title, setId),
        source: submission.source.trim(),
        description: submission.description.trim(),
        subject: submission.subject.trim(),
        audience: submission.audience.trim(),
        difficulty: submission.difficulty,
        creationMethod: problemSet.creationMethod ?? submission.creationMethod,
        updatedAt: timestamp,
      } : problemSet),
      questions: [...current.questions.filter((question) => question.setId !== setId), ...nextQuestions],
      progress: [
        ...current.progress.filter((progress) => !clearedQuestionIds.has(progress.questionId)),
        ...nextQuestions.filter((question) => resetProgressIds.has(question.id)).map((question) => ({
          questionId: question.id,
          answeredCount: 0,
          correctCount: 0,
          wrongCount: 0,
          lastSelectedIndex: null,
          lastAnswerCorrect: null,
          lastAnsweredAt: null,
          isReview: false,
          isAmbiguous: false,
          reviewLevel: null,
          isGraduated: false,
        })),
      ],
      answerLogs: current.answerLogs.filter((log) => !clearedQuestionIds.has(log.questionId)),
    });
    if (!saved) return '変更を端末へ保存できませんでした。入力内容を残したまま、空き容量や保存設定を確認してください。';
    if (screenRef.current.name === 'createProblemSet' && screenRef.current.editSetId === setId) {
      setCreateDraftDirty(false);
      replaceScreen({ name: 'problemSetDetail', setId });
    }
    return null;
  };

  const handleCopySharedProblemSet = async (sharedSet: CloudProblemSet, targetFolderId: string): Promise<string | null> => {
    const importedQuestions = sharedSet.questions ?? [];
    if (importedQuestions.length === 0) {
      setStorageError('追加できる問題がありません。');
      return null;
    }
    if (importedQuestions.some((question) => question.choices.length < 4 || question.choices.length > 5 || question.answerIndexes.length === 0)) {
      setStorageError('共有された問題セットの形式を確認できませんでした。');
      return null;
    }

    const timestamp = nowIso();
    const current = dataRef.current;
    if (!current.folders.some((folder) => folder.id === targetFolderId)) {
      setStorageError('取り込み先のフォルダが見つかりません。選び直してください。');
      return null;
    }
    const folders = current.folders.map((folder) => folder.id === targetFolderId ? { ...folder, updatedAt: timestamp } : folder);
    const setId = createId('set');
    const problemSet: ProblemSet = {
      id: setId,
      folderId: targetFolderId,
      title: makeUniqueProblemSetTitle(current, targetFolderId, sharedSet.title),
      source: sharedSet.source,
      description: sharedSet.description,
      subject: sharedSet.subject,
      audience: sharedSet.audience,
      difficulty: sharedSet.difficulty,
      creationMethod: 'public-copy',
      visibility: 'private',
      sourceSetId: sharedSet.id,
      sourceOwnerId: sharedSet.ownerId,
      sourceOwnerName: sharedSet.authorName,
      copiedAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const questions: Question[] = importedQuestions.map((question) => {
      const answerIndexes = [...new Set(question.answerIndexes)].filter((index) => index >= 0 && index < question.choices.length);
      return {
        id: createId('q'),
        setId,
        question: question.question,
        choices: question.choices.slice(0, 5) as Question['choices'],
        distractors: question.distractors ? [...question.distractors] : undefined,
        shuffleChoices: question.shuffleChoices,
        answerIndex: answerIndexes[0] ?? 0,
        answerIndexes,
        answerText: question.answerText || answerIndexes.map((index) => question.choices[index]).filter(Boolean).join(' / '),
        explanation: question.explanation,
        detailedExplanation: question.detailedExplanation,
        sourcePage: question.sourcePage,
        category: question.category || '未分類',
        difficulty: question.difficulty,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
    });
    const saved = await persistThenCommitData({
      ...current,
      folders,
      problemSets: [problemSet, ...current.problemSets],
      questions: [...questions, ...current.questions],
      progress: [...current.progress, ...questions.map((question) => ({
        questionId: question.id,
        answeredCount: 0,
        correctCount: 0,
        wrongCount: 0,
        lastSelectedIndex: null,
        lastAnswerCorrect: null,
        lastAnsweredAt: null,
        isReview: false,
        isAmbiguous: false,
        reviewLevel: null,
        isGraduated: false,
      }))],
    });
    return saved ? setId : null;
  };

  const handlePracticeSharedProblemSet = (sharedSet: CloudProblemSet): void => {
    const timestamp = nowIso();
    const questions: Question[] = (sharedSet.questions ?? []).map((question, index) => {
      const answerIndexes = [...new Set(question.answerIndexes)].filter((answerIndex) => answerIndex >= 0 && answerIndex < question.choices.length);
      return {
        id: `preview_${sharedSet.id}_${index}`,
        setId: `preview_${sharedSet.id}`,
        question: question.question,
        choices: question.choices.slice(0, 5) as Question['choices'],
        distractors: question.distractors ? [...question.distractors] : undefined,
        shuffleChoices: question.shuffleChoices,
        answerIndex: answerIndexes[0] ?? 0,
        answerIndexes,
        answerText: question.answerText,
        explanation: question.explanation,
        detailedExplanation: question.detailedExplanation,
        sourcePage: question.sourcePage,
        category: question.category || '未分類',
        difficulty: question.difficulty,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
    });
    if (questions.length === 0) {
      setStorageError('お試しできる問題がありません。');
      return;
    }
    const currentScreen = screenRef.current;
    const backScreen: AppScreen = currentScreen.name === 'community' && currentScreen.groupId
      ? {
          name: 'community',
          tab: 'groups',
          groupId: currentScreen.groupId,
          shareSetId: sharedSet.id,
        }
      : {
          name: 'community',
          tab: 'discover',
          shareSetId: sharedSet.id,
          ...(currentScreen.name === 'community' && currentScreen.shareToken
            ? { shareToken: currentScreen.shareToken }
            : {}),
        };
    if (currentScreen.name === 'community') replaceScreen(backScreen);
    navigate({
      name: 'quizSession',
      session: {
        title: sharedSet.title,
        subtitle: '公開問題セットのお試し',
        questions,
        mode: 'quiz',
        backScreen,
        isPreview: true,
      },
    });
  };

  const handlePublishedProblemSet = async (localSetId: string, result: CloudPublishResult): Promise<void> => {
    const current = dataRef.current;
    const saved = await persistThenCommitData({
      ...current,
      problemSets: current.problemSets.map((set) => set.id === localSetId ? {
        ...set,
        cloudSetId: result.id,
        visibility: result.visibility,
        updatedAt: nowIso(),
      } : set),
    });
    if (!saved) throw new Error('共有状態を端末に保存できませんでした。');
  };

  const handleUnpublishedProblemSet = async (localSetId: string): Promise<void> => {
    const current = dataRef.current;
    const saved = await persistThenCommitData({
      ...current,
      problemSets: current.problemSets.map((set) => set.id === localSetId ? {
        ...set,
        cloudSetId: undefined,
        visibility: 'private',
        updatedAt: nowIso(),
      } : set),
    });
    if (!saved) throw new Error('共有停止の状態を端末に保存できませんでした。');
  };

  const handleOpenLegacyImport = (target: LegacyImportTarget) => {
    const existingFolder = dataRef.current.folders.some((folder) => folder.id === target.folderId);
    const folderId = existingFolder ? target.folderId : createId('folder');
    navigate({
      name: 'import',
      folderId,
      ...(existingFolder ? {} : { newFolderName: target.newFolderName.trim() || 'マイ問題セット' }),
      backScreen: screenRef.current,
    });
  };

  const handleToggleAmbiguous = async (questionId: string) => {
    return persistThenCommitData(toggleAmbiguous(dataRef.current, questionId));
  };

  const handleSaveDetailedExplanation = async (questionId: string, detailedExplanation: string): Promise<void> => {
    const nextData = updateQuestionDetailedExplanation(dataRef.current, questionId, detailedExplanation);
    const saved = await persistThenCommitData(nextData);
    if (!saved) {
      const message = '詳細解説を端末へ保存できませんでした。入力内容は残っているので、空き容量や保存設定を確認して再試行してください。';
      setStorageError(message);
      throw new Error(message);
    }
  };

  const handleClearAll = async (): Promise<boolean> => {
    if (libraryMutationBusyRef.current) return false;
    libraryMutationBusyRef.current = true;
    setLibraryMutationBusy(true);
    try {
      const autoSyncWasEnabled = getAutoSyncSettings().enabled;
      const autoDisableResult = setAutoSyncEnabled(false);
      if (!autoDisableResult.ok) {
        setStorageError(`自動同期を停止できないため、全データ削除を中止しました。${autoDisableResult.error}`);
        return false;
      }
      const result = await persistLibraryDeletion({
        buildPlan: (currentData) => ({
          nextData: createEmptyAppData(),
          problemSetIds: currentData.problemSets.map((set) => set.id),
        }),
        deleteAllNotes: true,
      });
      if (!result.ok) {
        applyLibraryDeletionResult(result, '全データ');
        if (autoSyncWasEnabled && result.reason !== 'rollback-failed') {
          const autoRestoreResult = setAutoSyncEnabled(true);
          if (!autoRestoreResult.ok) {
            setStorageError(`データ削除を取り消しましたが、自動同期はOFFのままです。同期設定で再度ONにしてください。${autoRestoreResult.error}`);
          }
        } else if (autoSyncWasEnabled) {
          setStorageError('データを完全には復元できなかったため、自動同期は安全のためOFFのままです。復旧用バックアップを書き出してから再読み込みしてください。');
        }
        return false;
      }
      applyLibraryDeletionResult(result, '全データ');
      if (!establishCurrentAppDataAuthority()) {
        setStorageError('データは削除しましたが、端末の復旧状態を更新できませんでした。再読み込みしてからもう一度お試しください。');
      }
      replaceScreen({ name: 'home' });
      return true;
    } finally {
      libraryMutationBusyRef.current = false;
      setLibraryMutationBusy(false);
    }
  };

  const handleExport = async () => {
    try {
      setBackupImportError('');
      setBackupExportNotice('');
      const payload = await exportQuizMakeRecoveryData();
      await saveJsonBackup(`quiz-make-backup-${formatBackupDate()}.json`, JSON.stringify(payload, null, 2));
      setBackupExportNotice('バックアップを書き出しました。');
    } catch (error) {
      setBackupImportError(error instanceof Error ? `バックアップの作成に失敗しました: ${error.message}` : 'バックアップの作成に失敗しました。');
    }
  };

  const handleApplyUpdate = async () => {
    const initialProtectedWorkReason = getSyncProtectedWorkReason(
      screenRef.current,
      createDraftDirtyRef.current,
      pendingBackupImport !== null || backupImportBusy,
    );
    if (initialProtectedWorkReason) {
      setStorageError(getUpdateBlockedMessage(initialProtectedWorkReason));
      return;
    }
    try {
      const [appDataSaved] = await Promise.all([
        waitForPendingAppDataSaves(),
        waitForPendingCategoryNoteSaves(),
      ]);
      if (!appDataSaved) {
        setStorageError('未保存の変更があるため更新を中止しました。端末の空き容量や保存設定を確認してから、もう一度お試しください。');
        return;
      }
    } catch {
      setStorageError('未保存のノートがあるため更新を中止しました。端末の空き容量や保存設定を確認してから、もう一度お試しください。');
      return;
    }
    const latestProtectedWorkReason = getSyncProtectedWorkReason(
      screenRef.current,
      createDraftDirtyRef.current,
      pendingBackupImport !== null || backupImportBusy,
    );
    if (latestProtectedWorkReason) {
      setStorageError(getUpdateBlockedMessage(latestProtectedWorkReason));
      return;
    }
    if (waitingWorker?.state === 'activated') {
      window.location.reload();
      return;
    }
    waitingWorker?.postMessage({ type: 'SKIP_WAITING' });
  };

  const handleImportBackup = async (file: File): Promise<string | null> => {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as unknown;
      const syncValidation = validateSyncPayload(parsed);
      if (syncValidation.ok) {
        setBackupImportError('');
        setPendingBackupImport({ kind: 'sync', payload: syncValidation.value, summary: summarizeSyncPayload(syncValidation.value) });
        return null;
      }

      const result = parseBackupJson(text);
      if (!result.ok) return result.error;
      setBackupImportError('');
      setPendingBackupImport({ kind: 'legacy', data: result.data });
      return null;
    } catch (error) {
      return error instanceof Error ? `読み込みに失敗しました: ${error.message}` : '読み込みに失敗しました。';
    }
  };

  const cancelImportBackup = () => {
    if (backupImportBusy) return;
    setPendingBackupImport(null);
  };

  const confirmImportBackup = async () => {
    const target = pendingBackupImport;
    if (!target || backupImportBusy) return;
    setBackupImportBusy(true);
    setBackupImportError('');

    if (target.kind === 'legacy') {
      try { await saveBackupPayload(await exportQuizMakeRecoveryData(), 'before-import'); }
      catch { setBackupImportError('復元用バックアップを保存できないため、読み込みを中止しました。'); setBackupImportBusy(false); return; }
      const saved = await persistThenCommitData(target.data);
      if (!saved) {
        setBackupImportError('バックアップを端末へ保存できませんでした。現在の画面を閉じず、空き容量や保存設定を確認してください。');
        setBackupImportBusy(false);
        return;
      }
      if (!establishCurrentAppDataAuthority()) {
        setBackupImportError('問題データは読み込みましたが、端末の復旧状態を更新できませんでした。再読み込みしてから同じバックアップをもう一度読み込んでください。');
        setBackupImportBusy(false);
        return;
      }
      setPendingBackupImport(null);
      setBackupImportBusy(false);
      setStorageLoadError('');
      replaceScreen({ name: 'backupComplete', folderCount: target.data.folders.length, setCount: target.data.problemSets.length, questionCount: target.data.questions.length });
      return;
    }

    const result = await importQuizMakeData(target.payload);
    if (!result.ok) {
      setBackupImportError(result.error);
      setBackupImportBusy(false);
      return;
    }

    let loaded: AppData;
    try {
      loaded = await loadAppDataAsync();
    } catch (error) {
      setBackupImportError(error instanceof Error ? error.message : '読み込んだデータを端末から再確認できませんでした。');
      setBackupImportBusy(false);
      return;
    }
    dataRevisionRef.current += 1;
    dataRef.current = loaded;
    durableDataRef.current = loaded;
    setData(loaded);
    setPendingBackupImport(null);
    setBackupImportBusy(false);
    setStorageLoadError('');
    replaceScreen({ name: 'backupComplete', folderCount: loaded.folders.length, setCount: loaded.problemSets.length, questionCount: loaded.questions.length });
  };
  const handleStartQuizSession = (session: QuizSession) => {
    navigate({ name: 'quizSession', session });
  };

  const handleFinish = (result: QuizResult) => {
    const current = screenRef.current;
    let backScreen: AppScreen | undefined;
    if (current.name === 'quizSession') {
      backScreen = current.session.backScreen;
    } else if (current.name === 'quiz' && result.setId) {
      backScreen = { name: 'problemSetDetail', setId: result.setId };
    }

    const returnScreen = backScreen ?? (result.setId
      ? { name: 'problemSetDetail', setId: result.setId } as AppScreen
      : { name: 'home' } as AppScreen);
    let nextResult: QuizResult = {
      ...result,
      returnScreen,
      ...(result.retry ? { retry: { ...result.retry, backScreen: returnScreen } } : {}),
    };
    if (current.name === 'quizSession' && current.session.isPreview && nextResult.retry) {
      nextResult = {
        ...nextResult,
        retry: {
          ...nextResult.retry,
          previewQuestions: current.session.questions,
          isPreview: true,
        },
      };
    }
    navigate({ name: 'result', result: nextResult });
  };

  const handleRetry = (result: QuizResult) => {
    if (result.retry) {
      const questionsById = new Map(dataRef.current.questions.map((question) => [question.id, question]));
      const retryQuestions = result.retry.previewQuestions?.length
        ? result.retry.previewQuestions
        : result.retry.questionIds
            .map((questionId) => questionsById.get(questionId))
            .filter((question): question is Question => Boolean(question));
      if (retryQuestions.length > 0) {
        navigate({
          name: 'quizSession',
          session: {
            title: result.title,
            subtitle: result.retry.subtitle,
            questions: retryQuestions,
            mode: result.mode,
            setId: result.setId,
            initialIndex: 0,
            backScreen: result.retry.backScreen ?? { name: 'home' },
            isPreview: result.retry.isPreview,
          },
        });
        return;
      }
    }

    if (result.mode === 'review' && result.setId) {
      goBackTo({ name: 'problemSetDetail', setId: result.setId });
      return;
    }
    if (result.setId) {
      navigate({ name: 'quiz', setId: result.setId, mode: 'ordered' });
      return;
    }
    goBackTo({ name: 'home' });
  };

  if (!storageReady) {
    return (
      <div style={{ minHeight: '100dvh', display: 'grid', placeItems: 'center', background: '#f1f7fa', color: '#173042', fontWeight: 800 }}>
        読み込み中...
      </div>
    );
  }

  if (storageLoadError) {
    if (storageRecoverySyncOpen) {
      return (
        <Suspense fallback={<div className="quiz-app-loading">同期設定を読み込み中...</div>}>
          <SyncScreen onBack={() => setStorageRecoverySyncOpen(false)} />
        </Suspense>
      );
    }
    return (
      <>
        <StorageRecoveryPanel
          error={storageLoadError}
          actionError={backupImportError}
          notice={backupExportNotice}
          busy={backupImportBusy}
          onRetry={() => {
            setStorageRecoverySyncOpen(false);
            setStorageLoadAttempt((attempt) => attempt + 1);
          }}
          onExport={handleExport}
          onImportFile={handleImportBackup}
          onOpenSync={() => setStorageRecoverySyncOpen(true)}
        />
        <ConfirmDialog
          open={pendingBackupImport !== null}
          title="バックアップを読み込みますか？"
          message={pendingBackupImport ? getBackupImportMessage(pendingBackupImport) : ''}
          confirmLabel={backupImportBusy ? '読み込み中…' : '読み込む'}
          busy={backupImportBusy}
          onCancel={cancelImportBackup}
          onConfirm={() => void confirmImportBackup()}
        />
      </>
    );
  }

  let content;

  if (screen.name === 'createProblemSet') {
    const createBackScreen = getCreateProblemSetBackScreen(screen);
    content = (
      <Suspense fallback={<div className="quiz-app-loading">作成画面を読み込み中...</div>}>
        <CreateProblemSetScreen
          startWithAi={Boolean(createBackScreen) && !screen.editSetId && !screen.copySetId}
          data={data}
          onSaveDetail={handleSaveDetailedExplanation}
          onApplyExplanations={async batch => {
            const next = applyQuestionExplanations(dataRef.current, batch);
            if (batch.replies.some(r => r.targetId.startsWith('question:')) && !await persistThenCommitData(next)) throw new Error('解説を保存できませんでした。回答を残しています。');
          }}
          onSave={(submission) => screen.editSetId
            ? handleUpdateProblemSet(screen.editSetId, submission)
            : handleCreateProblemSet(submission)}
          onOpenLegacyImport={handleOpenLegacyImport}
          onDirtyChange={setCreateDraftDirty}
          initialFolderId={screen.folderId}
          editSetId={screen.editSetId}
          copySetId={screen.copySetId}
          onBack={createBackScreen ? () => goBackTo(createBackScreen) : undefined}
        />
      </Suspense>
    );
  } else if (screen.name === 'backupComplete') {
    content = <BackupCompleteScreen {...screen} onHome={goHome} />;
  } else if (screen.name === 'questionDetail') {
    content = <QuestionDetailScreen data={data} questionId={screen.questionId} onBack={() => goBackTo(screen.backScreen)}
      onEdit={() => navigate({ name: 'questionEdit', questionId: screen.questionId, backScreen: screen })}
      onDetail={(editing) => navigate({ name: 'detailedAnswer', questionId: screen.questionId, editing, backScreen: screen })}
      onNote={(setId, category) => navigate({ name: 'noteDetail', setId, category, backScreen: screen })} />;
  } else if (screen.name === 'questionEdit' || screen.name === 'detailedAnswer') {
    const question = data.questions.find((item) => item.id === screen.questionId);
    const finishEdit = () => {
      if (getScreenKey(screenRef.current) !== getScreenKey(screen)) return;
      setCreateDraftDirty(false); createDraftDirtyRef.current = false;
      confirmedProtectedExitRef.current = true;
      performBackNavigation(screen.backScreen);
    };
    content = !question ? <div className="library-page"><button onClick={() => goBackTo(screen.backScreen)}>戻る</button><p>問題が見つかりません</p></div> : screen.name === 'questionEdit' ?
      <QuestionEditScreen question={question} onBack={() => goBackTo(screen.backScreen)} onDirtyChange={setCreateDraftDirty} onSave={async (draft, original) => {
        const current = dataRef.current;
        const latest = current.questions.find((item) => item.id === original.id);
        if (!latest || JSON.stringify(latest) !== JSON.stringify(original)) return '問題が別の操作で更新されました。入力内容を控えて開き直してください。';
        const choices = draft.choices.map((choice) => choice.trim()) as Question['choices'];
        const answers = getAnswerIndexes(draft);
        if (!draft.question.trim() || choices.some((choice) => !choice) || !answers.length) return '問題文、選択肢、正解を確認してください。';
        const next = { ...latest, question: draft.question.trim(), choices, answerIndex: answers[0], answerIndexes: answers.length > 1 ? answers : undefined, answerText: answers.map((index) => choices[index]).join(' / '), explanation: draft.explanation, category: draft.category.trim() || '未分類', updatedAt: nowIso() };
        const reset = hasQuestionLearningContentChanged(latest, next);
        const saved = await persistThenCommitData({ ...current, questions: current.questions.map((item) => item.id === next.id ? next : item), progress: reset ? current.progress.filter((item) => item.questionId !== next.id) : current.progress, answerLogs: reset ? current.answerLogs.filter((item) => item.questionId !== next.id) : current.answerLogs });
        if (!saved) return '保存できませんでした。入力内容を残しています。';
        finishEdit(); return null;
      }} /> : <DetailedAnswerScreen question={question} editing={Boolean(screen.editing)} onBack={() => goBackTo(screen.backScreen)} onEdit={() => replaceScreen({ ...screen, editing: true })} onDirtyChange={setCreateDraftDirty} onSave={async (body, original) => {
        const latest = dataRef.current.questions.find((item) => item.id === original.id);
        if (!latest || JSON.stringify(latest) !== JSON.stringify(original)) return '問題が別の操作で更新されました。入力内容を控えて開き直してください。';
        await handleSaveDetailedExplanation(original.id, body);
        return null;
      }} />;
  } else if (screen.name === 'community' || screen.name === 'search') {
    const communityScreen: Extract<AppScreen, { name: 'community' }> = screen.name === 'search' ? { name: 'community', tab: 'discover' } : screen;
    const communityBackScreen = communityScreen.groupId || communityScreen.groupPage
      ? communityScreen.backScreen ?? { name: 'community' as const, tab: 'groups' as const }
      : communityScreen.backScreen && communityScreen.backScreen.name !== 'community'
        ? communityScreen.backScreen
        : null;
    content = (
      <Suspense fallback={<div className="quiz-app-loading">共有機能を読み込み中...</div>}>
        <CommunityScreen
          groupPage={communityScreen.groupPage}
          onGroupPage={(groupPage) => navigate({ name: 'community', tab: 'groups', groupPage, backScreen: { name: 'community', tab: 'groups' } })}
          data={data}
          initialTab={communityScreen.tab}
          initialSetId={communityScreen.shareSetId}
          initialGroupId={communityScreen.groupId}
          shareToken={communityScreen.shareToken}
          onBack={communityBackScreen ? () => goBackTo(communityBackScreen) : goHome}
          onCreateProblemSet={() => navigate({ name: 'createProblemSet', backScreen: screen })}
          onOpenGroup={(groupId) => navigate({ name: 'community', tab: 'groups', groupId, backScreen: { name: 'community', tab: 'groups' } })}
          onOpenLocalSet={(setId) => navigate({ name: 'problemSetDetail', setId })}
          onCopySharedSet={handleCopySharedProblemSet}
          onPracticeSharedSet={handlePracticeSharedProblemSet}
          onPublished={handlePublishedProblemSet}
          onUnpublished={handleUnpublishedProblemSet}
        />
      </Suspense>
    );
  } else if (screen.name === 'folder') {
    content = (
      <FolderScreen
        data={data}
        folderId={screen.folderId}
        onBack={goHome}
        onCreateProblemSet={(folderId) => navigate({ name: 'createProblemSet', folderId, backScreen: { name: 'folder', folderId } })}
        onOpenProblemSet={(setId) => navigate({ name: 'problemSetDetail', setId })}
        onDeleteProblemSet={handleDeleteProblemSet}
        onSave={commitData}
        onDeleteFolder={handleDeleteFolder}
      />
    );
  } else if (screen.name === 'problemSetDetail') {
    const problemSet = data.problemSets.find((set) => set.id === screen.setId);
    const parentFolderExists = Boolean(problemSet && data.folders.some((folder) => folder.id === problemSet.folderId));
    content = (
      <ProblemSetDetailScreen
        data={data}
        setId={screen.setId}
        onBack={problemSet && parentFolderExists
          ? () => goBackTo({ name: 'folder', folderId: problemSet.folderId })
          : goHome}
        onEdit={() => navigate({
          name: 'createProblemSet',
          folderId: problemSet?.folderId,
          editSetId: screen.setId,
          backScreen: { name: 'problemSetDetail', setId: screen.setId },
        })}
        onOpenProblemList={() => navigate({ name: 'problemList', setId: screen.setId })}
        onCopy={() => navigate({ name: 'createProblemSet', copySetId: screen.setId, backScreen: { name: 'problemSetDetail', setId: screen.setId } })}
        onOpenNoteList={() => navigate({ name: 'noteList', setId: screen.setId })}
        onShare={() => navigate({
          name: 'community',
          tab: 'mine',
          shareSetId: screen.setId,
          backScreen: { name: 'problemSetDetail', setId: screen.setId },
        })}
        onStartSession={({ questions, mode, initialIndex, title, subtitle, setId }) => handleStartQuizSession({
          title,
          subtitle,
          questions,
          mode,
          setId,
          initialIndex,
          backScreen: { name: 'problemSetDetail', setId },
        })}
      />
    );
  } else if (screen.name === 'problemList') {
    const problemSet = data.problemSets.find((set) => set.id === screen.setId);
    content = (
      <ProblemListScreen
        data={data}
        setId={screen.setId}
        initialSortMode={screen.sortMode}
        onBack={problemSet ? () => goBackTo({ name: 'problemSetDetail', setId: screen.setId }) : goHome}
        onOpenQuestion={(questionId, sortMode) => navigate({
          name: 'questionDetail',
          questionId,
          backScreen: { name: 'problemList', setId: screen.setId, sortMode },
        })}
        onStartFromQuestion={({ questions, initialIndex, title, subtitle, setId, sortMode }) => handleStartQuizSession({
          questions, initialIndex, title, subtitle, setId, mode: 'quiz',
          backScreen: { name: 'problemList', setId, sortMode },
        })}
      />
    );
  } else if (screen.name === 'noteList') {
    content = <NoteOverviewScreen data={data} setId={screen.setId}
      onOpenDetail={(questionId) => navigate({ name: 'detailedAnswer', questionId, backScreen: screen })}
      onBack={() => goBackTo({ name: 'problemSetDetail', setId: screen.setId })}
      onOpen={(category) => navigate({ name: 'noteDetail', setId: screen.setId, category })} />;
  } else if (screen.name === 'noteDetail') {
    const problemSet = data.problemSets.find((set) => set.id === screen.setId);
    content = (
      <NoteListScreen
        data={data}
        setId={screen.setId}
        initialCategory={screen.category}
        registerExitGuard={(guard) => { noteExitGuardRef.current = guard; }}
        onOpenQuestions={() => navigate({ name: 'problemList', setId: screen.setId })}
        onBack={problemSet ? () => goBackTo(screen.backScreen ?? { name: 'noteList', setId: screen.setId }) : goHome}
      />
    );
  } else if (screen.name === 'import') {
    const folder = data.folders.find((item) => item.id === screen.folderId);
    content = (
      <ImportScreen
        folderName={folder?.name ?? screen.newFolderName ?? '新しいフォルダ'}
        onBack={() => goBackTo(screen.backScreen ?? { name: 'folder', folderId: screen.folderId })}
        onImport={(titleOverride, jsonText, stayOnScreen) => handleImportProblemSet(
          screen.folderId,
          screen.newFolderName ?? '',
          titleOverride,
          jsonText,
          stayOnScreen,
        )}
        onImportComplete={() => replaceScreen({ name: 'folder', folderId: screen.folderId })}
      />
    );
  } else if (screen.name === 'quiz') {
    const problemSet = data.problemSets.find((set) => set.id === screen.setId);
    const parentFolderExists = Boolean(problemSet && data.folders.some((folder) => folder.id === problemSet.folderId));
    content = (
      <Suspense fallback={<div className="quiz-app-loading">演習画面を読み込み中...</div>}>
        <QuizScreen
          key={`${screen.setId}_${screen.mode}`}
          data={data}
          setId={screen.setId}
          mode={screen.mode}
          onBack={problemSet && parentFolderExists
            ? () => goBackTo({ name: 'folder', folderId: problemSet.folderId })
            : goHome}
          onAnswer={handleAnswer}
          onToggleAmbiguous={handleToggleAmbiguous}
          onSaveDetailedExplanation={handleSaveDetailedExplanation}
          onFinish={handleFinish}
        />
      </Suspense>
    );
  } else if (screen.name === 'quizSession') {
    content = (
      <Suspense fallback={<div className="quiz-app-loading">演習画面を読み込み中...</div>}>
        <QuizRunner
          key={`${screen.session.setId ?? 'session'}_${screen.session.mode}_${screen.session.initialIndex ?? 0}_${screen.session.questions.map((question) => question.id).join('_')}`}
          data={data}
          title={screen.session.title}
          subtitle={screen.session.subtitle}
          questions={screen.session.questions}
          mode={screen.session.mode}
          setId={screen.session.setId}
          initialIndex={screen.session.initialIndex}
          readOnly={screen.session.isPreview === true}
          onBack={() => goBackTo(screen.session.backScreen)}
          onAnswer={screen.session.isPreview ? handlePreviewAnswer : handleAnswer}
          onToggleAmbiguous={screen.session.isPreview ? async () => true : handleToggleAmbiguous}
          onSaveDetailedExplanation={screen.session.isPreview ? async () => undefined : handleSaveDetailedExplanation}
          onFinish={handleFinish}
        />
      </Suspense>
    );
  } else if (screen.name === 'result') {
    const returnScreen = getResultReturnScreen(screen.result, data);
    content = (
      <ResultScreen
        result={screen.result}
        returnLabel={getResultReturnLabel(returnScreen)}
        onReturn={returnScreen.name === 'home' ? goHome : () => goBackTo(returnScreen)}
        onRetry={() => handleRetry(screen.result)}
        onRetryWrong={() => {
          const questions = (screen.result.sessionAnswers ?? []).filter((answer) => !answer.correct).map((answer) => answer.question);
          if (questions.length) navigate({ name: 'quizSession', session: { title: screen.result.title, questions, mode: screen.result.mode, setId: screen.result.setId, backScreen: returnScreen, isPreview: screen.result.retry?.isPreview } });
        }}
        onOpenAnswers={() => navigate({ name: 'sessionAnswers', result: screen.result })}
      />
    );
  } else if (screen.name === 'sessionAnswers') {
    content = <SessionAnswersScreen result={screen.result} onBack={() => goBackTo({ name: 'result', result: screen.result })} />;
  } else if (screen.name === 'settings') {
    content = screen.page === 'backups' ? <BackupScreen onBack={() => goBackTo({ name: 'settings' })} onRestore={handleImportBackup} /> : (
      <SettingsScreen
        page={screen.page}
        onNavigate={(page) => navigate({ name: 'settings', page })}
        onBack={() => goBackTo({ name: 'settings' })}
        onExport={handleExport}
        onImportBackup={handleImportBackup}
        onClearAll={handleClearAll}
        onOpenSync={() => navigate({ name: 'sync' })}
        onOpenPrivacy={() => navigate({ name: 'privacy' })}
      />
    );
  } else if (screen.name === 'sync') {
    content = <SyncScreen onBack={() => goBackTo({ name: 'settings' })} />;
  } else if (screen.name === 'privacy') {
    content = <PrivacyScreen onBack={() => goBackTo({ name: 'settings' })} />;
  } else {
    content = (
    <HomeScreen
      data={data}
      onCreateFolder={handleCreateFolder}
      onCreateSample={() => void commitData(createSampleAppData())}
      onDeleteFolder={handleDeleteFolder}
      onOpenFolder={(folderId) => navigate({ name: 'folder', folderId })}
      onSave={commitData}
    />
  );
  }

  return (
    <>
      <AutoSyncController protectedWorkReason={protectedWorkReason} />
      <SharedImageReceiver data={data} onClose={()=>setReceivingSharedImage(false)} onOpenQuestion={questionId=>navigate({name:'detailedAnswer',questionId,backScreen:screenRef.current})} onSave={async (questionId,originalQuestion,image,shareId)=>{
        const next=appendSharedImage(dataRef.current,questionId,originalQuestion,image,shareId);
        if(!await persistThenCommitData(next))throw new Error('画像を保存できませんでした。再読み込みして追加し直してください。');
      }}/>
      <WelcomeGuide active={screen.name === 'home' && !waitingWorker && !storageError && !receivingSharedImage} />
      <div key={getScreenKey(screen)} className={`quiz-screen-transition quiz-screen-transition--${transitionDirection}`}>
        <Suspense fallback={(
          <div className="quiz-app-loading" role="status" aria-live="polite">
            {getScreenLoadingMessage(screen)}
          </div>
        )}>
          {content}
        </Suspense>
      </div>
      {getPrimaryNavItem(screen) ? (
        <PrimaryBottomNav active={getPrimaryNavItem(screen)!} onSelect={navigatePrimary} />
      ) : null}
      <ConfirmDialog
        open={pendingBackupImport !== null}
        fullPage
        title={'バックアップを読み込みますか？'}
        message={pendingBackupImport ? getBackupImportMessage(pendingBackupImport) : ''}
        confirmLabel={backupImportBusy ? '読み込み中…' : 'バックアップして読み込む'}
        busy={backupImportBusy}
        onCancel={cancelImportBackup}
        onConfirm={() => void confirmImportBackup()}
      />
      <ConfirmDialog
        open={pendingExitTarget !== null}
        title={pendingExitReason === 'create' ? '作成途中の内容を破棄しますか？' : '演習を終了しますか？'}
        message={pendingExitReason === 'create'
          ? '入力した問題や貼り付け内容はまだ保存されていません。この画面を離れると破棄されます。'
          : '途中の演習を終了して前の画面へ戻ります。\n詳細解説に未保存の入力がある場合、その入力も破棄されます。'}
        confirmLabel={pendingExitReason === 'create' ? '破棄して移動' : '終了する'}
        onCancel={cancelProtectedExit}
        onConfirm={confirmProtectedExit}
      />
      {(backupImportError || backupExportNotice || authNotice || storageError || waitingWorker) ? (
        <div className="quiz-toast-stack">
          {backupImportError ? (
            <div className="quiz-update-toast" role="alert">
              <span>{backupImportError}</span>
              <button type="button" onClick={() => setBackupImportError('')}>閉じる</button>
            </div>
          ) : null}
          {backupExportNotice ? (
            <div className="quiz-update-toast" role="status" aria-live="polite">
              <span>{backupExportNotice}</span>
              <button type="button" onClick={() => setBackupExportNotice('')}>閉じる</button>
            </div>
          ) : null}
          {authNotice ? (
            <div className="quiz-update-toast" role="status" aria-live="polite">
              <span>{authNotice}</span>
              <button type="button" onClick={() => setAuthNotice('')}>閉じる</button>
            </div>
          ) : null}
          {storageError ? (
            <div className="quiz-update-toast" role="alert">
              <span>{storageError}</span>
              <button type="button" onClick={() => setStorageError('')}>閉じる</button>
            </div>
          ) : null}
          {waitingWorker ? (
            <div className="quiz-update-toast" role="status" aria-live="polite">
              <span>{protectedWorkReason ? getUpdateBlockedMessage(protectedWorkReason) : '新しいバージョンがあります'}</span>
              <button type="button" disabled={protectedWorkReason !== null} onClick={() => void handleApplyUpdate()}>更新する</button>
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

function getScreenLoadingMessage(screen: AppScreen) {
  if (screen.name === 'noteList' || screen.name === 'noteDetail') return 'ノートを読み込み中…';
  if (screen.name === 'import') return '問題の取り込み画面を読み込み中…';
  if (screen.name === 'settings') return '設定画面を読み込み中…';
  if (screen.name === 'sync') return '同期設定を読み込み中…';
  if (screen.name === 'privacy') return 'プライバシー情報を読み込み中…';
  return '画面を読み込み中…';
}

function getBackupImportMessage(target: PendingBackupImport) {
  if (target.kind === 'legacy') {
    return '旧形式のバックアップJSONを読み込みます。\n現在の問題データ、進捗、Levelは上書きされます。\nノートはこの旧形式には含まれていません。';
  }

  return `ノート込みのバックアップJSONを読み込みます。\n現在の問題データ、進捗、Level、ノートは上書きされます。\n\n内容: ${formatBackupImportSummary(target.summary)}`;
}

function formatBackupImportSummary(summary: SyncPayloadSummary) {
  return `フォルダ${summary.folderCount} / セット${summary.problemSetCount} / 問題${summary.questionCount} / 進捗${summary.progressCount} / ノート${summary.noteCount}`;
}

function isQuizInProgressScreen(screen: AppScreen) {
  return screen.name === 'quiz' || screen.name === 'quizSession';
}

function getProtectedExitReason(screen: AppScreen, createDraftDirty: boolean): 'quiz' | 'create' | null {
  if (isQuizInProgressScreen(screen)) return 'quiz';
  if ((screen.name === 'createProblemSet' || screen.name === 'questionEdit' || (screen.name === 'detailedAnswer' && screen.editing)) && createDraftDirty) return 'create';
  return null;
}

function getSyncProtectedWorkReason(
  screen: AppScreen,
  createDraftDirty: boolean,
  backupImportActive = false,
  libraryMutationActive = false,
) {
  if (libraryMutationActive) return 'library' as const;
  if (backupImportActive) return 'backup' as const;
  if (screen.name === 'import') return 'import' as const;
  if (screen.name === 'noteList' || screen.name === 'noteDetail') return 'notes' as const;
  if (screen.name === 'sync') return 'sync' as const;
  return getProtectedExitReason(screen, createDraftDirty);
}

function getUpdateBlockedMessage(reason: ProtectedWorkReason) {
  if (reason === 'library') return '新しいバージョンがあります。データの削除が終わってから更新できます。';
  if (reason === 'backup') return '新しいバージョンがあります。バックアップの読み込みを終えてから更新できます。';
  if (reason === 'import') return '新しいバージョンがあります。問題セットの取り込みを終えてから更新できます。';
  if (reason === 'notes') return '新しいバージョンがあります。ノートを閉じてから更新できます。';
  if (reason === 'sync') return '新しいバージョンがあります。同期設定を閉じてから更新できます。';
  return reason === 'create'
    ? '新しいバージョンがあります。作成中の内容を保存してから更新できます。'
    : '新しいバージョンがあります。演習を終了してから更新できます。';
}

function getPrimaryNavItem(screen: AppScreen): PrimaryNavItem | null {
  if (screen.name === 'search') return 'discover';
  if (screen.name === 'home') return 'home';
  if (screen.name === 'settings' && !screen.page) return 'settings';
  if (screen.name === 'createProblemSet') return 'create';
  if (screen.name === 'community' && !screen.groupPage && !screen.groupId && !screen.shareSetId && !screen.shareToken) {
    if (screen.tab === 'groups') return 'groups';
    if (screen.tab === 'discover') return 'discover';
  }

  return null;
}

function makeUniqueProblemSetTitle(data: AppData, folderId: string, rawTitle: string, excludeSetId?: string) {
  const baseTitle = rawTitle.trim() || '無題の問題セット';
  const existingTitles = new Set(
    data.problemSets
      .filter((set) => set.folderId === folderId && set.id !== excludeSetId)
      .map((set) => set.title.trim()),
  );

  if (!existingTitles.has(baseTitle)) return baseTitle;

  let count = 2;
  let nextTitle = `${baseTitle} (${count})`;
  while (existingTitles.has(nextTitle)) {
    count += 1;
    nextTitle = `${baseTitle} (${count})`;
  }
  return nextTitle;
}

function hasQuestionLearningContentChanged(previous: Question, next: Question): boolean {
  return previous.question.trim() !== next.question.trim()
    || JSON.stringify(previous.choices) !== JSON.stringify(next.choices)
    || JSON.stringify(previous.distractors ?? []) !== JSON.stringify(next.distractors ?? [])
    || JSON.stringify([...getAnswerIndexes(previous)].sort((left, right) => left - right))
      !== JSON.stringify([...getAnswerIndexes(next)].sort((left, right) => left - right));
}

