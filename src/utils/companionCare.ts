import type { AnswerLog } from '../types';

export const COMPANION_CARE_KEY = 'quizMake:companion:care:v1';
export const COMPANION_CARE_EVENT = 'quiz-make-companion-care-change';
export const COMPANION_BALANCE = {
  answersPerFood: 50,
  maxFriendship: 100,
  feedingGain: 4,
  trainingGain: 3,
  pettingGain: 0.5,
  rewardedPetsPerDay: 3,
  absenceGraceDays: 2,
  absenceLossPerDay: 1,
  recoveryMultiplier: 2,
} as const;

export type CompanionTrickId = 'spin' | 'touch' | 'bow' | 'roll' | 'sleep';
export const COMPANION_TRICKS: readonly { id: CompanionTrickId; name: string; description: string; friendship: number; practices: number }[] = [
  { id: 'spin', name: 'くるりん', description: 'その場でくるっとひと回り。', friendship: 0, practices: 5 },
  { id: 'touch', name: 'タッチ', description: '前足をあげて、ハイタッチ。', friendship: 8, practices: 8 },
  { id: 'bow', name: 'おじぎ', description: '頭を下げて、ぺこりとごあいさつ。', friendship: 20, practices: 10 },
  { id: 'roll', name: 'ごろん', description: '横になって、ごろんとひと転がり。', friendship: 38, practices: 12 },
  { id: 'sleep', name: 'おやすみ', description: '伏せて目を閉じ、おやすみのポーズ。', friendship: 58, practices: 16 },
];

export type CompanionReaction = 'watch' | 'happy' | 'approach' | 'cuddle' | 'relax';
export interface CompanionCare {
  version: 2;
  /** Counts before the current reward rule; old rewards and unspent answers survive upgrades. */
  rewardBaseline: { answers: number; awards: number };
  name: string;
  food: number;
  answerRemainder: number;
  creditedAnswerIds: string[];
  /** Retained even when a question/history is deleted, so restored IDs cannot pay twice. */
  foodAwardAnswerIds: string[];
  friendship: number;
  peakFriendship: number;
  lastSeenDay: string;
  decayThroughDay: string;
  pettingDay: string;
  rewardedPets: number;
  tricks: Record<CompanionTrickId, number>;
}

export type CompanionCareAction = { kind: 'feed' } | { kind: 'pet' } | { kind: 'train'; trickId: CompanionTrickId } | { kind: 'rename'; name: string } | { kind: 'reset' };

export function createCompanionCare(day: string): CompanionCare {
  return { version: 2, rewardBaseline: { answers: 0, awards: 0 }, name: 'パピィ', food: 0, answerRemainder: 0, creditedAnswerIds: [], foodAwardAnswerIds: [],
    friendship: 0, peakFriendship: 0, lastSeenDay: day, decayThroughDay: day, pettingDay: day, rewardedPets: 0,
    tricks: { spin: 0, touch: 0, bow: 0, roll: 0, sleep: 0 } };
}

const dayNumber = (day: string) => Date.parse(day + 'T00:00:00Z') / 86_400_000;
const validDay = (day: unknown): day is string => typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(day)
  && Number.isFinite(dayNumber(day)) && new Date(dayNumber(day) * 86_400_000).toISOString().slice(0, 10) === day;
const natural = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const ids = (value: unknown): value is string[] => Array.isArray(value) && value.every(id => typeof id === 'string' && id.length > 0) && new Set(value).size === value.length;

/** Invalid saves are surfaced and preserved; never silently reset earned progress. */
export function parseCompanionCare(raw: string): CompanionCare {
  const value = JSON.parse(raw) as Omit<CompanionCare, 'version'> & { version: 1 | 2 };
  if (!value || (value.version !== 1 && value.version !== 2) || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 20
    || !natural(value.food) || !natural(value.answerRemainder) || value.answerRemainder >= (value.version === 1 ? 20 : COMPANION_BALANCE.answersPerFood)
    || !ids(value.creditedAnswerIds) || !ids(value.foodAwardAnswerIds)
    || typeof value.friendship !== 'number' || !Number.isFinite(value.friendship) || value.friendship < 0
    || typeof value.peakFriendship !== 'number' || !Number.isFinite(value.peakFriendship)
    || value.peakFriendship < value.friendship || value.peakFriendship > COMPANION_BALANCE.maxFriendship
    || !validDay(value.lastSeenDay) || !validDay(value.decayThroughDay) || !validDay(value.pettingDay)
    || value.decayThroughDay < value.lastSeenDay || !natural(value.rewardedPets) || value.rewardedPets > COMPANION_BALANCE.rewardedPetsPerDay
    || !value.tricks || COMPANION_TRICKS.some(trick => !natural(value.tricks[trick.id]) || value.tricks[trick.id] > trick.practices)) {
    throw new Error('育成データを読み取れませんでした。保存済みのごはんや芸は上書きしていません。');
  }
  const credited = new Set(value.creditedAnswerIds);
  const baseline = value.version === 1 ? { answers: 0, awards: 0 } : value.rewardBaseline;
  if (!baseline || !natural(baseline.answers) || baseline.answers > credited.size
    || !natural(baseline.awards) || baseline.awards > baseline.answers) {
    throw new Error('ごはんの獲得記録を確認できませんでした。保存済みのデータは保持しています。');
  }
  const threshold = value.version === 1 ? 20 : COMPANION_BALANCE.answersPerFood;
  const earned = baseline.awards + Math.floor((credited.size - baseline.answers) / threshold);
  if (value.foodAwardAnswerIds.some(id => !credited.has(id)) || value.foodAwardAnswerIds.length !== earned
    || value.answerRemainder !== (credited.size - baseline.answers) % threshold || value.food > earned) {
    throw new Error('ごはんの獲得記録を確認できませんでした。保存済みのデータは保持しています。');
  }
  return value.version === 1
    ? { ...value, version: 2, rewardBaseline: { answers: credited.size - value.answerRemainder, awards: value.foodAwardAnswerIds.length } }
    : value as CompanionCare;
}

/** Only durable AnswerLogs are passed here; correctness and quiz/review mode do not affect credit. */
export function creditCompanionAnswers(care: CompanionCare, logs: readonly Pick<AnswerLog, 'id'>[]): CompanionCare {
  const credited = new Set(care.creditedAnswerIds);
  const newIds: string[] = [], awards: string[] = [];
  let remainder = care.answerRemainder;
  for (const log of logs) {
    if (!log.id || credited.has(log.id)) continue;
    credited.add(log.id);
    newIds.push(log.id);
    if (++remainder === COMPANION_BALANCE.answersPerFood) { awards.push(log.id); remainder = 0; }
  }
  if (!newIds.length) return care;
  return { ...care, food: care.food + awards.length, answerRemainder: remainder,
    creditedAnswerIds: [...care.creditedAnswerIds, ...newIds], foodAwardAnswerIds: [...care.foodAwardAnswerIds, ...awards] };
}

/** Calendar-day decay is incremental, so reopening/reconciling cannot apply the same day twice. */
export function refreshCompanionDay(care: CompanionCare, day: string, visit = false): CompanionCare {
  if (!validDay(day)) throw new Error('育成の日付を確認できませんでした。');
  if (day < care.decayThroughDay) return care;
  const decayStart = Math.max(dayNumber(care.decayThroughDay), dayNumber(care.lastSeenDay) + COMPANION_BALANCE.absenceGraceDays);
  const loss = Math.max(0, dayNumber(day) - decayStart) * COMPANION_BALANCE.absenceLossPerDay;
  const lastSeenDay = visit ? day : care.lastSeenDay;
  const pettingDay = day > care.pettingDay ? day : care.pettingDay;
  if (day === care.decayThroughDay && lastSeenDay === care.lastSeenDay && pettingDay === care.pettingDay) return care;
  return { ...care, friendship: Math.max(0, care.friendship - loss), lastSeenDay, decayThroughDay: day,
    pettingDay, rewardedPets: pettingDay === care.pettingDay ? care.rewardedPets : 0 };
}

function gainFriendship(care: CompanionCare, gain: number): CompanionCare {
  const recovering = Math.min(Math.max(0, care.peakFriendship - care.friendship), gain * COMPANION_BALANCE.recoveryMultiplier);
  const remaining = gain - recovering / COMPANION_BALANCE.recoveryMultiplier;
  const friendship = Math.min(COMPANION_BALANCE.maxFriendship, care.friendship + recovering + remaining);
  return { ...care, friendship, peakFriendship: Math.max(care.peakFriendship, friendship) };
}

export function isCompanionTrickLearned(care: CompanionCare, id: CompanionTrickId): boolean {
  const trick = COMPANION_TRICKS.find(trick => trick.id === id);
  return Boolean(trick && care.tricks[id] >= trick.practices);
}
export function canTeachCompanionTrick(care: CompanionCare, id: CompanionTrickId): boolean {
  const trick = COMPANION_TRICKS.find(trick => trick.id === id);
  // A once-unlocked trick stays teachable while the bond recovers.
  return Boolean(trick && care.peakFriendship >= trick.friendship);
}

export function applyCompanionCareAction(care: CompanionCare, action: CompanionCareAction, day: string): CompanionCare {
  const current = refreshCompanionDay(care, day, true);
  if (action.kind === 'reset') {
    return { ...createCompanionCare(day), name: current.name, creditedAnswerIds: current.creditedAnswerIds,
      rewardBaseline: { answers: current.creditedAnswerIds.length, awards: 0 } };
  }
  if (action.kind === 'rename') {
    const name = action.name.trim();
    if (!name || name.length > 20) throw new Error('名前は1〜20文字で入力してください。');
    return name === current.name ? current : { ...current, name };
  }
  if (action.kind === 'pet') {
    if (current.rewardedPets >= COMPANION_BALANCE.rewardedPetsPerDay) return current;
    return gainFriendship({ ...current, rewardedPets: current.rewardedPets + 1 }, COMPANION_BALANCE.pettingGain);
  }
  if (current.food < 1) throw new Error('ごはんがありません。問題を解いてごはんを集めよう。');
  if (action.kind === 'feed') return gainFriendship({ ...current, food: current.food - 1 }, COMPANION_BALANCE.feedingGain);
  const trick = COMPANION_TRICKS.find(trick => trick.id === action.trickId);
  if (!trick || !canTeachCompanionTrick(current, trick.id)) throw new Error('もう少しなかよくなると、この芸を教えられます。');
  if (isCompanionTrickLearned(current, trick.id)) throw new Error('この芸は習得済みです。ごはんを使わずお願いできます。');
  return gainFriendship({ ...current, food: current.food - 1, tricks: { ...current.tricks, [trick.id]: current.tricks[trick.id] + 1 } }, COMPANION_BALANCE.trainingGain);
}

export function companionReactions(friendship: number): CompanionReaction[] {
  const reactions: CompanionReaction[] = ['watch'];
  if (friendship >= 8) reactions.push('happy');
  if (friendship >= 20) reactions.push('approach');
  if (friendship >= 38) reactions.push('cuddle');
  if (friendship >= 58) reactions.push('relax');
  return reactions;
}
export function pickCompanionReaction(friendship: number, variant: number): CompanionReaction {
  const bond = Math.max(0, Math.min(COMPANION_BALANCE.maxFriendship, friendship));
  // Each affectionate reaction has its own increasing probability. Removing
  // another pose must never accidentally make cuddling more frequent.
  const weights: [CompanionReaction, number][] = [
    ['happy', bond >= 8 ? 0.15 : 0],
    ['approach', bond >= 20 ? 0.08 + (bond - 20) / 80 * 0.1 : 0],
    ['cuddle', bond >= 38 ? 0.1 + (bond - 38) / 62 * 0.24 : 0],
    ['relax', bond >= 58 ? 0.08 + (bond - 58) / 42 * 0.12 : 0],
  ];
  let cursor = Math.max(0, Math.min(1, variant));
  for (const [reaction, weight] of weights) {
    if (cursor < weight) return reaction;
    cursor -= weight;
  }
  return 'watch';
}
export function companionFriendshipLabel(friendship: number): string {
  if (friendship >= 80) return 'だいすき';
  if (friendship >= 58) return 'いつもそばに';
  if (friendship >= 38) return '甘えんぼ';
  if (friendship >= 20) return 'なかよし';
  if (friendship >= 8) return '気になる存在';
  return 'はじめまして';
}

export function companionSessionFood(care: CompanionCare, answerIds: readonly string[]): number {
  const session = new Set(answerIds);
  return care.foodAwardAnswerIds.reduce((total, id) => total + Number(session.has(id)), 0);
}
