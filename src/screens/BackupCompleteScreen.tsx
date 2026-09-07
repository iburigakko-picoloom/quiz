import { Layout } from '../components/Layout';

export function BackupCompleteScreen({ folderCount, setCount, questionCount, onHome }: {
  folderCount: number; setCount: number; questionCount: number; onHome: () => void;
}) {
  return <Layout><main className="library-page">
    <header className="library-page__header"><h1>読み込み完了</h1></header>
    <p role="status">アプリデータを読み込みました。</p>
    <div className="qm-result-stats">
      <div><strong>{folderCount}</strong><span>フォルダ</span></div>
      <div><strong>{setCount}</strong><span>セット</span></div>
      <div><strong>{questionCount}</strong><span>問題</span></div>
    </div>
    <button className="qm-primary" onClick={onHome}>ホームへ</button>
  </main></Layout>;
}
