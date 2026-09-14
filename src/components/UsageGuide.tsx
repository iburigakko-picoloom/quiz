import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PrimaryNavItem } from './PrimaryBottomNav';
import './UsageGuide.css';
import { UsageGuideExample, type GuideExample } from './UsageGuideExamples';
const AnswerPanel = lazy(() => import('../screens/QuizRunner').then(module => ({ default: module.AnswerPanel })));
type Demo = 'answer' | 'memo' | 'save';
type Step = { page: PrimaryNavItem; title: string; body: string; target?: string; demo?: Demo; example?: GuideExample };
const steps: Step[] = [
  { page: 'home', title: 'ここから学習を始める', body: 'フォルダを開き、問題セットを選んで解きます。問題やフォルダは「＋」から追加できます。' },
  { page: 'create', target: '[data-guide="create-ai"]', title: 'AIで問題を作る', body: 'ここで依頼文をコピーしてChatGPTなどに送ります。できたJSONファイルはステップ2で取り込みます。' },
  { page: 'home', demo: 'answer', target: '.usage-guide__demo .answer-sheet__detail-open', title: '解いたあと、疑問があったら', body: 'この「解説・メモ」を押します。解答を左へスワイプしても開けます。「次へ」で実際のメモ欄を見てみましょう。' },
  { page: 'home', demo: 'memo', target: '.usage-guide__demo .weakness-composer', title: '知りたいことだけ、ひとこと', body: '「なぜ？」「この言葉の意味は？」などをここに入力します。「図でも知りたい」「表で比較して」も書けます。' },
  { page: 'home', demo: 'save', target: '.usage-guide__demo .weakness-compose-row button', title: 'この矢印でメモを保存', body: '右の「↑」を押すと、この問題に紐づいたメモになります。まだAIの解説は作られません。続いて作成画面へ進みます。' },
  { page: 'create', target: '[data-guide="create-explanation"]', title: 'ためた疑問を、詳しい解説に', body: 'ここで問題セットを選びます。メモがあり、まだ詳細解説がない問題の依頼文をまとめてコピーできます。' },
  { page: 'create', example: 'overview', title: '一覧から、未解説の疑問をまとめて依頼', body: '問題セットの「詳細解説一覧」でも、上のボタンからコピーできます。対象はメモがあり、詳細解説がまだない問題です。コピーした端末で回答を取り込んでください。' },
  { page: 'create', example: 'chat-prompt', title: 'ChatGPTに依頼文を貼り付けて送る', body: 'ChatGPTを開き、入力欄を長押しして貼り付け、送信します。問題との紐付け情報も含むので、依頼文は削らずそのまま送ってください。個人情報や共有できない資料を含めないでください。' },
  { page: 'create', example: 'chat-reply', title: '回答は「JSONの枠」からコピー', body: '回答が完成したら、jsonと書かれた枠のコピーを使います。文章だけを選ぶと、強調記号が抜けることがあります。枠がなければ「指定のJSONをコードブロックで返して」と依頼します。' },
  { page: 'create', example: 'import-paste', title: 'Quiz Makeへ戻り、回答を貼り付け', body: '詳細解説一覧の「依頼文をコピー」の横、または作成画面の「AIの回答を取り込む」を開きます。「クリップボードから貼り付け」→「読み取る」。許可されないときは回答欄を長押しして貼り付けてください。' },
  { page: 'create', example: 'import-review', title: '対象と内容を見てから反映', body: '問題名と解説を確認して「確認して○件を反映」を押します。元の問題へ自動で紐付き、既存の解説・画像は残して追記します。対応しない回答と出たら、この端末で依頼文をコピーし直してください。' },
  { page: 'create', example: 'chat-image', title: '図も欲しいときは、ChatGPTに追加で依頼', body: '例えば「この仕組みを矢印の図にして」と頼みます。画像ができたら開いて、端末に保存・ダウンロードしてください。画像はJSONの取り込みだけでは添付されません。' },
  { page: 'home', example: 'images', title: '画像は対象の問題の「解説・メモ」へ', body: '「画像を追加」から保存した画像を選ぶ方法が確実です。「画像を貼り付け」は画像そのものをコピーできる端末で使えます。リンクや共有URLでは貼れません。できない場合は保存して追加してください。' },
  { page: 'home', example: 'read', title: '解説と図を、一緒に読み返せます', body: '追加した画像や表は解説の上部に表示されます。複数ある場合は横にスクロール、画像は2本指で広げたり縮めたりできます。AIの内容は教材とも照らし合わせましょう。' },
  { page: 'create', target: '[data-guide="create-memo"]', title: 'メモから復習問題も作れる', body: '疑問を新しい問題にしたいときはこちら。詳しい説明を読むための「メモから詳細解説を作る」と使い分けます。' },
  { page: 'discover', title: '公開された問題を探す', body: '検索や「条件」で問題を探せます。そのまま解くことも、自分のフォルダへ取り込むこともできます。' },
  { page: 'groups', title: '仲間と問題を共有する', body: 'グループに参加・作成して、問題セットやフォルダを共有できます。共有機能にはログインが必要です。' },
  { page: 'settings', title: 'いつでも見直せます', body: 'この「使い方ガイド」は設定にあります。ログイン・同期・バックアップもここから行えます。' },
];
const chapters = [
  { title: '学習・問題作成', items: [[0, 'ホームから学習する'], [1, 'AIで問題を作る'], [14, 'メモから復習問題を作る']] },
  { title: '疑問をメモする', items: [[2, '解説・メモを開く'], [3, '知りたいことを入力する'], [4, 'メモを保存する']] },
  { title: '詳細解説を作る・取り込む', items: [[5, 'メモから解説を依頼する'], [6, '一覧から依頼文をコピー'], [7, 'ChatGPTに送る'], [8, 'JSONの回答をコピー'], [9, '回答を貼り付ける'], [10, '確認して問題に反映する']] },
  { title: '画像の追加', items: [[11, 'ChatGPTに図を作ってもらう'], [12, '画像を追加・貼り付ける'], [13, '画像と解説を読み返す']] },
  { title: '共有・設定', items: [[15, '公開された問題を探す'], [16, 'グループで共有する'], [17, '設定・同期・バックアップ']] },
] as const;
const noop = () => {};
const saveNothing = async () => {};
function MemoDemo({ stage }: { stage: Demo }) {
  return <div className="usage-guide__demo" inert aria-hidden="true">
    <div className="usage-guide__demo-heading">練習用の問題 · 月の満ち欠け</div>
    <p className="usage-guide__demo-question">月が光って見えるのはなぜ？</p>
    <Suspense fallback={<p>問題画面を読み込み中…</p>}>
      <AnswerPanel questionId="usage-guide-example" guidePage={stage} isCorrect relearned={false} answer="太陽の光を反射しているから" explanation="月は太陽の光を反射して光って見えます。" detailedExplanation="" savedLevelLabel="ガイド用の例・保存されません" answerSaveState="saved" readOnly={false} isAmbiguous={false} isLast={false} state="expanded" onExpand={noop} onDefault={noop} onHide={noop} onToggleAmbiguous={async () => true} onSaveDetailedExplanation={saveNothing} onDetailDirtyChange={noop} onNext={noop} />
    </Suspense>
  </div>;
}
export function UsageGuide({ onNavigate, onClose }: { onNavigate: (page: PrimaryNavItem) => void; onClose: () => void }) {
  const [index, setIndex] = useState(0);
  const [contentsOpen, setContentsOpen] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const currentItem = useRef<HTMLButtonElement>(null);
  const step = steps[index];
  useEffect(() => {
    const element = dialog.current;
    element?.showModal(); heading.current?.focus();
    return () => element?.close();
  }, []);
  useLayoutEffect(() => {
    if (contentsOpen) {
      setRect(null);
      currentItem.current?.focus({ preventScroll: true });
      currentItem.current?.scrollIntoView({ block: 'nearest' });
      return;
    }
    let frame = 0;
    let target: Element | null = null;
    const measure = () => {
      const next = document.querySelector(step.example ? '.usage-guide__example [data-example-target]' : step.target ?? `[data-destination="${step.page}"]`);
      if (next !== target) {
        target = next;
        target?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
      }
      const box = target?.getBoundingClientRect() ?? null;
      setRect(previous => previous?.x === box?.x && previous?.y === box?.y && previous?.width === box?.width && previous?.height === box?.height ? previous : box);
      frame = requestAnimationFrame(measure);
    };
    // Follow lazy loading, sheet slides, scrolling and viewport changes only while open.
    measure(); heading.current?.focus();
    return () => cancelAnimationFrame(frame);
  }, [step, contentsOpen]);
  const move = (next: number) => { onNavigate(steps[next].page); setRect(null); setIndex(next); setContentsOpen(false); };
  const cardAtTop = Boolean(step.target && rect && rect.top > window.innerHeight * .42);
  return <dialog ref={dialog} className={`usage-guide${contentsOpen ? ' usage-guide--contents' : step.example ? ' usage-guide--example' : ''}`} aria-labelledby="usage-guide-title" onCancel={event => { event.preventDefault(); if (contentsOpen) setContentsOpen(false); else onClose(); }}>
    {contentsOpen ? <section className="usage-guide__contents">
      <header><div><span>使い方ガイド</span><h2 id="usage-guide-title">目次</h2></div><button type="button" onClick={() => setContentsOpen(false)} aria-label="目次を閉じて説明に戻る">×</button></header>
      <nav aria-label="ガイドの項目">{chapters.map(chapter => <section key={chapter.title}>
        <h3>{chapter.title}</h3>
        {chapter.items.map(([number, label]) => <button key={number} ref={number === index ? currentItem : undefined} type="button" aria-current={number === index ? 'step' : undefined} onClick={() => move(number)}>
          <span className="usage-guide__item-number" aria-hidden="true">{number + 1}</span><span className="usage-guide__item-label"><span className="sr-only">{number + 1}. </span>{label}</span><small>{number === index ? '表示中' : '›'}</small>
        </button>)}
      </section>)}</nav>
      <footer><button type="button" onClick={() => setContentsOpen(false)}>説明に戻る</button></footer>
    </section> : <>
    {step.example && <UsageGuideExample key={step.example} stage={step.example} />}
    {step.demo && <MemoDemo stage={step.demo} />}
    {rect && <div className="usage-guide__spotlight" aria-hidden="true" style={{ left: rect.left - 3, top: rect.top - 3, width: rect.width + 6, height: rect.height + 6 }} />}
    <section className={`usage-guide__card${cardAtTop ? ' usage-guide__card--top' : ''}`}>
      <header><span>{step.demo ? '練習画面' : '使い方ガイド'} · {index + 1} / {steps.length}</span><div className="usage-guide__header-actions"><button type="button" className="usage-guide__contents-open" onClick={() => setContentsOpen(true)}>目次</button><button type="button" onClick={onClose} aria-label="ガイドを閉じる">×</button></div></header>
      <h2 ref={heading} tabIndex={-1} id="usage-guide-title">{step.title}</h2>
      <p>{step.body}</p>
      {step.example === 'chat-image' && <a className="usage-guide__source" href="https://learn.chatgpt.com/docs/image-generation" target="_blank" rel="noreferrer noopener">ChatGPTの画像機能：公式案内</a>}
      <footer><button type="button" onClick={() => move(index - 1)} disabled={index === 0}>戻る</button><button type="button" className="usage-guide__next" onClick={() => index === steps.length - 1 ? onClose() : move(index + 1)}>{index === steps.length - 1 ? '完了' : '次へ'}</button></footer>
    </section>
    </>}
  </dialog>;
}
