import type { Question } from '../types';

export function randomizeQuestionChoices(question: Question, random = Math.random): Question {
  if (question.shuffleChoices === false || (!question.shuffleChoices && !question.distractors?.length)) return question;
  const answers = question.answerIndexes?.length ? question.answerIndexes : [question.answerIndex];
  const shuffle = <T,>(values: T[]): T[] => {
    const result = [...values];
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  };
  const correct = answers.map((index) => ({ text: question.choices[index], correct: true }));
  const correctTexts = new Set(correct.map((item) => item.text.trim()));
  const wrong = [...new Set([
    ...question.choices.filter((_, index) => !answers.includes(index)),
    ...(question.distractors ?? []),
  ].map((text) => text.trim()))].filter((text) => text && !correctTexts.has(text));
  const required = question.choices.length - correct.length;
  if (wrong.length < required) return question;
  const options = shuffle([...correct, ...shuffle(wrong).slice(0, required).map((text) => ({ text, correct: false }))]);
  const answerIndexes = options.flatMap((option, index) => option.correct ? [index] : []);
  return { ...question, choices: options.map((option) => option.text) as Question['choices'], answerIndex: answerIndexes[0], answerIndexes, answerText: correct.map((option) => option.text).join(' / ') };
}
