import type { AnswerLog } from '../types';

export const COMPANION_CARE_KEY = 'quizMake:companion:care:v1';
export const COMPANION_CARE_EVENT = 'quiz-make-companion-care-change';
export const COMPANION_BALANCE = {
  answersPerFood: 50,
  answersPerTreat: 25,
  maxFriendship: 100,
  feedingGain: 4 / 3,
  pettingGain: 0.5 / 3,
  rewardedPetsPerDay: 3,
  absenceGraceDays: 2,
  absenceLossPerDay: 1,
  recoveryMultiplier: 2,
} as const;

export type CompanionTrickId = 'spin' | 'touch' | 'bow' | 'roll' | 'sleep';
export const COMPANION_TRICKS: readonly { id: CompanionTrickId; name: string; description: string; practices: number; minFriendship: number }[] = [
  { id: 'spin', name: 'くるりん', description: 'その場でくるっとひと回り。', practices: 5, minFriendship: 8 },
  { id: 'touch', name: 'タッチ', description: '前足をあげて、ハイタッチ。', practices: 8, minFriendship: 20 },
  { id: 'bow', name: 'おじぎ', description: '頭を下げて、ぺこりとごあいさつ。', practices: 10, minFriendship: 38 },
  { id: 'roll', name: 'ごろん', description: '横になって、ごろんとひと転がり。', practices: 12, minFriendship: 58 },
  { id: 'sleep', name: 'おやすみ', description: '伏せて目を閉じ、おやすみのポーズ。', practices: 16, minFriendship: 80 },
];

export type CompanionReaction = 'watch' | 'happy' | 'approach' | 'cuddle' | 'relax';
export interface CompanionCare {
  version: 4;
  /** New answers share one spendable balance; legacy inventory is never credited again. */
  answerBalance: number;
  spendEvents: { id: string; amount: number; kind: 'food' | 'treat' }[];
  answerBudget: { baselineAnswers: number; initialBalance: number; spent: number; legacyFood: number; legacyTreats: number; rebased?: true };
  /** Counts before the current reward rule; old rewards and unspent answers survive upgrades. */
  rewardBaseline: { answers: number; awards: number };
  name: string;
  food: number;
  treats: number;
  /** The initial grant is separate from newly earned rewards, so old result screens cannot claim treats. */
  treatRewardBaseline: { awards: number; treats: number };
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
  return { version: 4, spendEvents: [], answerBalance: 0, answerBudget: { baselineAnswers: 0, initialBalance: 0, spent: 0, legacyFood: 0, legacyTreats: 0 }, rewardBaseline: { answers: 0, awards: 0 }, name: 'パピィ', food: 0, treats: 0,
    treatRewardBaseline: { awards: 0, treats: 0 }, answerRemainder: 0, creditedAnswerIds: [], foodAwardAnswerIds: [],
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
  const value = JSON.parse(raw) as Omit<CompanionCare, 'version'> & { version: 1 | 2 | 3 | 4 };
  if (!value || ![1, 2, 3, 4].includes(value.version) || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 20
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
  if (value.version === 4) {
    const budget = value.answerBudget;
    if (!Array.isArray(value.spendEvents) || !ids(value.spendEvents.map(event => event?.id))
      || value.spendEvents.some(event => !['food','treat'].includes(event.kind) || event.amount !== 0 && event.amount !== 25 && event.amount !== 50)
      || value.spendEvents.reduce((total,event) => total + event.amount,0) !== budget?.spent
      || !budget || !natural(budget.baselineAnswers) || budget.baselineAnswers > credited.size || budget.baselineAnswers < baseline.answers
      || !Number.isSafeInteger(budget.initialBalance) || (!budget.rebased && (budget.initialBalance < 0 || budget.initialBalance >= COMPANION_BALANCE.answersPerFood))
      || !natural(budget.spent) || budget.spent % COMPANION_BALANCE.answersPerTreat !== 0
      || !natural(budget.legacyFood) || !natural(budget.legacyTreats) || !Number.isSafeInteger(value.answerBalance)
      || value.answerBalance !== budget.initialBalance + credited.size - budget.baselineAnswers - budget.spent
      || value.answerRemainder !== ((value.answerBalance % COMPANION_BALANCE.answersPerFood) + COMPANION_BALANCE.answersPerFood) % COMPANION_BALANCE.answersPerFood
      || value.food > budget.legacyFood || !natural(value.treats) || value.treats > budget.legacyTreats) {
      throw new Error('解答数の残りを確認できませんでした。保存済みの育成データは保持しています。');
    }
    const legacyIds = new Set(value.creditedAnswerIds.slice(0, budget.baselineAnswers));
    const earned = baseline.awards + Math.floor((budget.baselineAnswers - baseline.answers) / COMPANION_BALANCE.answersPerFood);
    const treats = value.treatRewardBaseline;
    if (!budget.rebased && (budget.initialBalance !== (budget.baselineAnswers - baseline.answers) % COMPANION_BALANCE.answersPerFood
      || value.foodAwardAnswerIds.some(id => !legacyIds.has(id))
      || value.foodAwardAnswerIds.length !== earned || budget.legacyFood > earned
      || !treats || !natural(treats.awards) || treats.awards > earned || !natural(treats.treats) || treats.treats > treats.awards
      || budget.legacyTreats > treats.treats + earned - treats.awards)) throw new Error('以前の所持品を確認できませんでした。保存済みのデータは保持しています。');
    return value as CompanionCare;
  }
  const threshold = value.version === 1 ? 20 : COMPANION_BALANCE.answersPerFood;
  const earned = baseline.awards + Math.floor((credited.size - baseline.answers) / threshold);
  if (value.foodAwardAnswerIds.some(id => !credited.has(id)) || value.foodAwardAnswerIds.length !== earned
    || value.answerRemainder !== (credited.size - baseline.answers) % threshold || value.food > earned) {
    throw new Error('ごはんの獲得記録を確認できませんでした。保存済みのデータは保持しています。');
  }
  if (value.version === 3) {
    const treats = value.treatRewardBaseline;
    if (!natural(value.treats) || !treats || !natural(treats.awards) || treats.awards > earned
      || !natural(treats.treats) || treats.treats > treats.awards || value.treats > treats.treats + earned - treats.awards) {
      throw new Error('おやつの獲得記録を確認できませんでした。保存済みのデータは保持しています。');
    }
  }
  // Existing v3 items remain inventory, not a second source of answer credit.
  // v1/v2 never owned treats, so do not invent a parallel grant during upgrade.
  const treats = value.version === 3 ? value.treats : 0;
  return { ...value, version: 4, spendEvents: [], treats, answerBalance: value.answerRemainder,
    answerBudget: { baselineAnswers: credited.size, initialBalance: value.answerRemainder, spent: 0, legacyFood: value.food, legacyTreats: treats },
    treatRewardBaseline: value.version === 3 ? value.treatRewardBaseline : { awards: earned, treats: 0 },
    rewardBaseline: value.version === 1 ? { answers: credited.size - value.answerRemainder, awards: earned } : baseline };

}

/** Only durable AnswerLogs are passed here; correctness and quiz/review mode do not affect credit. */
export function creditCompanionAnswers(care: CompanionCare, logs: readonly Pick<AnswerLog, 'id'>[]): CompanionCare {
  const credited = new Set(care.creditedAnswerIds);
  const newIds: string[] = [];
  for (const log of logs) {
    if (!log.id || credited.has(log.id)) continue;
    credited.add(log.id); newIds.push(log.id);
  }
  if (!newIds.length) return care;
  const answerBalance = care.answerBalance + newIds.length;
  return { ...care, answerBalance, answerRemainder: ((answerBalance % COMPANION_BALANCE.answersPerFood) + COMPANION_BALANCE.answersPerFood) % COMPANION_BALANCE.answersPerFood,
    creditedAnswerIds: [...care.creditedAnswerIds, ...newIds] };

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
  return Boolean(trick && care.friendship >= trick.minFriendship);
}

export function applyCompanionCareAction(care: CompanionCare, action: CompanionCareAction, day: string): CompanionCare {
  const current = refreshCompanionDay(care, day, true);
  if (action.kind === 'reset') {
    return { ...createCompanionCare(day), name: current.name, creditedAnswerIds: current.creditedAnswerIds,
      spendEvents: current.spendEvents, answerBudget: { baselineAnswers: current.creditedAnswerIds.length, initialBalance: current.answerBudget.spent, spent: current.answerBudget.spent, legacyFood: 0, legacyTreats: 0, rebased: true },
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
  if (action.kind === 'feed') {
    if (companionFoodAvailable(current) < 1) throw new Error('ごはんには50問分の解答数が必要です。');
    return gainFriendship(current.food > 0 ? { ...current, food: current.food - 1, spendEvents: [...current.spendEvents, { id: crypto.randomUUID(), amount: 0, kind: 'food' }] } : spendCompanionAnswers(current, COMPANION_BALANCE.answersPerFood), COMPANION_BALANCE.feedingGain);
  }
  const trick = COMPANION_TRICKS.find(trick => trick.id === action.trickId);
  if (!trick) throw new Error('教える芸を選んでください。');
  if (isCompanionTrickLearned(current, trick.id)) throw new Error('この芸は習得済みです。おやつを使わずお願いできます。');
  if (!canTeachCompanionTrick(current, trick.id)) throw new Error(`この芸の練習には、なかよし度${trick.minFriendship}以上が必要です。`);
  if (companionTreatsAvailable(current) < 1) throw new Error('おやつには25問分の解答数が必要です。');
  const paid: CompanionCare = current.treats > 0 ? { ...current, treats: current.treats - 1, spendEvents: [...current.spendEvents, { id: crypto.randomUUID(), amount: 0, kind: 'treat' }] } : spendCompanionAnswers(current, COMPANION_BALANCE.answersPerTreat);
  return { ...paid, tricks: { ...current.tricks, [trick.id]: current.tricks[trick.id] + 1 } };
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

export function companionSessionTreats(care: CompanionCare, answerIds: readonly string[]): number {
  const session = new Set(answerIds);
  return care.foodAwardAnswerIds.slice(care.treatRewardBaseline.awards).reduce((total, id) => total + Number(session.has(id)), 0);
}

export const companionFoodAvailable = (care: CompanionCare) => care.food + Math.max(0, Math.floor(care.answerBalance / COMPANION_BALANCE.answersPerFood));
export const companionTreatsAvailable = (care: CompanionCare) => care.treats + Math.max(0, Math.floor(care.answerBalance / COMPANION_BALANCE.answersPerTreat));
function spendCompanionAnswers(care: CompanionCare, amount: number): CompanionCare {
  if (care.answerBalance < amount) throw new Error('使える解答数が不足しています。');
  const answerBalance = care.answerBalance - amount;
  return { ...care, answerBalance, spendEvents: [...care.spendEvents, { id: crypto.randomUUID(), amount, kind: amount === 50 ? 'food' : 'treat' }], answerRemainder: ((answerBalance % COMPANION_BALANCE.answersPerFood) + COMPANION_BALANCE.answersPerFood) % COMPANION_BALANCE.answersPerFood,
    answerBudget: { ...care.answerBudget, spent: care.answerBudget.spent + amount } };
}
export function companionSessionAnswers(care: CompanionCare, answerIds: readonly string[]): number {
  const credited = new Set(care.creditedAnswerIds.slice(care.answerBudget.baselineAnswers));
  return [...new Set(answerIds)].filter(id => credited.has(id)).length;
}

/** A remote snapshot may not silently forget a committed spend, including equal-cost parallel actions. */
export function companionSpendWouldRollback(localRaw: string | null, remoteRaw: string | null): boolean {
  if (!localRaw || localRaw === remoteRaw) return false;
  const local = parseCompanionCare(localRaw);
  if (!local.spendEvents.length) return false;
  if (!remoteRaw) return true;
  const remote = parseCompanionCare(remoteRaw), known = new Set(remote.spendEvents.map(event => event.id));
  return local.spendEvents.some(event => !known.has(event.id));
}

/** Explicitly select care progress, retaining both answer/spend ledgers even when they create a debt. */
export function mergeCompanionBudgets(selected: CompanionCare, other: CompanionCare): CompanionCare {
  const a=selected.answerBudget;
  const events=new Map(selected.spendEvents.map(event=>[event.id,event]));
  const missing=other.spendEvents.filter(event=>!events.has(event.id));
  for(const event of other.spendEvents){if(events.has(event.id)&&(events.get(event.id)!.amount!==event.amount||events.get(event.id)!.kind!==event.kind))throw new Error('消費記録が一致しません。原本を保持しています。');events.set(event.id,event);}
  const spendEvents=[...events.values()],spent=spendEvents.reduce((sum,event)=>sum+event.amount,0);
  const selectedIds=new Set(selected.creditedAnswerIds);
  const newCredit=other.creditedAnswerIds.slice(other.answerBudget.baselineAnswers).filter(id=>!selectedIds.has(id)).length;
  const excluded=new Set([...selected.creditedAnswerIds.slice(0,a.baselineAnswers),...other.creditedAnswerIds.slice(0,other.answerBudget.baselineAnswers)]);
  const creditedAnswerIds=[...excluded,...new Set([...selected.creditedAnswerIds,...other.creditedAnswerIds].filter(id=>!excluded.has(id)))];
  const foodDue=missing.filter(e=>e.amount===0&&e.kind==='food').length,treatDue=missing.filter(e=>e.amount===0&&e.kind==='treat').length;
  const legacyDebt=Math.max(0,foodDue-selected.food)*50+Math.max(0,treatDue-selected.treats)*25;
  const initialBalance=selected.answerBalance+a.spent+newCredit-legacyDebt-(creditedAnswerIds.length-excluded.size);
  const answerBalance=initialBalance+creditedAnswerIds.length-excluded.size-spent;
  const next={...selected,creditedAnswerIds,spendEvents,answerBalance,
    answerBudget:{baselineAnswers:excluded.size,initialBalance,spent,legacyFood:a.legacyFood,legacyTreats:a.legacyTreats,rebased:true as const},
    food:Math.max(0,selected.food-foodDue),treats:Math.max(0,selected.treats-treatDue),
    answerRemainder:((answerBalance%50)+50)%50};
  return parseCompanionCare(JSON.stringify(next));
}

export function preserveCompanionBudgetRaw(currentRaw: string | null, selectedRaw: string | null): string | null {
 if(!companionSpendWouldRollback(currentRaw,selectedRaw))return selectedRaw;
 if(!selectedRaw)return currentRaw;
 return JSON.stringify(mergeCompanionBudgets(parseCompanionCare(selectedRaw),parseCompanionCare(currentRaw!)));
}
