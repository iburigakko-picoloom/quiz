import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PrimaryNavItem } from './PrimaryBottomNav';
import './UsageGuide.css';
const AnswerPanel = lazy(() => import('../screens/QuizRunner').then(module => ({ default: module.AnswerPanel })));
type Demo = 'answer' | 'memo' | 'save';
type Step = { page: PrimaryNavItem; title: string; body: string; target?: string; demo?: Demo };
const steps: Step[] = [
  { page: 'home', title: 'ここから学習を始める', body: 'フォルダを開き、問題セットを選んで解きます。問題やフォルダは「＋」から追加できます。' },
  { page: 'create', target: '[data-guide="create-ai"]', title: 'AIで問題を作る', body: 'ここで依頼文をコピーしてChatGPTなどに送ります。できたJSONファイルはステップ2で取り込みます。' },
  { page: 'home', demo: 'answer', target: '.usage-guide__demo .answer-sheet__detail-open', title: '解いたあと、疑問があったら', body: 'この「解説・メモ」を押します。解答を左へスワイプしても開けます。「次へ」で実際のメモ欄を見てみましょう。' },
  { page: 'home', demo: 'memo', target: '.usage-guide__demo .weakness-composer', title: '知りたいことだけ、ひとこと', body: '「なぜ？」「この言葉の意味は？」などをここに入力します。「図でも知りたい」「表で比較して」も書けます。' },
  { page: 'home', demo: 'save', target: '.usage-guide__demo .weakness-compose-row button', title: 'この矢印でメモを保存', body: '右の「↑」を押すと、この問題に紐づいたメモになります。まだAIの解説は作られません。続いて作成画面へ進みます。' },
  { page: 'create', target: '[data-guide="create-explanation"]', title: 'ためた疑問を、詳しい解説に', body: 'ここで問題セットを選びます。メモがあり、まだ詳細解説がない問題の依頼文をまとめてコピーできます。' },
  { page: 'create', target: '[data-guide="create-explanation"]', title: 'AIの回答は元の問題に戻る', body: '依頼文をChatGPTなどに送り、回答を「AIの回答を取り込む」へ貼り付けます。対応する問題の「解説・メモ」で読めるようになります。' },
  { page: 'create', target: '[data-guide="create-memo"]', title: 'メモから復習問題も作れる', body: '疑問を新しい問題にしたいときはこちら。詳しい説明を読むための「メモから詳細解説を作る」と使い分けます。' },
  { page: 'discover', title: '公開された問題を探す', body: '検索や「条件」で問題を探せます。そのまま解くことも、自分のフォルダへ取り込むこともできます。' },
  { page: 'groups', title: '仲間と問題を共有する', body: 'グループに参加・作成して、問題セットやフォルダを共有できます。共有機能にはログインが必要です。' },
  { page: 'settings', title: 'いつでも見直せます', body: 'この「使い方ガイド」は設定にあります。ログイン・同期・バックアップもここから行えます。' },
];
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
  const [rect, setRect] = useState<DOMRect | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const step = steps[index];
  useEffect(() => {
    const element = dialog.current;
    element?.showModal(); heading.current?.focus();
    return () => element?.close();
  }, []);
  useLayoutEffect(() => {
    let frame = 0;
    let target: Element | null = null;
    const measure = () => {
      const next = document.querySelector(step.target ?? `[data-destination="${step.page}"]`);
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
  }, [step]);
  const move = (next: number) => { onNavigate(steps[next].page); setRect(null); setIndex(next); };
  const cardAtTop = Boolean(step.target && rect && rect.top > window.innerHeight * .42);
  return <dialog ref={dialog} className="usage-guide" aria-labelledby="usage-guide-title" onCancel={event => { event.preventDefault(); onClose(); }}>
    {step.demo && <MemoDemo stage={step.demo} />}
    {rect && <div className="usage-guide__spotlight" aria-hidden="true" style={{ left: rect.left - 3, top: rect.top - 3, width: rect.width + 6, height: rect.height + 6 }} />}
    <section className={`usage-guide__card${cardAtTop ? ' usage-guide__card--top' : ''}`}>
      <header><span>{step.demo ? '練習画面' : '使い方ガイド'} · {index + 1} / {steps.length}</span><button type="button" onClick={onClose} aria-label="ガイドを閉じる">×</button></header>
      <h2 ref={heading} tabIndex={-1} id="usage-guide-title">{step.title}</h2>
      <p>{step.body}</p>
      <footer><button type="button" onClick={() => move(index - 1)} disabled={index === 0}>戻る</button><button type="button" className="usage-guide__next" onClick={() => index === steps.length - 1 ? onClose() : move(index + 1)}>{index === steps.length - 1 ? '完了' : '次へ'}</button></footer>
    </section>
  </dialog>;
}
