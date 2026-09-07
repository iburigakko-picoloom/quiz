import { useEffect, useRef, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Layout } from '../components/Layout';
import { BackButton } from '../components/BackButton';
import { isAnswerSoundEnabled, setAnswerSoundEnabled, prepareAnswerAudio, playAnswerFeedback } from '../utils/answerFeedback';
import {
  ChevronRightIcon,
  DocumentOutlineIcon,
  DownloadIcon,
  ProfileIcon,
  SyncIcon,
  TrashIcon,
  UploadIcon,
} from '../components/UiIcons';
import {
  cloudConfigured,
  deleteCloudAccount,
  getCloudDisplayName,
  getCloudSession,
  onCloudAuthStateChange,
  sendMagicLink,
  signOutCloud,
  updateCloudDisplayName,
} from '../utils/cloudService';
import './SettingsScreen.css';

interface SettingsScreenProps {
  page?: 'account' | 'transfer' | 'backups' | 'logout';
  onNavigate: (page: 'account' | 'transfer' | 'backups' | 'logout') => void;
  onBack: () => void;
  onExport: () => void;
  onImportBackup: (file: File) => Promise<string | null>;
  onClearAll: () => Promise<boolean>;
  onOpenSync: () => void;
  onOpenPrivacy: () => void;
}

export function SettingsScreen({ page, onNavigate, onBack, onExport, onImportBackup, onClearAll, onOpenSync, onOpenPrivacy }: SettingsScreenProps) {
  const [sound, setSound] = useState(isAnswerSoundEnabled);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [message, setMessage] = useState('');
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const [clearBusy, setClearBusy] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(!cloudConfigured);
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [accountBusy, setAccountBusy] = useState(false);
  const [accountMessage, setAccountMessage] = useState('');
  const [accountError, setAccountError] = useState('');
  const [deleteAccountConfirmOpen, setDeleteAccountConfirmOpen] = useState(false);

  useEffect(() => {
    if (!cloudConfigured) return;
    let active = true;
    const applySession = async (value: Session | null) => {
      if (!active) return;
      setSession(value);
      setAuthReady(true);
      if (!value) {
        setDisplayName('');
        return;
      }
      const fallback = value.user.email?.split('@')[0] ?? 'Quiz Make ユーザー';
      try {
        const storedName = await getCloudDisplayName();
        if (active) setDisplayName(storedName || fallback);
      } catch {
        if (active) setDisplayName(fallback);
      }
    };
    void getCloudSession().then((value) => void applySession(value));
    const unsubscribe = onCloudAuthStateChange((_event, value) => void applySession(value));
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const sendLoginLink = async () => {
    if (!email.trim()) return;
    setAccountBusy(true);
    setAccountError('');
    try {
      await sendMagicLink(email, { name: 'settings' });
      setAccountMessage('ログイン用リンクを送信しました。メールを確認してください。');
    } catch (reason) {
      setAccountError(getErrorMessage(reason));
    } finally {
      setAccountBusy(false);
    }
  };

  const saveDisplayName = async () => {
    if (!displayName.trim()) return;
    setAccountBusy(true);
    setAccountError('');
    try {
      await updateCloudDisplayName(displayName);
      setDisplayName(displayName.trim());
      setAccountMessage('表示名を更新しました。');
    } catch (reason) {
      setAccountError(getErrorMessage(reason));
    } finally {
      setAccountBusy(false);
    }
  };

  const logout = async () => {
    setAccountBusy(true);
    setAccountError('');
    try {
      await signOutCloud();
      setSession(null);
      setAccountMessage('ログアウトしました。端末内の問題と学習履歴は残っています。');
    } catch (reason) {
      setAccountError(getErrorMessage(reason));
    } finally {
      setAccountBusy(false);
    }
  };

  const deleteAccount = async () => {
    setAccountBusy(true);
    setAccountError('');
    try {
      await deleteCloudAccount();
      setSession(null);
      setDeleteAccountConfirmOpen(false);
      setAccountMessage('ログインアカウントと関連するクラウドデータを削除しました。端末内の問題と学習履歴は残っています。');
    } catch (reason) {
      setAccountError(getErrorMessage(reason));
    } finally {
      setAccountBusy(false);
    }
  };

  const importBackup = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const error = await onImportBackup(file);
    setMessage(error ?? '');
  };

  const clearAllData = async () => {
    if (clearBusy) return;
    setClearBusy(true);
    const cleared = await onClearAll();
    setClearBusy(false);
    setClearConfirmOpen(false);
    if (!cleared) setMessage('データを削除できませんでした。画面の案内を確認して、もう一度お試しください。');
  };

  return (
    <Layout>
      <div className="settings-screen">
        <header className="settings-screen__header">
          {page ? <BackButton onClick={onBack} /> : null}
          <h1>{page === 'account' ? 'アカウント' : page === 'transfer' ? 'インポート・エクスポート' : page === 'backups' ? 'バックアップ' : page === 'logout' ? 'ログアウト' : '設定'}</h1>
        </header>

        <main className="settings-screen__body">
          {!page ? <>
            <SettingsRow icon={<ProfileIcon />} title={session ? displayName || 'アカウント' : '未ログイン'} detail={session ? 'ログイン中' : undefined} arrow onClick={() => onNavigate('account')} />
            <section className="settings-section"><div className="settings-section__heading"><h2>学習</h2></div>
              <label className="settings-row"><span className="settings-row__icon"><DocumentOutlineIcon /></span><span className="settings-row__text"><strong>解答効果音</strong></span><input type="checkbox" role="switch" checked={sound} onChange={(event) => { try { setAnswerSoundEnabled(event.target.checked); setSound(event.target.checked); setMessage(''); if (event.target.checked) { prepareAnswerAudio(); playAnswerFeedback('correct'); } } catch { setMessage('設定を保存できませんでした。'); } }} /></label>
            </section>
            <section className="settings-section"><div className="settings-section__heading"><h2>データ</h2></div>
              <SettingsRow icon={<SyncIcon />} title="同期" arrow onClick={onOpenSync} />
              <SettingsRow icon={<DownloadIcon />} title="バックアップ" arrow onClick={() => onNavigate('backups')} />
              <SettingsRow icon={<UploadIcon />} title="インポート・エクスポート" arrow onClick={() => onNavigate('transfer')} />
            </section>
          </> : null}
          {page === 'account' ? <>
          <section className="settings-section" aria-labelledby="settings-account-title">
            <div className="settings-section__heading">
              <h2 id="settings-account-title">アカウント</h2>
            </div>
            <div className="settings-account">
              <span className="settings-account__icon" aria-hidden="true"><ProfileIcon /></span>
              {!cloudConfigured ? (
                <div className="settings-account__content"><strong>共有機能は現在利用できません</strong><small>端末内の問題作成・学習・バックアップはそのまま使えます。</small></div>
              ) : !authReady ? (
                <div className="settings-account__content"><strong>アカウントを確認中…</strong></div>
              ) : session ? (
                <div className="settings-account__content">
                  <strong>{session.user.email ?? 'ログイン中'}</strong>
                  <label className="settings-account__field"><span>共有時の表示名</span><input value={displayName} maxLength={40} onChange={(event) => setDisplayName(event.target.value)} /></label>
                  <div className="settings-account__actions">
                    <button type="button" className="settings-account__primary" disabled={accountBusy || !displayName.trim()} onClick={() => void saveDisplayName()}>表示名を保存</button>
                    <button type="button" disabled={accountBusy} onClick={() => void logout()}>ログアウト</button>
                  </div>
                  <button type="button" className="settings-account__delete" disabled={accountBusy} onClick={() => setDeleteAccountConfirmOpen(true)}>ログインアカウントを削除</button>
                </div>
              ) : (
                <div className="settings-account__content">
                  <strong>未ログイン</strong>
                  <label className="settings-account__field"><span>メールアドレス</span><input type="email" value={email} autoComplete="email" onChange={(event) => setEmail(event.target.value)} /></label>
                  <button type="button" className="settings-account__primary" disabled={accountBusy || !email.trim()} onClick={() => void sendLoginLink()}>{accountBusy ? '送信中…' : 'ログイン用リンクを送る'}</button>
                </div>
              )}
            </div>
            {accountMessage ? <p className="settings-account__notice" role="status">{accountMessage}</p> : null}
            {accountError ? <p className="settings-account__notice settings-account__notice--error" role="alert">{accountError}</p> : null}
          </section>

          <SettingsRow icon={<SyncIcon />} title="同期" arrow onClick={onOpenSync} />
          </> : null}

          {page === 'transfer' || page === 'backups' ? <>
          <section className="settings-section" aria-labelledby="settings-data-title">
            <div className="settings-section__heading"><h2 id="settings-data-title">データ管理</h2></div>
            <SettingsRow icon={<UploadIcon />} title="アプリデータを読み込む" onClick={() => fileInputRef.current?.click()} />
            <SettingsRow icon={<DownloadIcon />} title="アプリデータを書き出す" onClick={onExport} />
            <p>問題セットJSONの登録は「作成」から行います</p>
          </section>
          </> : null}

          {!page ? <>
          <section className="settings-section" aria-labelledby="settings-info-title">
            <div className="settings-section__heading"><h2 id="settings-info-title">アプリ情報</h2></div>
            <SettingsRow icon={<DocumentOutlineIcon />} title="プライバシーポリシー" arrow onClick={onOpenPrivacy} />
          </section>
          </> : null}

          {page === 'transfer' ? <details><summary>その他の操作</summary>
          <section className="settings-section settings-section--danger" aria-labelledby="settings-danger-title">
            <div className="settings-section__heading">
              <h2 id="settings-danger-title">データの削除</h2>
              <p>実行すると端末内の学習データを元に戻せません。先にバックアップしてください。</p>
            </div>
            <SettingsRow icon={<TrashIcon />} title="端末の学習データを削除" detail="フォルダ・問題・履歴・ノートを消去" danger onClick={() => setClearConfirmOpen(true)} />
          </section>
          </details> : null}

          {message ? <div className={message.includes('失敗') ? 'settings-screen__notice settings-screen__notice--error' : 'settings-screen__notice'} role="status">{message}</div> : null}
        </main>

        <input ref={fileInputRef} type="file" accept="application/json,.json" className="settings-screen__file-input" onChange={(event) => void importBackup(event)} />

        <ConfirmDialog
          open={clearConfirmOpen}
          title="端末の学習データを削除しますか？"
          message="フォルダ、問題セット、問題、回答記録、復習Level、曖昧登録、カテゴリーノートをこの端末から削除します。クラウド上の同期データを守るため自動同期はOFFになります。同期接続とクラウド上のデータは削除されません。この操作は元に戻せません。"
          confirmLabel={clearBusy ? '削除中…' : '学習データを削除'}
          busy={clearBusy}
          onCancel={() => setClearConfirmOpen(false)}
          onConfirm={() => void clearAllData()}
        />
        <ConfirmDialog
          open={deleteAccountConfirmOpen}
          title="ログインアカウントを削除しますか？"
          message="公開した問題セット、グループ、端末間同期データなど、このアカウントに関連するクラウドデータを削除します。端末内の問題セット、回答履歴、復習状態は削除されません。"
          confirmLabel={accountBusy ? '削除中…' : 'アカウントを削除'}
          busy={accountBusy}
          onCancel={() => setDeleteAccountConfirmOpen(false)}
          onConfirm={() => void deleteAccount()}
        />
      </div>
    </Layout>
  );
}

function getErrorMessage(reason: unknown) {
  return reason instanceof Error ? reason.message : '操作に失敗しました。時間をおいてもう一度お試しください。';
}

function SettingsRow({ icon, title, detail, state, arrow = false, danger = false, onClick }: {
  icon: React.ReactNode;
  title: string;
  detail?: string;
  state?: string;
  arrow?: boolean;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" className={danger ? 'settings-row settings-row--danger' : 'settings-row'} onClick={onClick}>
      <span className="settings-row__icon" aria-hidden="true">{icon}</span>
      <span className="settings-row__text"><strong>{title}</strong>{detail ? <small>{detail}</small> : null}</span>
      {state ? <span className="settings-row__state">{state}</span> : null}
      {arrow ? <ChevronRightIcon size={19} /> : null}
    </button>
  );
}
