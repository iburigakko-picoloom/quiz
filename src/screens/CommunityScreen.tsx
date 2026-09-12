import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Session } from '@supabase/supabase-js';
import type { AppData, ProblemSetVisibility } from '../types';
import { BackButton } from '../components/BackButton';
import { PublicationMenu } from '../components/PublicationMenu';
import { Layout } from '../components/Layout';
import { ChevronRightIcon, ProblemSetIcon, FolderOutlineIcon, GroupIcon, SearchIcon } from '../components/UiIcons';
import { buildGroupProblemSetFolders } from '../utils/groupDataView';
import { PublishPicker } from '../components/PublishPicker';
import { PublicationDetails, publicationPurposes, type PublicationInfo } from '../components/PublicationDetails';
import { SharedLibrary } from '../components/SharedLibrary';
import type { SharedFolderPart } from '../utils/sharedFolders';
import { movePublishedSetFolder } from '../utils/cloudService';
import { writeClipboardText } from '../utils/nativePlatform';
import {
  buildShareUrl,
  cloudConfigured,
  createCloudGroup,
  deleteCloudGroup,
  createGroupInvite,
  getCloudDisplayName,
  getCloudSession,
  getSharedProblemSet,
  joinCloudGroup,
  listCloudGroupMembers,
  listGroupProblemSets,
  listMyGroups,
  listMyPublishedSets,
  listPublicFolderSets,
  listPublicProblemSets,
  onCloudAuthStateChange,
  publishLocalProblemSet,
  recordCloudCopy,
  removeCloudGroupMember,
  reportCloudProblemSet,
  sendMagicLink,
  signOutCloud,
  type CloudGroup,
  type CloudGroupMember,
  type CloudProblemSet,
  type CloudPublishResult,
  unpublishCloudProblemSet,
} from '../utils/cloudService';
import './CommunityScreen.css';

export type CommunityTab = 'mine' | 'groups' | 'discover';

interface CommunityScreenProps {
  groupPage?: 'create' | 'join';
  onGroupPage: (page: 'create' | 'join') => void;
  data: AppData;
  initialTab?: CommunityTab;
  initialSetId?: string;
  initialGroupId?: string;
  shareToken?: string;
  onBack: () => void;
  onCreateProblemSet: () => void;
  onOpenGroup: (groupId: string) => void;
  onOpenLocalSet: (setId: string) => void;
  onCopySharedSet: (set: CloudProblemSet, folderId: string) => Promise<string | null>;
  onPracticeSharedSet: (set: CloudProblemSet) => void;
  onPublished: (localSetId: string, result: CloudPublishResult) => Promise<void>;
  onUnpublished: (localSetId: string) => Promise<void>;
}

export function CommunityScreen({
  groupPage,
  onGroupPage,
  data,
  initialTab = 'mine',
  initialSetId,
  initialGroupId,
  shareToken = '',
  onBack,
  onCreateProblemSet,
  onOpenGroup,
  onOpenLocalSet,
  onCopySharedSet,
  onPracticeSharedSet,
  onPublished,
  onUnpublished,
}: CommunityScreenProps) {
  const [tab, setTab] = useState<CommunityTab>(shareToken ? 'discover' : initialTab);
  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [authMessage, setAuthMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [publicSets, setPublicSets] = useState<CloudProblemSet[]>([]);
  const [publicLoading, setPublicLoading] = useState(false);
  const [publishedSets, setPublishedSets] = useState<CloudProblemSet[]>([]);
  const [groups, setGroups] = useState<CloudGroup[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState(initialGroupId ?? '');
  const [groupMenuOpen, setGroupMenuOpen] = useState(false);
  const [groupSets, setGroupSets] = useState<CloudProblemSet[]>([]);
  const [groupMembers, setGroupMembers] = useState<CloudGroupMember[]>([]);
  const [groupDetailTab, setGroupDetailTab] = useState<'sets' | 'members'>('sets');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<'new' | 'popular'>('new');
  const [audienceFilter, setAudienceFilter] = useState('all');
  const [difficultyFilter, setDifficultyFilter] = useState('all');
  const [conditionDraft, setConditionDraft] = useState<{ sort: 'new' | 'popular'; audience: string; difficulty: string } | null>(null);
  const [shareLocalSetId, setShareLocalSetId] = useState(() => initialSetId && !shareToken && initialTab === 'mine' ? initialSetId : '');
  const [shareVisibility, setShareVisibility] = useState<Exclude<ProblemSetVisibility, 'private'>>('link');
  const [shareGroupIds, setShareGroupIds] = useState<string[]>([]);
  const [shareResult, setShareResult] = useState<{ url: string; visibility: ProblemSetVisibility } | null>(null);
  const [addTarget, setAddTarget] = useState<{ public: boolean; groupIds: string[]; folderPath?: SharedFolderPart[] } | null>(null);
  const [moveTarget, setMoveTarget] = useState<CloudProblemSet | null>(null);
  const [movePath, setMovePath] = useState<SharedFolderPart[]>([]);
  const [moveError, setMoveError] = useState('');
  const moveLock = useRef(false);
  const [addIds, setAddIds] = useState<string[]>([]);
  const [addReview, setAddReview] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<{ sets: CloudProblemSet[]; title: string } | null>(null);
  const [removeError, setRemoveError] = useState('');
  const removeBusyRef = useRef(false);
  const [copyTarget, setCopyTarget] = useState<{ set: CloudProblemSet; token: string } | null>(null);
  const [copyFolderId, setCopyFolderId] = useState('');
  const [copyError, setCopyError] = useState('');
  const copyBusyRef = useRef(false);
  const [publicationInfo, setPublicationInfo] = useState<Record<string, PublicationInfo>>({});
  const detailsFor = (id: string): PublicationInfo => publicationInfo[id] ?? {
    audience: data.problemSets.find((set) => set.id === id)?.audience ?? '',
    description: data.problemSets.find((set) => set.id === id)?.description ?? '',
  };
  const detailsValid = (id: string) => Boolean(detailsFor(id).audience.trim() && detailsFor(id).description.trim() && detailsFor(id).description.length <= 300);
  const renderPublicationDetails = (id: string) => <PublicationDetails value={detailsFor(id)} disabled={busy} onChange={(value) => setPublicationInfo((current) => ({ ...current, [id]: value }))} />;
  const [addResults, setAddResults] = useState<Record<string, string>>({});
  const addBusyRef = useRef(false);
  const addSets = useMemo(() => {
    return data.problemSets.filter((set) => addIds.includes(set.id));
  }, [data.problemSets, addIds]);
  const [directSet, setDirectSet] = useState<CloudProblemSet | null>(null);
  const [detailBackTab, setDetailBackTab] = useState<'discover' | 'groups'>('discover');
  const [newGroupName, setNewGroupName] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [reportTarget, setReportTarget] = useState<CloudProblemSet | null>(null);
  const [reportReason, setReportReason] = useState('incorrect_answer');
  const [reportDetails, setReportDetails] = useState('');
  const publicRequestIdRef = useRef(0);
  const isGroupDetail = Boolean(initialGroupId);
  const isGroupSetDetail = isGroupDetail && Boolean(directSet);
  const isPrimaryRoot = !groupPage && !initialSetId && !initialGroupId && !shareToken && (initialTab === 'discover' || initialTab === 'groups');
  const selectedGroup = groups.find((group) => group.id === selectedGroupId);
  const canManageSelectedGroup = selectedGroup?.role === 'owner' || selectedGroup?.role === 'admin';
  const groupFolders = useMemo(() => buildGroupProblemSetFolders(groupSets), [groupSets]);
  const audienceOptions = useMemo(() => [...new Set([...publicationPurposes, ...publicSets.map((set) => set.audience).filter(Boolean)])], [publicSets]);
  const visiblePublicSets = useMemo(() => publicSets.filter((set) => (
    (audienceFilter === 'all' || set.audience === audienceFilter)
    && (difficultyFilter === 'all' || set.difficulty === difficultyFilter)
  )), [publicSets, audienceFilter, difficultyFilter]);
  const orphanedPublishedSets = useMemo(() => publishedSets.filter((published) => !data.problemSets.some((local) => (
    local.cloudSetId === published.id || local.id === published.localSetId
  ))), [data.problemSets, publishedSets]);

  useEffect(() => {
    let active = true;
    void getCloudSession().then((value) => {
      if (!active) return;
      setSession(value);
      setAuthReady(true);
    });
    const unsubscribe = onCloudAuthStateChange((_event, value) => {
      setSession(value);
      setAuthReady(true);
      if (value) setLoginOpen(false);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!cloudConfigured || tab !== 'discover' || shareToken) return;
    const requestId = ++publicRequestIdRef.current;
    const timer = window.setTimeout(() => {
      setPublicLoading(true);
      setError('');
      void listPublicProblemSets(query, sort)
        .then((nextSets) => {
          if (publicRequestIdRef.current === requestId) setPublicSets(nextSets);
        })
        .catch((reason) => {
          if (publicRequestIdRef.current === requestId) setError(getErrorMessage(reason));
        })
        .finally(() => {
          if (publicRequestIdRef.current === requestId) setPublicLoading(false);
        });
    }, 180);
    return () => {
      window.clearTimeout(timer);
      if (publicRequestIdRef.current === requestId) publicRequestIdRef.current += 1;
    };
  }, [tab, query, sort, shareToken]);

  useEffect(() => {
    let cancelled = false;
    if (!session) {
      setGroups([]);
      setPublishedSets([]);
      return () => {
        cancelled = true;
      };
    }
    void Promise.all([listMyGroups(), listMyPublishedSets()])
      .then(([nextGroups, nextSets]) => {
        if (cancelled) return;
        setGroups(nextGroups);
        setPublishedSets(nextSets);
      })
      .catch((reason) => {
        if (!cancelled) setError(getErrorMessage(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [session]);

  useEffect(() => {
    if (!initialGroupId || !authReady || !session) return;
    let cancelled = false;
    setSelectedGroupId(initialGroupId);
    setBusy(true);
    setError('');
    void Promise.all([listGroupProblemSets(initialGroupId), listCloudGroupMembers(initialGroupId)])
      .then(([nextSets, nextMembers]) => {
        if (cancelled) return;
        setGroupSets(nextSets);
        setGroupMembers(nextMembers);
      })
      .catch((reason) => {
        if (!cancelled) setError(getErrorMessage(reason));
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [authReady, initialGroupId, session]);

  useEffect(() => {
    if (!initialSetId || !shareToken || !cloudConfigured) return;
    setBusy(true);
    setError('');
    void getSharedProblemSet(initialSetId, shareToken)
      .then(setDirectSet)
      .catch((reason) => setError(getErrorMessage(reason)))
      .finally(() => setBusy(false));
  }, [initialSetId, shareToken]);

  useEffect(() => {
    if (!initialSetId || shareToken || initialTab === 'mine' || !cloudConfigured || !authReady || !session) return;
    let cancelled = false;
    setBusy(true);
    setError('');
    void getSharedProblemSet(initialSetId)
      .then((set) => {
        if (!cancelled) {
          setDirectSet(set);
          if (!initialGroupId) setTab('discover');
        }
      })
      .catch((reason) => {
        if (!cancelled) setError(getErrorMessage(reason));
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [authReady, initialGroupId, initialSetId, initialTab, session, shareToken]);

  useEffect(() => {
    if (!initialSetId || shareToken || !authReady || session) return;
    setLoginOpen(true);
  }, [initialSetId, shareToken, authReady, session]);

  useEffect(() => {
    if (!initialGroupId || !authReady || session) return;
    setLoginOpen(true);
  }, [authReady, initialGroupId, session]);

  const requireLogin = () => {
    if (session) return true;
    setLoginOpen(true);
    return false;
  };

  const submitMagicLink = async () => {
    if (!email.trim()) return;
    setBusy(true);
    setError('');
    try {
      const returnSetId = directSet?.id || shareLocalSetId || initialSetId;
      await sendMagicLink(email, {
        name: 'community',
        tab,
        ...(returnSetId ? { shareSetId: returnSetId } : {}),
        ...(initialGroupId ? { groupId: initialGroupId } : {}),
        ...(shareToken ? { shareToken } : {}),
      });
      setAuthMessage('ログイン用リンクをメールへ送りました。この画面に戻るとログインが完了します。');
    } catch (reason) {
      setError(getErrorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  const openShare = (localSetId: string) => {
    setShareLocalSetId(localSetId);
    setShareResult(null);
    if (!requireLogin()) return;
    if (groups.length === 0) setShareVisibility('link');
  };

  const submitShare = async () => {
    if (!shareLocalSetId || !session || !detailsValid(shareLocalSetId)) return;
    if (shareVisibility === 'group' && shareGroupIds.length === 0) {
      setError('共有先のグループを1つ以上選んでください。');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const profileName = await getCloudDisplayName().catch(() => '');
      const result = await publishLocalProblemSet({
        data,
        setId: shareLocalSetId,
        publicationInfo: detailsFor(shareLocalSetId),
        visibility: shareVisibility,
        groupIds: shareGroupIds,
        addDestinations: true,
        authorName: profileName || session.user.user_metadata.display_name || session.user.email?.split('@')[0] || 'Quiz Make ユーザー',
      });
      try {
        await onPublished(shareLocalSetId, result);
      } catch {
        // Adding a destination must never remove an existing publication on local-save failure.
        setError('公開済みですが、端末の状態保存に失敗しました。');
      }
      const url = buildShareUrl(result.id, result.shareToken);
      setShareResult({ url, visibility: result.visibility });
      setPublishedSets(await listMyPublishedSets());
    } catch (reason) {
      setError(getErrorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  const copySharedSet = (summary: CloudProblemSet, token = '') => {
    setCopyFolderId('');
    setCopyError('');
    setCopyTarget({ set: summary, token });
  };
  const confirmCopy = async () => {
    if (!copyTarget || !data.folders.some((folder) => folder.id === copyFolderId) || copyBusyRef.current) return;
    copyBusyRef.current = true;
    const { set: summary, token } = copyTarget;
    setBusy(true);
    setCopyError('');
    try {
      const detail = summary.questions ? summary : await getSharedProblemSet(summary.id, token);
      const localSetId = await onCopySharedSet(detail, copyFolderId);
      if (localSetId) {
        await recordCloudCopy(detail.id, localSetId).catch(() => undefined);
        setDirectSet((current) => current?.id === detail.id ? { ...current, addCount: current.addCount + 1 } : current);
        setPublicSets((items) => items.map((item) => item.id === detail.id ? { ...item, addCount: item.addCount + 1 } : item));
        setCopyTarget(null);
        onOpenLocalSet(localSetId);
      } else {
        setCopyError('取り込めませんでした。保存先と空き容量を確認してください。');
      }
    } catch (reason) {
      setCopyError(getErrorMessage(reason));
    } finally {
      copyBusyRef.current = false;
      setBusy(false);
    }
  };

  const practiceSharedSet = async (summary: CloudProblemSet, token = '') => {
    setBusy(true);
    setError('');
    try {
      const detail = summary.questions ? summary : await getSharedProblemSet(summary.id, token);
      onPracticeSharedSet(detail);
    } catch (reason) {
      setError(getErrorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  const openSharedDetail = async (summary: CloudProblemSet, backTab: 'discover' | 'groups') => {
    setBusy(true);
    setError('');
    try {
      setDirectSet(await getSharedProblemSet(summary.id));
      setDetailBackTab(backTab);
      if (!initialGroupId) setTab('discover');
    } catch (reason) {
      setError(getErrorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  const stopSharing = async (localSetId: string | undefined, cloudSetId: string) => {
    setBusy(true);
    setError('');
    try {
      await unpublishCloudProblemSet(cloudSetId);
      if (localSetId && data.problemSets.some((problemSet) => problemSet.id === localSetId)) {
        await onUnpublished(localSetId);
      }
      setPublishedSets((items) => items.filter((item) => item.id !== cloudSetId));
      setAuthMessage('共有を停止しました。端末内の問題セットは残っています。');
    } catch (reason) {
      setError(getErrorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  const refreshGroups = async () => {
    setGroups(await listMyGroups());
  };

  const createGroup = async () => {
    if (!newGroupName.trim() || !requireLogin()) return;
    setBusy(true);
    setError('');
    try {
      const created = await createCloudGroup(newGroupName);
      setNewGroupName('');
      await refreshGroups();
      onOpenGroup(created.id);
    } catch (reason) {
      setError(getErrorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  const joinGroup = async () => {
    if (!inviteCode.trim() || !requireLogin()) return;
    setBusy(true);
    setError('');
    try {
      const joined = await joinCloudGroup(inviteCode);
      setInviteCode('');
      await refreshGroups();
      onOpenGroup(joined.id);
    } catch (reason) {
      setError(getErrorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  const removeGroupMember = async (member: CloudGroupMember) => {
    if (!selectedGroupId || busy) return;
    if (!window.confirm(member.userId === session?.user.id ? 'グループから退出しますか？ホームに取り込んだ問題は残ります。再参加には招待が必要です。' : `${member.displayName}をグループから外しますか？`)) return;
    setBusy(true);
    setError('');
    try {
      await removeCloudGroupMember(selectedGroupId, member.userId);
      if (member.userId === session?.user.id) {
        setSelectedGroupId('');
        setGroupMembers([]);
        setGroupSets([]);
        await refreshGroups();
        onBack();
      } else {
        setGroupMembers(await listCloudGroupMembers(selectedGroupId));
        await refreshGroups();
      }
    } catch (reason) {
      setError(getErrorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  const deleteSelectedGroup = async () => {
    if (!selectedGroup || selectedGroup.role !== 'owner' || busy) return;
    if (!window.confirm(`「${selectedGroup.name}」を削除しますか？全メンバーが利用できなくなり、招待とグループ内の共有が解除されます。ホームの問題や他の公開先は残ります。この操作は元に戻せません。`)) return;
    setBusy(true); setError('');
    try {
      await deleteCloudGroup(selectedGroup.id);
      setGroupMenuOpen(false); setSelectedGroupId(''); setGroupMembers([]); setGroupSets([]);
      await refreshGroups(); onBack();
    } catch (reason) { setError(getErrorMessage(reason)); }
    finally { setBusy(false); }
  };

  const copyInvite = async (groupId: string) => {
    setBusy(true);
    setError('');
    try {
      const invite = await createGroupInvite(groupId);
      await writeClipboardText(invite.code);
      setAuthMessage(`招待コードをコピーしました。有効期限：${new Date(invite.expiresAt).toLocaleString()}`);
    } catch (reason) {
      setError(getErrorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  const submitReport = async () => {
    if (!reportTarget) return;
    if (!session) {
      setReportTarget(null);
      setLoginOpen(true);
      return;
    }
    setBusy(true);
    setError('');
    try {
      await reportCloudProblemSet(reportTarget.id, reportReason, reportDetails);
      setReportTarget(null);
      setReportDetails('');
      setAuthMessage('通報を受け付けました。');
    } catch (reason) {
      setError(getErrorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  const requestRemove = (sets: CloudProblemSet[], title: string) => {
    if (!session || !sets.length || sets.some((set) => set.ownerId !== session.user.id)) return;
    setRemoveError(''); setRemoveTarget({ sets, title });
  };
  const confirmRemove = async () => {
    if (!removeTarget || removeBusyRef.current || !session) return;
    if (removeTarget.sets.some((set) => set.ownerId !== session.user.id)) return;
    removeBusyRef.current = true; setBusy(true); setRemoveError('');
    const removed = new Set<string>();
    let localWarning = false;
    try {
      for (const set of removeTarget.sets) {
        await unpublishCloudProblemSet(set.id);
        removed.add(set.id);
        const local = data.problemSets.find((item) => item.cloudSetId === set.id || item.id === set.localSetId);
        if (local) await onUnpublished(local.id).catch(() => { localWarning = true; });
      }
      setRemoveTarget(null);
      setAuthMessage(localWarning ? '公開を取り消しました。端末の表示は再読み込みしてください。' : '公開を取り消しました。');
    } catch (reason) {
      setRemoveTarget((current) => current ? { ...current, sets: current.sets.filter((set) => !removed.has(set.id)) } : null);
      setRemoveError(getErrorMessage(reason));
    } finally {
      setPublicSets((items) => items.filter((set) => !removed.has(set.id)));
      setGroupSets((items) => items.filter((set) => !removed.has(set.id)));
      setPublishedSets((items) => items.filter((set) => !removed.has(set.id)));
      setDirectSet((set) => set && removed.has(set.id) ? null : set);
      setBusy(false); removeBusyRef.current = false;
    }
  };


  const moveFolders = [...new Map(publishedSets.filter((set) => set.ownerId === session?.user.id && set.visibility === moveTarget?.visibility).flatMap((set) => (set.folderPath ?? []).map((_, i) => {
    const path = set.folderPath!.slice(0, i + 1);
    return [JSON.stringify(path.map((part) => part.id)), path] as const;
  }))).values()];
  const openMove = async (set: CloudProblemSet) => {
    if (!session || set.ownerId !== session.user.id || busy) return;
    setMoveTarget(set); setMovePath(set.folderPath ?? []); setMoveError(''); setBusy(true);
    try { setPublishedSets(await listMyPublishedSets()); }
    catch (reason) { setMoveError(getErrorMessage(reason)); }
    finally { setBusy(false); }
  };
  const confirmMove = async () => {
    if (!moveTarget || !session || moveTarget.ownerId !== session.user.id || moveLock.current) return;
    moveLock.current = true; setBusy(true); setMoveError('');
    try {
      await movePublishedSetFolder(moveTarget.id, movePath);
      const changed = (items: CloudProblemSet[]) => items.map((set) => set.id === moveTarget.id ? { ...set, folderPath: movePath, updatedAt: new Date().toISOString() } : set);
      setPublicSets(changed); setGroupSets(changed); setPublishedSets(changed);
      setDirectSet((set) => set?.id === moveTarget.id ? { ...set, folderPath: movePath } : set);
      setMoveTarget(null); setAuthMessage('公開先のフォルダを移動しました。');
    } catch (reason) { setMoveError(getErrorMessage(reason)); }
    finally { moveLock.current = false; setBusy(false); }
  };

  const openAdd = (visibility: 'public' | 'group', folderPath?: SharedFolderPart[]) => {
    if (!requireLogin()) return;
    setShareLocalSetId('');
    setAddIds([]);
    setAddReview(false);
    setAddResults({});
    setAddTarget({ public: visibility === 'public', folderPath, groupIds: visibility === 'group' && selectedGroupId ? [selectedGroupId] : [] });
  };

  const submitAdd = async () => {
    if (!session || !addTarget || !addSets.length || addBusyRef.current || !addSets.every((set) => detailsValid(set.id))) return;
    const target = addTarget;
    if (!target.public && !target.groupIds.length) return;
    addBusyRef.current = true;
    setBusy(true);
    const results: Record<string, string> = {};
    try {
      const authorName = await getCloudDisplayName().catch(() => '');
      for (const set of addSets) {
        try {
          const result = await publishLocalProblemSet({ data, setId: set.id, includeFolder: true, folderPath: target.folderPath, publicationInfo: detailsFor(set.id), visibility: target.public ? 'public' : 'group', groupIds: target.groupIds, addDestinations: true, authorName: authorName || 'Quiz Make ユーザー' });
          // A remote success must never be undone merely because local storage failed.
          try { await onPublished(set.id, result); results[set.id] = '公開済み'; }
          catch { results[set.id] = '公開済み（端末の状態保存に失敗）'; }
        } catch (reason) {
          const message = getErrorMessage(reason);
          results[set.id] = `公開失敗：${message}`;
        }
        setAddResults({ ...results });
      }
      try {
        setPublishedSets(await listMyPublishedSets());
        if (selectedGroupId) setGroupSets(await listGroupProblemSets(selectedGroupId));
        setPublicSets(await listPublicProblemSets(query, sort));
      } catch { setError('公開結果は下に表示しています。一覧の更新には再読み込みが必要です。'); }
    } finally { addBusyRef.current = false; setBusy(false); }
  };

  const headerTitle = groupPage ? (groupPage === 'create' ? 'グループを作成' : '招待コードで参加') : isGroupSetDetail
    ? '問題セット'
    : isGroupDetail
      ? selectedGroup?.name ?? 'グループ'
      : tab === 'groups'
        ? 'グループ'
        : tab === 'discover'
          ? '見つける'
          : '問題セット';
  const handleHeaderBack = isGroupSetDetail ? () => setDirectSet(null) : onBack;

  return (
    <Layout>
      <div className={`community-screen${!directSet && ((tab === 'discover' && !isGroupDetail) || isGroupDetail) ? ' community-screen--library-scroll' : ''}${isGroupDetail && !isGroupSetDetail ? ' community-screen--group-library' : ''}`}>
        <header className="community-screen__header">
          {isPrimaryRoot ? <span className="community-screen__header-spacer" aria-hidden="true" /> : <BackButton onClick={handleHeaderBack} label="戻る" />}
          <div><h1>{headerTitle}</h1></div>
          {isGroupDetail && !isGroupSetDetail && selectedGroup ? <div className="community-group-header-actions">{canManageSelectedGroup ? <button type="button" className="community-group-invite" disabled={busy} onClick={() => void copyInvite(selectedGroupId)}>招待</button> : null}<button type="button" className="community-group-invite" aria-label="グループの管理" disabled={busy} onClick={()=>setGroupMenuOpen(true)}>…</button></div> : <span className="community-screen__header-spacer" aria-hidden="true" />}
        </header>

        {!cloudConfigured ? <div className="community-notice community-notice--warning">共有機能の接続設定が未完了です。端末内の作成・学習機能はそのまま使えます。</div> : null}
        {error ? <div className="community-notice community-notice--error" role="alert">{error}<button type="button" onClick={() => setError('')}>閉じる</button></div> : null}
        {authMessage ? <div className="community-notice" role="status">{authMessage}<button type="button" onClick={() => setAuthMessage('')}>閉じる</button></div> : null}

        <main className="community-screen__body">
          {directSet ? <div className="community-detail-toolbar">
            {!isGroupSetDetail && !shareToken ? <button type="button" onClick={() => { setDirectSet(null); setTab(detailBackTab); }}>‹ 一覧へ戻る</button> : <span />}
            {directSet.ownerId === session?.user.id ? <div><span>自分の公開</span><PublicationMenu title={directSet.title} busy={busy} onRemove={() => requestRemove([directSet], directSet.title)} /></div> : null}
          </div> : null}
          {isGroupDetail ? (
            isGroupSetDetail && directSet ? (
              <section className="community-section" aria-label="グループの問題セット詳細">
                <ProblemSetCards
                  sets={[directSet]}
                  busy={busy}
                  onCopy={(set) => void copySharedSet(set)}
                  onPractice={(set) => void practiceSharedSet(set)}
                  onReport={setReportTarget}
                  detailed
                />
              </section>
            ) : (
              <section className="community-section community-group-detail">
                {!session ? (
                  <EmptyState title="ログインが必要です" action="ログイン" onAction={() => setLoginOpen(true)} />
                ) : (
                  <>
                    <div className="qm-group-tabs" data-active-tab={groupDetailTab} role="tablist" aria-label="グループの表示">
                      <button role="tab" aria-selected={groupDetailTab === 'sets'} onClick={() => setGroupDetailTab('sets')}>問題セット {groupSets.length}</button>
                      <button role="tab" aria-selected={groupDetailTab === 'members'} onClick={() => setGroupDetailTab('members')}>メンバー {groupMembers.length}</button>
                    </div>
                    {busy && groupFolders.length === 0 ? <div className="community-loading" role="status">読み込み中…</div> : null}
                    <div hidden={groupDetailTab !== 'sets'} className="community-group-folder-list community-library-scroll" aria-label="グループのフォルダ" tabIndex={0}>
                      <SharedLibrary key={groupSets.map((set) => `${set.id}:${set.updatedAt}`).join('|')} sets={groupSets} userId={session?.user.id} busy={busy} onOpen={(set) => void openSharedDetail(set, 'groups')} onRemove={requestRemove} onMove={(set) => void openMove(set)} onAdd={(path) => openAdd('group', path)} />
                      {!busy && groupFolders.length === 0 ? <EmptyState title="問題セットはまだありません" /> : null}
                    </div>
                    {groupMembers.length > 0 ? (
                      <section hidden={groupDetailTab !== 'members'} className="community-members" aria-label="メンバー">
                        <div className="community-members__list">
                          {[...groupMembers].sort((a,b) => ({owner:0,admin:1,member:2}[a.role] - {owner:0,admin:1,member:2}[b.role])).map((member) => (
                            <div key={member.userId}>
                              <span><strong>{member.displayName}</strong><small>{roleLabel(member.role)}</small></span>
                              {member.role !== 'owner' && member.userId !== session.user.id && canManageSelectedGroup ? (
                                <button type="button" disabled={busy} onClick={() => void removeGroupMember(member)}>メンバーから外す</button>
                              ) : null}
                            </div>
                          ))}
                        </div>
                      </section>
                    ) : null}
                  </>
                )}
                <div className="community-group-publish"><button type="button" disabled={busy || !cloudConfigured} onClick={() => openAdd('group')}>＋ このグループに公開</button></div>
              </section>
            )
          ) : (
          <>
          {tab === 'mine' ? (
            <section className="community-section">
              <div className="community-section__heading">
                <h2>自分の問題セット</h2>
                <button type="button" onClick={onCreateProblemSet}>新規作成</button>
              </div>
              <div className="community-account">
                <span>{!authReady ? '確認中…' : session ? `${session.user.email ?? 'ログイン中'}` : '共有するときだけログイン'}</span>
                {session ? <span className="community-account__actions"><button type="button" onClick={() => void signOutCloud()}>ログアウト</button></span> : <button type="button" onClick={() => setLoginOpen(true)}>ログイン</button>}
              </div>
              <div className="community-card-list">
                {data.problemSets.map((set) => {
                  const count = data.questions.filter((question) => question.setId === set.id).length;
                  const published = publishedSets.find((item) => item.id === set.cloudSetId || item.localSetId === set.id);
                  return (
                    <article key={set.id} className="community-set-card">
                      <button type="button" className="community-set-card__main" onClick={() => onOpenLocalSet(set.id)}>
                        <span className="community-set-card__icon" aria-hidden="true"><ProblemSetIcon size={23} /></span>
                        <span><strong>{set.title}</strong><small>{count}問{set.subject ? ` · ${set.subject}` : ''}</small></span>
                      </button>
                      <div className="community-set-card__actions">
                        <button type="button" onClick={() => openShare(set.id)}>{published ? '更新' : '共有'}</button>
                        {published ? <button type="button" disabled={busy} onClick={() => void stopSharing(set.id, published.id)}>停止</button> : null}
                      </div>
                    </article>
                  );
                })}
                {orphanedPublishedSets.map((published) => (
                  <article key={published.id} className="community-set-card community-set-card--cloud-only">
                    <div className="community-set-card__main">
                      <span className="community-set-card__icon" aria-hidden="true"><ProblemSetIcon size={23} /></span>
                      <span><strong>{published.title}</strong><small>{published.questionCount}問 · クラウドにのみ残っています</small></span>
                    </div>
                    <div className="community-set-card__actions">
                      <button type="button" disabled={busy} onClick={() => void stopSharing(undefined, published.id)}>共有を停止</button>
                    </div>
                  </article>
                ))}
                {data.problemSets.length === 0 ? <EmptyState title="問題セットはまだありません" action="問題セットを作る" onAction={onCreateProblemSet} /> : null}
              </div>
            </section>
          ) : null}

          {tab === 'groups' ? (
            <section className="community-section">
              {!session ? <EmptyState title="グループ機能はログイン後に使えます" action="ログイン" onAction={() => setLoginOpen(true)} /> : (
                <>
                  {groupPage ? <div className="community-group-actions qm-group-form">
                    {groupPage === 'create' ? <>
                    <label>新しいグループ<input value={newGroupName} onChange={(event) => setNewGroupName(event.target.value)} /></label>
                    <button type="button" disabled={busy || !newGroupName.trim()} onClick={() => void createGroup()}>作成</button>
                    </> : <>
                    <label>招待コードで参加<input value={inviteCode} onChange={(event) => setInviteCode(event.target.value.toUpperCase())} /></label>
                    <button type="button" disabled={busy || !inviteCode.trim()} onClick={() => void joinGroup()}>参加</button>
                    </>}
                  </div> : <div className="qm-group-entry">
                    <button className="library-row" onClick={() => onGroupPage('create')}>グループを作成 <ChevronRightIcon size={18} /></button>
                    <button className="library-row" onClick={() => onGroupPage('join')}>招待コードで参加 <ChevronRightIcon size={18} /></button>
                  </div>}
                  <div hidden={Boolean(groupPage)} className="community-card-list">
                    {groups.map((group) => (
                      <article key={group.id} className="community-group-card">
                        <button type="button" className="community-group-card__main" onClick={() => onOpenGroup(group.id)}>
                          <span className="community-group-card__icon" aria-hidden="true"><GroupIcon size={24} /></span>
                          <span><strong>{group.name}</strong><small>{group.memberCount}人 · {group.setCount}セット</small></span>
                          <ChevronRightIcon size={20} />
                        </button>
                      </article>
                    ))}
                  </div>
                </>
              )}
            </section>
          ) : null}

          {tab === 'discover' ? (
            <section className="community-section">
              {directSet ? <ProblemSetCards sets={[directSet]} busy={busy} onCopy={(set) => void copySharedSet(set, shareToken)} onPractice={(set) => void practiceSharedSet(set, shareToken)} onReport={setReportTarget} detailed /> : (
                <>
                  <div className="community-search">
                    <div className="community-search__input"><SearchIcon size={19} /><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="公開問題セットを検索" /></div>
                    <button type="button" className="community-condition-trigger" aria-haspopup="dialog" onClick={() => setConditionDraft({ sort, audience: audienceFilter, difficulty: difficultyFilter })}>条件{audienceFilter !== 'all' || difficultyFilter !== 'all' || sort !== 'new' ? ' •' : ''}</button>
                  </div>
                  <div className="community-section__heading"><h2>公開ライブラリ</h2><button type="button" disabled={busy || !cloudConfigured} onClick={() => openAdd('public')}>＋公開する</button></div>
                  {publicLoading ? <div className="community-notice" role="status">公開問題セットを読み込み中…</div> : null}
                  <div className="community-library-scroll" aria-label="公開ライブラリ" tabIndex={0}>
                  {!publicLoading && !error ? <SharedLibrary key={visiblePublicSets.map((set) => `${set.id}:${set.updatedAt}`).join('|')} sets={visiblePublicSets} userId={session?.user.id} busy={busy} onOpen={(set) => void openSharedDetail(set, 'discover')} onRemove={requestRemove} loadFolder={listPublicFolderSets} onMove={(set) => void openMove(set)} onAdd={(path) => openAdd('public', path)} /> : null}
                  {cloudConfigured && visiblePublicSets.length === 0 && !publicLoading && !error ? <EmptyState title="条件に合うセットはありません" /> : null}
                  </div>
                </>
              )}
            </section>
          ) : null}

          </>
          )}

        </main>



        {conditionDraft ? <CommunityModal ariaLabel="条件" sidePanel onClose={() => setConditionDraft(null)}>
          <header className="community-conditions__header"><button type="button" aria-label="条件を閉じる" onClick={() => setConditionDraft(null)}>×</button><h2>条件</h2><button type="button" onClick={() => setConditionDraft({ sort: 'new', audience: 'all', difficulty: 'all' })}>クリア</button></header>
          <div className="community-conditions__body">
            <section><h3>並び順</h3><div className="community-conditions__chips">{([['new', '新着順'], ['popular', '人気順']] as const).map(([value, label]) => <button type="button" key={value} aria-pressed={conditionDraft.sort === value} onClick={() => setConditionDraft({ ...conditionDraft, sort: value })}>{label}</button>)}</div></section>
            <section><label className="community-conditions__select">対策・用途<select value={conditionDraft.audience} onChange={(event) => setConditionDraft({ ...conditionDraft, audience: event.target.value })}><option value="all">指定しない</option>{audienceOptions.map((purpose) => <option key={purpose} value={purpose}>{purpose}</option>)}</select></label></section>
            <section><h3>難易度</h3><div className="community-conditions__chips">{[['all', '指定しない'], ['basic', '基礎'], ['standard', '標準'], ['advanced', '発展']].map(([value, label]) => <button type="button" key={value} aria-pressed={conditionDraft.difficulty === value} onClick={() => setConditionDraft({ ...conditionDraft, difficulty: value })}>{label}</button>)}</div></section>
          </div>
          <footer className="community-conditions__footer"><button type="button" className="community-primary" onClick={() => { setSort(conditionDraft.sort); setAudienceFilter(conditionDraft.audience); setDifficultyFilter(conditionDraft.difficulty); setConditionDraft(null); }}>この条件で検索</button></footer>
        </CommunityModal> : null}
        {moveTarget ? <CommunityModal ariaLabel="公開先のフォルダを移動" busy={busy} onClose={() => setMoveTarget(null)}>
          <h2>フォルダを移動</h2><p>{moveTarget.title}</p>
          <div className="community-copy-folders" role="radiogroup" aria-label="公開フォルダ">
            {[[], ...moveFolders].map((path) => <label className="community-copy-folder" key={JSON.stringify(path)}>
              <input type="radio" name="published-destination" checked={JSON.stringify(movePath) === JSON.stringify(path)} disabled={busy} onChange={() => setMovePath(path)} />
              <span>{path.length ? path.map((part) => part.name).join(' / ') : 'フォルダの外'}</span>
            </label>)}
          </div>
          {moveError ? <p role="alert">{moveError}</p> : null}
          <div className="community-sheet__actions"><button disabled={busy} onClick={() => setMoveTarget(null)}>キャンセル</button><button className="community-primary" disabled={busy} onClick={() => void confirmMove()}>ここに移動</button></div>
        </CommunityModal> : null}
        {removeTarget ? <CommunityModal ariaLabel="公開を取り消す" busy={busy} onClose={() => setRemoveTarget(null)}>
          <h2>公開を取り消しますか？</h2><p>{removeTarget.title} · {removeTarget.sets.length}セット</p>
          <p>公開先と共有リンクから削除します。ホームの元データと、他の人が取り込んだコピーは残ります。</p>
          {removeError ? <p role="alert">{removeError}</p> : null}
          <div className="community-sheet__actions"><button type="button" disabled={busy} onClick={() => setRemoveTarget(null)}>キャンセル</button><button type="button" className="community-danger" disabled={busy} onClick={() => void confirmRemove()}>{busy ? '取り消し中…' : '公開を取り消す'}</button></div>
        </CommunityModal> : null}
        {groupMenuOpen && selectedGroup ? <CommunityModal ariaLabel="グループの管理" busy={busy} onClose={()=>setGroupMenuOpen(false)}>
          <h2>{selectedGroup.name}</h2>
          {error ? <p role="alert" className="community-notice--error">{error}</p> : null}
          {selectedGroup.role === 'owner' ? <button type="button" className="community-group-danger" disabled={busy} onClick={()=>void deleteSelectedGroup()}>グループを削除</button> : <button type="button" className="community-group-danger" disabled={busy || !groupMembers.some(m=>m.userId===session?.user.id)} onClick={()=>{const member=groupMembers.find(m=>m.userId===session?.user.id);if(member)void removeGroupMember(member);}}>グループから退出</button>}
        </CommunityModal> : null}
        {copyTarget ? <CommunityModal ariaLabel="取り込み先を選択" busy={busy} onClose={() => setCopyTarget(null)}>
          <h2>取り込み先を選択</h2>
          <p>{copyTarget.set.title}</p>
          <div className="community-copy-folders" role="radiogroup" aria-label="保存先フォルダ">
            {data.folders.map((folder) => <label key={folder.id} className="community-copy-folder">
              <input type="radio" name="copy-folder" value={folder.id} checked={copyFolderId === folder.id} disabled={busy} onChange={() => setCopyFolderId(folder.id)} />
              <FolderOutlineIcon size={26} />
              <span>{folder.parentFolderId ? <small>{data.folders.find((parent) => parent.id === folder.parentFolderId)?.name} /</small> : null}{folder.name}</span>
            </label>)}
            {!data.folders.length ? <p>ホームでフォルダを作成してください。</p> : null}
          </div>
          {copyError ? <p role="alert">{copyError}</p> : null}
          <div className="community-sheet__actions"><button type="button" disabled={busy} onClick={() => setCopyTarget(null)}>キャンセル</button><button type="button" className="community-primary" disabled={busy || !data.folders.some((folder) => folder.id === copyFolderId)} onClick={() => void confirmCopy()}>{busy ? '取り込み中…' : 'ここに取り込む'}</button></div>
        </CommunityModal> : null}
        {addTarget ? (
          <CommunityModal ariaLabel="問題セット・フォルダを追加" busy={busy} onClose={() => setAddTarget(null)}>
            <h2>{Object.keys(addResults).length ? busy ? '公開中…' : '公開結果' : addReview ? '公開しますか？' : '公開する問題を選択'}</h2>
            <fieldset disabled={busy || Boolean(Object.keys(addResults).length)} className="community-destinations"><legend>公開先（複数選択可）</legend>
              <label className="community-check"><input type="checkbox" checked={addTarget.public} onChange={(event) => setAddTarget({ ...addTarget, public: event.target.checked })} />全体（見つける）</label>
              {groups.map((group) => <label key={group.id} className="community-check"><input type="checkbox" checked={addTarget.groupIds.includes(group.id)} onChange={(event) => setAddTarget({ ...addTarget, groupIds: event.target.checked ? [...addTarget.groupIds, group.id] : addTarget.groupIds.filter((id) => id !== group.id) })} />{group.name}</label>)}
            </fieldset>
            {addTarget.folderPath ? <p>{addTarget.folderPath.map((part) => part.name).join(' / ')}</p> : null}
            <div hidden={addReview}><PublishPicker data={data} selected={addIds} onChange={setAddIds} /></div>
            {!addReview ? <p aria-live="polite">{addSets.length}セットを選択</p> : null}
            {addReview ? <>
              <div className="community-publication-preview">{addSets.map((set) => <section key={set.id}><strong>{set.title}</strong>{Object.keys(addResults).length ? <p>{addResults[set.id] ?? '公開待ち'}</p> : renderPublicationDetails(set.id)}</section>)}</div>
            </> : null}
            {!Object.keys(addResults).length ? <>
              {addReview ? <p>{addTarget.public ? '全体に公開すると、誰でも閲覧・コピーできます。' : '選択したグループに追加します。'}{addSets.some((set) => set.cloudSetId) ? '既存の公開先も維持します。' : ''}</p> : null}
              <details><summary>公開について</summary><p>フォルダ構成を含めて公開します。学習履歴は公開しません。</p></details>
            </> : null}
            <div className="community-sheet__actions"><button type="button" disabled={busy} onClick={() => { if (addReview && !Object.keys(addResults).length) setAddReview(false); else setAddTarget(null); }}>{Object.keys(addResults).length ? '閉じる' : addReview ? '戻る' : 'キャンセル'}</button>{!Object.keys(addResults).length ? <button type="button" className="community-primary" disabled={busy || !addSets.length || (!addTarget.public && !addTarget.groupIds.length) || (addReview && !addSets.every((set) => detailsValid(set.id)))} onClick={() => { if (!addReview) setAddReview(true); else void submitAdd(); }}>{busy ? '公開中…' : !addReview ? '次へ' : '公開する'}</button> : null}</div>
          </CommunityModal>
        ) : null}
        {loginOpen ? (
          <CommunityModal ariaLabel="ログイン" busy={busy} onClose={() => setLoginOpen(false)}>
              <h2>共有機能にログイン</h2>
              <label>メールアドレス<input data-dialog-autofocus type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" /></label>
              <div className="community-sheet__actions"><button type="button" onClick={() => setLoginOpen(false)}>キャンセル</button><button type="button" className="community-primary" disabled={busy || !email.trim()} onClick={() => void submitMagicLink()}>リンクを送る</button></div>
          </CommunityModal>
        ) : null}

        {shareLocalSetId && session ? (
          <CommunityModal ariaLabel="問題セットを共有" busy={busy} onClose={() => setShareLocalSetId('')}>
              <h2>問題セットを共有</h2>
              <p>{data.problemSets.find((set) => set.id === shareLocalSetId)?.title}</p>
              {!shareResult ? (
                <>
                  <label>公開範囲<select value={shareVisibility} onChange={(event) => setShareVisibility(event.target.value as Exclude<ProblemSetVisibility, 'private'>)}><option value="link">リンクを知っている人</option><option value="public">全体に公開</option><option value="group">グループだけ</option></select></label>
                  {groups.length ? <fieldset><legend>グループにも公開（複数選択可）</legend>{groups.map((group) => <label key={group.id} className="community-check"><input type="checkbox" checked={shareGroupIds.includes(group.id)} onChange={(event) => setShareGroupIds((values) => event.target.checked ? [...values, group.id] : values.filter((id) => id !== group.id))} />{group.name}</label>)}</fieldset> : null}
                  {renderPublicationDetails(shareLocalSetId)}
                  <p>既存の公開先も維持します。</p>
                  <div className="community-sheet__actions"><button type="button" onClick={() => setShareLocalSetId('')}>キャンセル</button><button type="button" className="community-primary" disabled={busy || !detailsValid(shareLocalSetId)} onClick={() => void submitShare()}>{busy ? '共有中…' : '共有する'}</button></div>
                </>
              ) : (
                <>
                  <div className="community-share-result"><strong>共有できました</strong><span>{shareResult.visibility === 'public' ? '「見つける」に公開中' : shareResult.visibility === 'group' || shareGroupIds.length ? '選択したグループに共有中' : 'リンクから閲覧できます'}</span>{shareResult.visibility === 'public' && shareGroupIds.length ? <span>選択したグループにも共有済み</span> : null}</div>
                  <button type="button" className="community-primary" onClick={() => void writeClipboardText(shareResult.url).then(() => setAuthMessage('共有リンクをコピーしました。'))}>共有リンクをコピー</button>
                  <button type="button" onClick={() => setShareLocalSetId('')}>閉じる</button>
                </>
              )}
          </CommunityModal>
        ) : null}

        {reportTarget ? (
          <CommunityModal ariaLabel="問題セットを通報" busy={busy} onClose={() => setReportTarget(null)}>
              <h2>問題セットを通報</h2><p>{reportTarget.title}</p>
              <label>理由<select data-dialog-autofocus value={reportReason} onChange={(event) => setReportReason(event.target.value)}><option value="incorrect_answer">正解が誤っている</option><option value="incorrect_explanation">解説が誤っている</option><option value="unclear_question">問題文が不明確</option><option value="duplicate">重複している</option><option value="copyright">著作権上の問題</option><option value="other">その他</option></select></label>
              <label>詳細（任意）<textarea value={reportDetails} onChange={(event) => setReportDetails(event.target.value)} /></label>
              <div className="community-sheet__actions"><button type="button" onClick={() => setReportTarget(null)}>キャンセル</button><button type="button" className="community-danger" disabled={busy} onClick={() => void submitReport()}>通報する</button></div>
          </CommunityModal>
        ) : null}

      </div>
    </Layout>
  );
}

function CommunityModal({ ariaLabel, busy = false, onClose, children, sidePanel = false }: {
  sidePanel?: boolean;
  ariaLabel: string;
  busy?: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  const busyRef = useRef(busy);
  onCloseRef.current = onClose;
  busyRef.current = busy;

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => {
      const preferred = dialogRef.current?.querySelector<HTMLElement>('[data-dialog-autofocus]');
      const first = dialogRef.current?.querySelector<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])');
      (preferred ?? first ?? dialogRef.current)?.focus();
    });

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (!busyRef.current) onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])',
      ) ?? []);
      if (focusable.length === 0) {
        event.preventDefault();
        dialogRef.current?.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('keydown', handleKeyDown);
      previouslyFocused?.focus();
    };
  }, []);

  return createPortal(
    <div
      className={`community-overlay${sidePanel ? ' community-overlay--conditions' : ''}`}
      role="presentation"
      onMouseDown={(event) => {
        if (!busy && event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className={`community-sheet${sidePanel ? ' community-conditions' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        aria-busy={busy}
        tabIndex={-1}
      >
        {children}
      </section>
    </div>,
    document.body,
  );
}

function ProblemSetCards({ sets, busy, onCopy, onPractice, onDetail, onReport, detailed = false }: { sets: CloudProblemSet[]; busy: boolean; onCopy: (set: CloudProblemSet) => void; onPractice: (set: CloudProblemSet) => void; onDetail?: (set: CloudProblemSet) => void; onReport: (set: CloudProblemSet) => void; detailed?: boolean }) {
  if (!detailed && onDetail) return <div className="community-discovery-list">{sets.map((set) => <button key={set.id} className="community-discovery-row" disabled={busy} onClick={() => onDetail(set)}>
    <span className="library-icon"><ProblemSetIcon /></span>
    <span className="library-row__body"><strong>{set.title}</strong><span>{[set.audience, set.subject, `${set.questionCount}問`].filter(Boolean).join(' · ')}</span></span>
    <ChevronRightIcon size={22} />
  </button>)}</div>;
  return <div className="community-public-list">{sets.map((set) => (
    <article key={set.id} className={`community-public-card${detailed ? ' community-public-card--detail' : ''}`}>
      <div className="community-public-card__top"><div>{set.subject ? <span>{set.subject}</span> : null}<h3>{set.title}</h3></div>{!detailed ? <small>更新 {formatDate(set.updatedAt)}</small> : null}</div>
      {set.audience ? <p>{set.audience}</p> : null}
      {set.description ? <p>{set.description}</p> : null}
      <div className="community-public-card__meta"><span>{set.questionCount}問</span><span>{difficultyLabel(set.difficulty)}</span><span>追加 {set.addCount}</span><span>作成：{set.authorName}</span></div>
      {detailed && set.questions ? <details><summary>問題の内容を確認</summary>{set.questions.slice(0, 5).map((question, index) => <div className="community-question-preview" key={`${index}_${question.question}`}><strong>{index + 1}. {question.question}</strong><span>{question.choices.join(' / ')}</span></div>)}</details> : null}
      <div className="community-public-card__actions"><button type="button" className="community-primary" disabled={busy} onClick={() => onPractice(set)}>このまま解く</button><button type="button" disabled={busy} onClick={() => onCopy(set)}>自分のフォルダにコピー</button></div>
      <div className="community-public-card__minor-actions">{onDetail && !detailed ? <button type="button" onClick={() => onDetail(set)}>詳細を見る</button> : null}<button type="button" onClick={() => onReport(set)}>誤りを報告</button></div>
    </article>
  ))}</div>;
}

function EmptyState({ title, body, action, onAction }: { title: string; body?: string; action?: string; onAction?: () => void }) {
  return <div className="community-empty"><span aria-hidden="true"><ProblemSetIcon size={30} /></span><h3>{title}</h3>{body ? <p>{body}</p> : null}{action && onAction ? <button type="button" className="community-primary" onClick={onAction}>{action}</button> : null}</div>;
}

function formatDate(value: string) {
  if (!value) return '';
  return new Intl.DateTimeFormat('ja-JP', { year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(value));
}

function difficultyLabel(value: string) {
  if (value === 'advanced') return '発展';
  if (value === 'standard') return '標準';
  return '基礎';
}

function roleLabel(value: CloudGroup['role']) {
  if (value === 'owner') return 'オーナー';
  if (value === 'admin') return '管理者';
  return 'メンバー';
}

function getErrorMessage(reason: unknown) {
  return reason instanceof Error ? reason.message : '操作を完了できませんでした。';
}
