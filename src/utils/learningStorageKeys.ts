/** User learning values, distinct from synchronous coordination/settings keys. */
export const LEARNING_VALUE_PREFIX = 'quiz-make-idb-learning-v1:';
export const LEARNING_ORIGINAL_PREFIX = 'quiz-make-idb-original-v1:';
export const LEARNING_MIGRATED_KEY = 'quizMake:sync:idbLearning:v1';
// Older record clients reject this before capturing absent native learning keys.
export const LEARNING_REQUIRED_KEY = 'quizMake:sync:learningStorageRequired:v1';
export const LEARNING_REQUIRED_ROW = { schema: 1, kind: 'quiz-learning-idb-required' } as const;
export function isLearningStorageKey(key: string): boolean {
  if (key === 'quizMake:plan:__record_chunks_v1') return false;
  return key.startsWith('quizMake:plan:') || key.startsWith('quizMake:planDay:')
    || ['quiz-make-creation-notes-v1', 'quiz-make-creation-notes-v1-removed-orphans', 'quiz-make-explanation-requests-v1'].includes(key);
}
