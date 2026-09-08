import { createClient, type AuthChangeEvent, type Session } from '@supabase/supabase-js';
import type { AppData, ProblemSetVisibility } from '../types';
import {
  beginNativeAuthAttempt,
  getCloudAuthRedirectUrl,
  isNativeAuthPlatform,
  onNativeAuthResult,
  startNativeAuthListener,
  type NativeAuthResultEvent,
  type NativeAuthReturnTarget,
} from './nativeAuth';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim() ?? '';
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim() ?? '';

export const cloudConfigured = Boolean(supabaseUrl && supabaseAnonKey);
const nativeAuthPlatform = isNativeAuthPlatform();
export const cloudClient = cloudConfigured
  ? createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: !nativeAuthPlatform,
        ...(nativeAuthPlatform
          ? {
              flowType: 'pkce' as const,
              experimental: { appendPkceFlowIdToRedirects: true },
            }
          : {}),
      },
    })
  : null;

export { onNativeAuthResult };
export type { NativeAuthResultEvent, NativeAuthReturnTarget };

export interface CloudQuestion {
  question: string;
  choices: string[];
  answerIndexes: number[];
  answerText: string;
  explanation: string;
  detailedExplanation: string;
  sourcePage: string;
  category: string;
  difficulty: string;
}

export interface CloudProblemSet {
  id: string;
  localSetId: string;
  ownerId: string;
  authorName: string;
  title: string;
  description: string;
  subject: string;
  audience: string;
  difficulty: string;
  creationMethod: string;
  source: string;
  visibility: ProblemSetVisibility;
  questionCount: number;
  addCount: number;
  publishedAt: string;
  updatedAt: string;
  questions?: CloudQuestion[];
}

export interface CloudGroup {
  id: string;
  name: string;
  role: 'owner' | 'admin' | 'member';
  memberCount: number;
  setCount: number;
}

export interface CloudGroupMember {
  userId: string;
  displayName: string;
  role: 'owner' | 'admin' | 'member';
}

export interface CloudPublishResult {
  id: string;
  shareToken: string;
  visibility: ProblemSetVisibility;
}

export function getCloudSession() {
  if (!cloudClient) return Promise.resolve<Session | null>(null);
  return cloudClient.auth.getSession().then(({ data }) => data.session);
}

export function onCloudAuthStateChange(callback: (event: AuthChangeEvent, session: Session | null) => void) {
  if (!cloudClient) return () => undefined;
  const { data } = cloudClient.auth.onAuthStateChange(callback);
  return () => data.subscription.unsubscribe();
}

export async function sendMagicLink(email: string, returnTarget?: NativeAuthReturnTarget): Promise<void> {
  const client = requireCloudClient();
  if (nativeAuthPlatform) beginNativeAuthAttempt(returnTarget);
  const { error } = await client.auth.signInWithOtp({
    email: email.trim(),
    options: { emailRedirectTo: getCloudAuthRedirectUrl() },
  });
  if (error) throw new Error(toFriendlyCloudError(error.message));
}

export const lineLoginAvailable = cloudConfigured && !nativeAuthPlatform;

export async function getLineLinkStatus(userId: string): Promise<boolean> {
  const { data, error } = await requireCloudClient().auth.getUser();
  if (error || !data.user || data.user.id !== userId || !Array.isArray(data.user.identities)) throw new Error('LINEの連携状態を確認できませんでした。');
  return data.user.identities.some((identity) => identity.provider === 'custom:line');
}

export async function linkLineIdentity(): Promise<boolean> {
  if (nativeAuthPlatform) throw new Error('LINE連携はブラウザ版でご利用ください。');
  const client = requireCloudClient();
  const { data: userData, error: userError } = await client.auth.getUser();
  if (userError || !userData.user) throw new Error('現在のアカウントを確認できません。ログイン状態を確認してください。');
  if (userData.user.identities?.some((identity) => identity.provider === 'custom:line')) return true;
  const { error } = await client.auth.linkIdentity({
    provider: 'custom:line',
    options: { redirectTo: getCloudAuthRedirectUrl(), scopes: 'openid profile' },
  });
  if (error) {
    if (error.code === 'manual_linking_disabled') throw new Error('LINE連携は管理者側の有効化待ちです。現在のログイン状態はそのままです。');
    if (error.code === 'identity_already_exists') throw new Error('このLINEは別のアカウントに連携済みです。自動統合は行いません。');
    throw new Error('LINE連携を開始できませんでした。現在のアカウントのまま、もう一度お試しください。');
  }
  return false;
}

export async function signInWithLine(): Promise<void> {
  if (nativeAuthPlatform) throw new Error('LINEログインはブラウザ版でご利用ください。');
  const client = requireCloudClient();
  const { error } = await client.auth.signInWithOAuth({
    provider: 'custom:line',
    options: { redirectTo: getCloudAuthRedirectUrl(), scopes: 'openid profile' },
  });
  if (error) throw new Error(toFriendlyCloudError(error.message));
}

export async function initializeCloudNativeAuth(): Promise<() => Promise<void>> {
  if (!cloudClient || !nativeAuthPlatform) return async () => undefined;
  return startNativeAuthListener(cloudClient);
}

export type CloudAccessTokenResult =
  | { ok: true; accessToken: string; userId: string }
  | {
      ok: false;
      reason: 'not-configured' | 'signed-out' | 'validation-failed';
      message: string;
    };

export async function getCloudAccessToken(): Promise<CloudAccessTokenResult> {
  if (!cloudClient) {
    return { ok: false, reason: 'not-configured', message: 'クラウド接続が設定されていません。' };
  }

  try {
    const { data: sessionData, error: sessionError } = await cloudClient.auth.getSession();
    const session = sessionData.session;
    if (sessionError) {
      return {
        ok: false,
        reason: 'validation-failed',
        message: 'ログイン状態を確認できませんでした。通信状態を確認して、もう一度お試しください。',
      };
    }
    if (!session?.access_token || session.user.is_anonymous) {
      return { ok: false, reason: 'signed-out', message: 'クラウド同期を使うにはログインが必要です。' };
    }

    // getSession() alone reads client storage. Validate this exact JWT with the
    // Auth server before another service uses it as a Bearer credential.
    const { data: userData, error: userError } = await cloudClient.auth.getUser(session.access_token);
    if (userError || !userData.user || userData.user.is_anonymous || userData.user.id !== session.user.id) {
      return {
        ok: false,
        reason: 'validation-failed',
        message: 'ログイン状態を確認できませんでした。通信状態を確認して、もう一度ログインしてください。',
      };
    }

    return { ok: true, accessToken: session.access_token, userId: userData.user.id };
  } catch {
    return {
      ok: false,
      reason: 'validation-failed',
      message: 'ログイン状態を確認できませんでした。通信状態を確認して、もう一度お試しください。',
    };
  }
}

export async function signOutCloud(): Promise<void> {
  const client = requireCloudClient();
  const { error } = await client.auth.signOut();
  if (error) throw new Error(toFriendlyCloudError(error.message));
}

export async function deleteCloudAccount(): Promise<void> {
  const client = requireCloudClient();
  const { error } = await client.rpc('delete_quiz_account');
  if (error) throw new Error(toFriendlyCloudError(error.message));
  await client.auth.signOut({ scope: 'local' });
}

export async function updateCloudDisplayName(displayName: string): Promise<void> {
  const client = requireCloudClient();
  const { error } = await client.rpc('set_profile_display_name', { p_display_name: displayName.trim() });
  if (error) throw new Error(toFriendlyCloudError(error.message));
}

export async function getCloudDisplayName(): Promise<string> {
  const client = requireCloudClient();
  const { data, error } = await client
    .from('quiz_profiles')
    .select('display_name')
    .maybeSingle();
  if (error) throw new Error(toFriendlyCloudError(error.message));
  return String(data?.display_name ?? '');
}

export async function publishLocalProblemSet(params: {
  data: AppData;
  setId: string;
  visibility: Exclude<ProblemSetVisibility, 'private'>;
  groupIds?: string[];
  authorName: string;
}): Promise<CloudPublishResult> {
  const client = requireCloudClient();
  const problemSet = params.data.problemSets.find((item) => item.id === params.setId);
  if (!problemSet) throw new Error('共有する問題セットが見つかりません。');
  const questions = params.data.questions.filter((item) => item.setId === params.setId);
  if (questions.length === 0) throw new Error('問題がないセットは共有できません。');
  if (questions.some((question) => question.distractors?.length || question.shuffleChoices)) {
    throw new Error('ランダム選択肢付きの問題は、現在は端末内の学習・同期・バックアップに対応しています。公開共有にはまだ対応していません。');
  }

  const { data, error } = await client.rpc('publish_problem_set', {
    p_set: {
      local_set_id: problemSet.id,
      title: problemSet.title,
      description: problemSet.description ?? '',
      subject: problemSet.subject ?? '',
      audience: problemSet.audience ?? '',
      difficulty: problemSet.difficulty ?? 'basic',
      creation_method: problemSet.creationMethod ?? 'manual',
      source: problemSet.source ?? '',
      visibility: params.visibility,
      author_name: params.authorName.trim(),
      group_ids: params.groupIds ?? [],
    },
    p_questions: questions.map((question, position) => ({
      position,
      question: question.question,
      choices: question.choices,
      answer_indexes: question.answerIndexes?.length ? question.answerIndexes : [question.answerIndex],
      answer_text: question.answerText,
      explanation: question.explanation,
      detailed_explanation: question.detailedExplanation ?? '',
      source_page: question.sourcePage,
      category: question.category,
      difficulty: question.difficulty,
    })),
  });
  if (error) throw new Error(toFriendlyCloudError(error.message));
  const value = data as { id?: unknown; share_token?: unknown; visibility?: unknown } | null;
  if (!value || typeof value.id !== 'string' || typeof value.share_token !== 'string') {
    throw new Error('共有結果を確認できませんでした。');
  }
  return {
    id: value.id,
    shareToken: value.share_token,
    visibility: normalizeVisibility(value.visibility),
  };
}

export async function listPublicProblemSets(query = '', sort: 'new' | 'popular' = 'new'): Promise<CloudProblemSet[]> {
  const client = requireCloudClient();
  let request = client
    .from('shared_problem_sets')
    .select('id,owner_id,author_name,title,description,subject,audience,difficulty,creation_method,source,visibility,question_count,add_count,published_at,updated_at')
    .eq('visibility', 'public')
    .limit(60);
  const trimmed = query.trim();
  if (trimmed) request = request.or(`title.ilike.%${escapeFilterValue(trimmed)}%,subject.ilike.%${escapeFilterValue(trimmed)}%,description.ilike.%${escapeFilterValue(trimmed)}%`);
  request = sort === 'popular'
    ? request.order('add_count', { ascending: false }).order('published_at', { ascending: false })
    : request.order('published_at', { ascending: false });
  const { data, error } = await request;
  if (error) throw new Error(toFriendlyCloudError(error.message));
  return (data ?? []).map(mapProblemSetRow);
}

export async function listMyPublishedSets(): Promise<CloudProblemSet[]> {
  const client = requireCloudClient();
  const { data: userData } = await client.auth.getUser();
  if (!userData.user) return [];
  const { data, error } = await client
    .from('shared_problem_sets')
    .select('id,local_set_id,owner_id,author_name,title,description,subject,audience,difficulty,creation_method,source,visibility,question_count,add_count,published_at,updated_at')
    .eq('owner_id', userData.user.id)
    .order('updated_at', { ascending: false });
  if (error) throw new Error(toFriendlyCloudError(error.message));
  return (data ?? []).map(mapProblemSetRow);
}

export async function unpublishCloudProblemSet(setId: string): Promise<void> {
  const client = requireCloudClient();
  const { data, error } = await client.rpc('unpublish_problem_set', { p_set_id: setId });
  if (error) throw new Error(toFriendlyCloudError(error.message));
  if (data !== true) throw new Error('共有中の問題セットが見つからないか、停止する権限がありません。');
}

export async function getSharedProblemSet(setId: string, shareToken = ''): Promise<CloudProblemSet> {
  const client = requireCloudClient();
  const { data, error } = await client.rpc('get_shared_problem_set', {
    p_set_id: setId,
    p_share_token: shareToken || null,
  });
  if (error) throw new Error(toFriendlyCloudError(error.message));
  const value = data as Record<string, unknown> | null;
  if (!value || typeof value.id !== 'string') throw new Error('問題セットを表示できません。リンクを確認してください。');
  return mapProblemSetJson(value);
}

export async function recordCloudCopy(setId: string, localSetId: string): Promise<void> {
  const client = requireCloudClient();
  const { error } = await client.rpc('record_problem_set_copy', {
    p_set_id: setId,
    p_installation_id: getInstallationId(),
    p_local_set_id: localSetId,
  });
  if (error) throw new Error(toFriendlyCloudError(error.message));
}

export async function reportCloudProblemSet(setId: string, reason: string, details: string): Promise<void> {
  const client = requireCloudClient();
  const { error } = await client.from('problem_reports').insert({ set_id: setId, reason, details: details.trim() });
  if (error) throw new Error(toFriendlyCloudError(error.message));
}

export async function listMyGroups(): Promise<CloudGroup[]> {
  const client = requireCloudClient();
  const { data, error } = await client.rpc('list_my_groups');
  if (error) throw new Error(toFriendlyCloudError(error.message));
  return Array.isArray(data) ? data.map(mapGroupJson) : [];
}

export async function createCloudGroup(name: string): Promise<CloudGroup> {
  const client = requireCloudClient();
  const { data, error } = await client.rpc('create_quiz_group', { p_name: name.trim() });
  if (error) throw new Error(toFriendlyCloudError(error.message));
  return mapGroupJson(data as Record<string, unknown>);
}

export async function createGroupInvite(groupId: string): Promise<{ code: string; expiresAt: string }> {
  const client = requireCloudClient();
  const { data, error } = await client.rpc('create_group_invite', { p_group_id: groupId });
  if (error) throw new Error(toFriendlyCloudError(error.message));
  const value = data as { code?: unknown; expires_at?: unknown };
  if (typeof value?.code !== 'string' || typeof value.expires_at !== 'string') throw new Error('招待コードを作成できませんでした。');
  return { code: value.code, expiresAt: value.expires_at };
}

export async function joinCloudGroup(code: string): Promise<CloudGroup> {
  const client = requireCloudClient();
  const { data, error } = await client.rpc('join_quiz_group', { p_invite_code: code.trim() });
  if (error) throw new Error(toFriendlyCloudError(error.message));
  return mapGroupJson(data as Record<string, unknown>);
}

export async function listGroupProblemSets(groupId: string): Promise<CloudProblemSet[]> {
  const client = requireCloudClient();
  const { data, error } = await client.rpc('list_group_problem_sets', { p_group_id: groupId });
  if (error) throw new Error(toFriendlyCloudError(error.message));
  return Array.isArray(data) ? data.map((item) => mapProblemSetJson(item as Record<string, unknown>)) : [];
}

export async function listCloudGroupMembers(groupId: string): Promise<CloudGroupMember[]> {
  const client = requireCloudClient();
  const { data, error } = await client.rpc('list_quiz_group_members', { p_group_id: groupId });
  if (error) throw new Error(toFriendlyCloudError(error.message));
  if (!Array.isArray(data)) return [];
  return data.map((item) => {
    const value = item as Record<string, unknown>;
    return {
      userId: String(value.user_id ?? ''),
      displayName: String(value.display_name ?? 'Quiz Make ユーザー'),
      role: normalizeGroupRole(value.role),
    };
  });
}

export async function removeCloudGroupMember(groupId: string, userId: string): Promise<void> {
  const client = requireCloudClient();
  const { error } = await client.rpc('remove_quiz_group_member', { p_group_id: groupId, p_user_id: userId });
  if (error) throw new Error(toFriendlyCloudError(error.message));
}

export function buildShareUrl(setId: string, shareToken: string): string {
  const url = new URL(import.meta.env.BASE_URL, window.location.origin);
  url.searchParams.set('sharedSet', setId);
  url.searchParams.set('token', shareToken);
  return url.toString();
}

function requireCloudClient() {
  if (!cloudClient) throw new Error('共有機能の接続設定がまだ完了していません。');
  return cloudClient;
}

function mapProblemSetRow(row: Record<string, unknown>): CloudProblemSet {
  return {
    id: String(row.id ?? ''),
    localSetId: String(row.local_set_id ?? row.localSetId ?? ''),
    ownerId: String(row.owner_id ?? row.ownerId ?? ''),
    authorName: String(row.author_name ?? row.authorName ?? 'Quiz Make ユーザー'),
    title: String(row.title ?? ''),
    description: String(row.description ?? ''),
    subject: String(row.subject ?? ''),
    audience: String(row.audience ?? ''),
    difficulty: String(row.difficulty ?? 'basic'),
    creationMethod: String(row.creation_method ?? row.creationMethod ?? 'manual'),
    source: String(row.source ?? ''),
    visibility: normalizeVisibility(row.visibility),
    questionCount: Number(row.question_count ?? row.questionCount ?? 0),
    addCount: Number(row.add_count ?? row.addCount ?? 0),
    publishedAt: String(row.published_at ?? row.publishedAt ?? ''),
    updatedAt: String(row.updated_at ?? row.updatedAt ?? ''),
  };
}

function mapProblemSetJson(value: Record<string, unknown>): CloudProblemSet {
  const result = mapProblemSetRow(value);
  const questions = value.questions;
  if (Array.isArray(questions)) {
    result.questions = questions.map((item) => {
      const row = item as Record<string, unknown>;
      const answerIndexes = row.answer_indexes ?? row.answerIndexes;
      return {
        question: String(row.question ?? ''),
        choices: Array.isArray(row.choices) ? row.choices.map(String) : [],
        answerIndexes: Array.isArray(answerIndexes)
          ? answerIndexes.map(Number)
          : [],
        answerText: String(row.answer_text ?? row.answerText ?? ''),
        explanation: String(row.explanation ?? ''),
        detailedExplanation: String(row.detailed_explanation ?? row.detailedExplanation ?? ''),
        sourcePage: String(row.source_page ?? row.sourcePage ?? ''),
        category: String(row.category ?? ''),
        difficulty: String(row.difficulty ?? 'basic'),
      };
    });
  }
  return result;
}

function mapGroupJson(value: Record<string, unknown>): CloudGroup {
  return {
    id: String(value.id ?? ''),
    name: String(value.name ?? ''),
    role: normalizeGroupRole(value.role),
    memberCount: Number(value.member_count ?? value.memberCount ?? 1),
    setCount: Number(value.set_count ?? value.setCount ?? 0),
  };
}

function normalizeVisibility(value: unknown): ProblemSetVisibility {
  return value === 'group' || value === 'link' || value === 'public' ? value : 'private';
}

function normalizeGroupRole(value: unknown): CloudGroup['role'] {
  return value === 'owner' || value === 'admin' ? value : 'member';
}

function getInstallationId(): string {
  const key = 'quizMake:cloud:installationId';
  const stored = window.localStorage.getItem(key);
  if (stored && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(stored)) return stored;
  const value = crypto.randomUUID();
  window.localStorage.setItem(key, value);
  return value;
}

function escapeFilterValue(value: string) {
  return value.replace(/[(),.%]/gu, ' ').trim();
}

function toFriendlyCloudError(message: string): string {
  const normalized = message.toLowerCase();
  if (normalized.includes('failed to fetch') || normalized.includes('network')) return '共有サーバーに接続できません。通信状態を確認してください。';
  if (normalized.includes('invalid login') || normalized.includes('email')) return 'メールアドレスを確認してください。';
  if (normalized.includes('not authorized') || normalized.includes('permission') || normalized.includes('row-level security')) return 'この操作を行う権限がありません。';
  if (normalized.includes('invite')) return '招待コードが無効か、期限切れです。';
  if (normalized.includes('does not exist') || normalized.includes('schema cache')) return '共有機能のデータベース準備が完了していません。';
  return message || '共有機能でエラーが発生しました。';
}
