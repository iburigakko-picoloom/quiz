import { ExplanationReader } from './WeaknessDetail';

export type GuideExample = 'overview' | 'chat-prompt' | 'chat-reply' | 'import-paste' | 'import-review' | 'chat-image' | 'images' | 'read';
const reply = JSON.stringify({ version: 1, requestId: 'guide-example', explanations: [{ targetId: 'question:guide-moon', body: '月は**太陽の光を反射**しています。太陽・月・地球の位置関係で、明るい部分の見え方が変わります。' }] }, null, 2);

function Diagram() {
  return <figure className="guide-example__diagram"><svg viewBox="0 0 340 120" role="img" aria-label="太陽の光が月で反射して地球に届く説明図">
    <circle cx="43" cy="48" r="25" fill="#e6b54b"/><circle cx="169" cy="48" r="20" fill="#aeb7c3"/><circle cx="297" cy="48" r="23" fill="#5583b0"/>
    <path d="M78 48h57m-9-6 9 6-9 6M199 48h64m-9-6 9 6-9 6" stroke="#586b80" strokeWidth="2" fill="none"/>
    <g textAnchor="middle" fontSize="14" fill="#253449"><text x="43" y="101">太陽</text><text x="169" y="101">月で反射</text><text x="297" y="101">地球へ</text></g>
  </svg><figcaption>説明用の図（例）</figcaption></figure>;
}

/** Non-interactive examples: no clipboard access, network calls, or saved learning data. */
export function UsageGuideExample({ stage }: { stage: GuideExample }) {
  const chat = stage.startsWith('chat-');
  return <div className={`usage-guide__example${chat ? ' usage-guide__example--chat' : ''}`} inert>
    <div className="guide-example__app"><strong>{chat ? 'ChatGPT' : 'Quiz Make'}</strong><span>操作例・保存されません</span></div>
    {chat && <p className="guide-example__notice">説明用に再現した画面です。実際の表示・ボタン名は端末や版で異なります。</p>}
    {stage === 'overview' && <><h3>詳細解説一覧</h3><p>月の満ち欠け</p><div className="guide-example__paired-actions"><button className="guide-example__action" data-example-target>依頼文をコピー</button><button className="guide-example__action">AIの回答を取り込む</button></div><div className="guide-example__memo"><small>保存した疑問</small><p>なぜ月の形は毎日変わって見えるの？</p></div></>}
    {stage === 'chat-prompt' && <><div className="guide-example__bubble">Quiz Makeでコピーした依頼文を、そのまま貼り付けます。</div><div className="guide-example__compose" data-example-target><p>保存した疑問に答えてください。<br/>指定したJSON形式で返してください。<br/>【参考データ】…</p><span>＋</span><b>↑</b></div><small>依頼文は表示例のため省略しています。</small></>}
    {stage === 'chat-reply' && <><p>回答が最後まで出たら、JSONの枠をコピーします。</p><div className="guide-example__code"><header><span>json</span><button data-example-target>コピー</button></header><pre>{reply}</pre></div></>}
    {stage === 'import-paste' && <><h3>AIの回答を取り込む</h3><div className="guide-example__tabs"><strong>貼り付け</strong><span>確認</span></div><button className="guide-example__action" data-example-target>クリップボードから貼り付け</button><pre className="guide-example__input">{reply}</pre><button className="guide-example__action">読み取る</button></>}
    {stage === 'import-review' && <><h3>AIの回答を取り込む</h3><div className="guide-example__tabs"><span>貼り付け</span><strong>確認</strong></div><p>1件を確認</p><div className="guide-example__memo"><strong>月が光って見えるのはなぜ？</strong><ExplanationReader text="月は**太陽の光を反射**しています。"/></div><button className="guide-example__action guide-example__action--primary" data-example-target>確認して1件を反映</button></>}
    {stage === 'chat-image' && <><div className="guide-example__bubble">月が光る仕組みを、太陽・月・地球と矢印を使った図にしてください。</div><Diagram/><div className="guide-example__image-menu" data-example-target>画像を開く → 保存・ダウンロード</div></>}
    {stage === 'images' && <><h3>解説・メモ</h3><ExplanationReader text="月は**太陽の光を反射**しています。"/><div className="weakness-image-actions" data-example-target><button className="weakness-button">画像を追加</button><button className="weakness-button">画像を貼り付け</button></div><div className="guide-example__memo"><p>画像を追加：保存した写真・ファイルを選ぶ</p><p>画像を貼り付け：コピーした画像そのものを使う</p></div></>}
    {stage === 'read' && <><h3>解説・メモ</h3><div data-example-target><Diagram/></div><ExplanationReader text="月は**太陽の光を反射**しています。太陽・月・地球の位置関係で、明るい部分の見え方が変わります。"/></>}
  </div>;
}
