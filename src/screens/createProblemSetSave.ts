import type { BulkQuestionDraft } from '../utils/bulkQuestionParser';

export type PendingQuestionSaveDecision = 'include' | 'discard' | 'cancel';

export interface PendingManualQuestion {
  draft: BulkQuestionDraft;
  editingIndex: number | null;
  issues: string[];
}

export type PendingQuestionSaveResolution =
  | { status: 'cancel'; drafts: BulkQuestionDraft[] }
  | { status: 'invalid'; drafts: BulkQuestionDraft[]; issues: string[] }
  | { status: 'save'; drafts: BulkQuestionDraft[]; includedPendingQuestion: boolean };

export function normalizeEditableQuestionDraft(draft: BulkQuestionDraft): BulkQuestionDraft {
  const choices = [...draft.choices];
  while (choices.length < 4) choices.push('');
  return normalizeDraftAnswers({ ...draft, choices: choices.slice(0, 5), distractors: draft.distractors?.map((text) => text.trim()).filter(Boolean) });
}

export function normalizeDraftAnswers(draft: BulkQuestionDraft): BulkQuestionDraft {
  const answerIndexes = getNormalizedAnswerIndexes(draft);
  return { ...draft, answerIndex: answerIndexes[0] ?? null, answerIndexes };
}

export function hasDraftQuestionContent(draft: BulkQuestionDraft): boolean {
  return Boolean(
    draft.question.trim()
    || draft.choices.some((choice) => choice.trim())
    || getNormalizedAnswerIndexes(draft).length
    || draft.explanation.trim()
    || draft.detailedExplanation?.trim()
    || draft.category.trim()
    || draft.sourcePage.trim()
  );
}

export function hasUncommittedManualQuestion(
  drafts: BulkQuestionDraft[],
  editor: BulkQuestionDraft,
  editingIndex: number | null,
): boolean {
  if (editingIndex === null) return hasDraftQuestionContent(editor);
  const savedDraft = drafts[editingIndex];
  if (!savedDraft) return hasDraftQuestionContent(editor);
  return comparableDraft(savedDraft) !== comparableDraft(editor);
}

export function inspectPendingManualQuestion(
  drafts: BulkQuestionDraft[],
  editor: BulkQuestionDraft,
  editingIndex: number | null,
  getIssues: (draft: BulkQuestionDraft) => string[],
): PendingManualQuestion | null {
  if (!hasUncommittedManualQuestion(drafts, editor, editingIndex)) return null;
  const draft = normalizeEditableQuestionDraft(editor);
  const issues = getIssues(draft);
  return { draft: { ...draft, issues }, editingIndex, issues };
}

export function resolvePendingQuestionSave(
  drafts: BulkQuestionDraft[],
  pending: PendingManualQuestion,
  decision: PendingQuestionSaveDecision,
): PendingQuestionSaveResolution {
  if (decision === 'cancel') return { status: 'cancel', drafts };
  if (decision === 'discard') {
    return { status: 'save', drafts, includedPendingQuestion: false };
  }
  if (pending.issues.length > 0) {
    return { status: 'invalid', drafts, issues: pending.issues };
  }
  return {
    status: 'save',
    drafts: commitPendingQuestion(drafts, pending),
    includedPendingQuestion: true,
  };
}

function commitPendingQuestion(
  drafts: BulkQuestionDraft[],
  pending: PendingManualQuestion,
): BulkQuestionDraft[] {
  const { editingIndex } = pending;
  if (editingIndex !== null && drafts[editingIndex]) {
    return drafts.map((draft, index) => index === editingIndex
      ? { ...pending.draft, id: draft.id, choices: [...pending.draft.choices] }
      : draft);
  }
  return [
    ...drafts,
    {
      ...pending.draft,
      id: createUniqueManualDraftId(drafts),
      choices: [...pending.draft.choices],
    },
  ];
}

function comparableDraft(draft: BulkQuestionDraft): string {
  const normalized = normalizeEditableQuestionDraft(draft);
  return JSON.stringify({
    question: normalized.question,
    choices: normalized.choices,
    distractors: normalized.distractors,
    shuffleChoices: normalized.shuffleChoices,
    answerIndexes: normalized.answerIndexes,
    explanation: normalized.explanation,
    detailedExplanation: normalized.detailedExplanation ?? '',
    category: normalized.category,
    sourcePage: normalized.sourcePage,
    difficulty: normalized.difficulty ?? '',
  });
}

function createUniqueManualDraftId(drafts: BulkQuestionDraft[]): string {
  const ids = new Set(drafts.map((draft) => draft.id));
  let ordinal = drafts.length + 1;
  while (ids.has(`manual-${ordinal}`)) ordinal += 1;
  return `manual-${ordinal}`;
}

function getNormalizedAnswerIndexes(draft: BulkQuestionDraft): number[] {
  const candidates = draft.answerIndexes?.length
    ? draft.answerIndexes
    : draft.answerIndex === null
      ? []
      : [draft.answerIndex];
  return Array.from(new Set(candidates))
    .filter((index) => Number.isInteger(index) && index >= 0 && index < draft.choices.length)
    .sort((left, right) => left - right);
}
