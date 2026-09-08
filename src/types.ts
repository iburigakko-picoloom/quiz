export type Difficulty = 'basic' | 'standard' | 'advanced' | string;

export type ProblemSetCreationMethod = 'manual' | 'bulk' | 'chatgpt' | 'copy' | 'import' | 'public-copy';
export type ProblemSetVisibility = 'private' | 'group' | 'link' | 'public';

export type ChoiceList =
  | [string, string, string, string]
  | [string, string, string, string, string];

export interface AppData {
  version: 1;
  folders: Folder[];
  problemSets: ProblemSet[];
  questions: Question[];
  progress: QuestionProgress[];
  answerLogs: AnswerLog[];
}

export interface Folder {
  id: string;
  parentFolderId?: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProblemSet {
  id: string;
  folderId: string;
  title: string;
  source: string;
  description?: string;
  subject?: string;
  audience?: string;
  difficulty?: Difficulty;
  creationMethod?: ProblemSetCreationMethod;
  visibility?: ProblemSetVisibility;
  sourceSetId?: string;
  sourceOwnerId?: string;
  sourceOwnerName?: string;
  cloudSetId?: string;
  copiedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DetailedAnswer {
  body: string;
  imageIds: string[];
  updatedAt: string;
}

export interface Question {
  distractors?: string[];
  shuffleChoices?: boolean;
  id: string;
  setId: string;
  question: string;
  choices: ChoiceList;
  answerIndex: number;
  answerIndexes?: number[];
  answerText: string;
  explanation: string;
  detailedExplanation?: string;
  detailedAnswer?: DetailedAnswer;
  questionImageIds?: string[];
  sourcePage: string;
  category: string;
  difficulty: Difficulty;
  createdAt: string;
  updatedAt: string;
}

export interface QuestionProgress {
  questionId: string;
  answeredCount: number;
  correctCount: number;
  wrongCount: number;
  lastSelectedIndex: number | null;
  lastAnswerCorrect?: boolean | null;
  lastAnsweredAt: string | null;
  isReview: boolean;
  isAmbiguous: boolean;
  reviewLevel: 1 | 2 | 3 | null;
  isGraduated: boolean;
}

export interface AnswerLog {
  presentedChoices?: string[];
  id: string;
  questionId: string;
  setId: string;
  folderId: string;
  selectedIndex: number;
  selectedIndexes?: number[];
  isCorrect: boolean;
  answeredAt: string;
}

export interface ImportedQuestion {
  distractors?: string[];
  shuffleChoices?: boolean;
  id?: string;
  question: string;
  choices: ChoiceList;
  answerIndex?: number;
  answerIndexes?: number[];
  answerText?: string;
  explanation: string;
  detailedExplanation?: string;
  sourcePage?: string;
  reference?: string;
  category?: string;
  difficulty?: Difficulty;
}

export interface ImportedProblemSet {
  setTitle: string;
  source?: string;
  questions: ImportedQuestion[];
}

export interface QuizResult {
  sessionAnswers?: { question: Question; selectedIndexes: number[]; correct: boolean; relearned: boolean }[];
  mode: 'quiz' | 'review';
  title: string;
  setId?: string;
  returnScreen?: AppScreen;
  retry?: {
    questionIds: string[];
    subtitle?: string;
    backScreen?: AppScreen;
    previewQuestions?: Question[];
    isPreview?: boolean;
  };
  answered: number;
  correct: number;
  wrong: number;
  addedReviewCount: number;
}

export interface StudyStats {
  todayCount: number;
  totalCount: number;
  correctRate: number;
  reviewCount: number;
  ambiguousCount: number;
}

export type QuizMode = 'ordered' | 'random';

export type ProblemSortMode = 'ordered' | 'level';

export interface QuizSession {
  title: string;
  subtitle?: string;
  questions: Question[];
  mode: 'quiz' | 'review';
  setId?: string;
  initialIndex?: number;
  backScreen: AppScreen;
  isPreview?: boolean;
}

export type AppScreen =
  | { name: 'home' }
  | { name: 'search' }
  | { name: 'backupComplete'; folderCount: number; setCount: number; questionCount: number }
  | { name: 'questionDetail'; questionId: string; backScreen: AppScreen }
  | { name: 'questionEdit'; questionId: string; backScreen: AppScreen }
  | { name: 'detailedAnswer'; questionId: string; backScreen: AppScreen; editing?: boolean }
  | { name: 'settings'; page?: 'account' | 'transfer' | 'backups' | 'logout' }
  | { name: 'community'; tab?: 'mine' | 'groups' | 'discover'; groupPage?: 'create' | 'join'; groupId?: string; shareSetId?: string; shareToken?: string; backScreen?: AppScreen }
  | { name: 'sync' }
  | { name: 'privacy' }
  | { name: 'createProblemSet'; folderId?: string; editSetId?: string; backScreen?: AppScreen }
  | { name: 'folder'; folderId: string }
  | { name: 'problemSetDetail'; setId: string }
  | { name: 'problemList'; setId: string; sortMode?: ProblemSortMode }
  | { name: 'noteList'; setId: string }
  | { name: 'sessionAnswers'; result: QuizResult }
  | { name: 'noteDetail'; setId: string; category: string; backScreen?: AppScreen }
  | { name: 'import'; folderId: string; newFolderName?: string; backScreen?: AppScreen }
  | { name: 'quiz'; setId: string; mode: QuizMode }
  | { name: 'quizSession'; session: QuizSession }
  | { name: 'result'; result: QuizResult };

