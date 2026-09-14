import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PrimaryNavItem } from './PrimaryBottomNav';
import './UsageGuide.css';

const steps: { page: PrimaryNavItem; title: string; body: string }[] = [
  { page: 'home', title: 'ここから学習を始める', body: 'フォルダを開き、問題セットを選んで解きます。問題やフォルダは「＋」から追加できます。' },
  { page: 'create', title: 'AIで問題を作る', body: '「生成AIで作る」で依頼文をコピーし、ChatGPTなどに送ります。できたJSONファイルをステップ2で取り込みます。' },
  { page: 'create', title: '疑問をメモして、詳しい解説に', body: '問題を解いているときの「解説・メモ」に疑問を残します。「メモから詳細解説を作る」でAIへの依頼をコピーし、回答を取り込むと元の問題に紐づきます。' },
  { page: 'discover', title: '公開された問題を探す', body: '検索や「条件」で問題を探せます。そのまま解くことも、自分のフォルダへ取り込むこともできます。' },
  { page: 'groups', title: '仲間と問題を共有する', body: 'グループに参加・作成して、問題セットやフォルダを共有できます。共有機能にはログインが必要です。' },
  { page: 'settings', title: '設定とデータの管理', body: 'ログイン、同期、バックアップはここから。このガイドも「使い方ガイド」からいつでも見直せます。' },
];

export function UsageGuide({ onNavigate, onClose }: { onNavigate: (page: PrimaryNavItem) => void; onClose: () => void }) {
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const step = steps[index];
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    heading.current?.focus();
    return () => element?.close();
  }, []);
  useLayoutEffect(() => {
    const measure = () => setRect(document.querySelector(`[data-destination="${step.page}"]`)?.getBoundingClientRect() ?? null);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(document.documentElement);
    window.addEventListener('resize', measure);
    heading.current?.focus();
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); };
  }, [step.page, index]);
  const move = (next: number) => { onNavigate(steps[next].page); setIndex(next); };
  return <dialog ref={dialog} className="usage-guide" aria-labelledby="usage-guide-title" onCancel={event => { event.preventDefault(); onClose(); }}>
    {rect && <div className="usage-guide__spotlight" aria-hidden="true" style={{ left: rect.left - 3, top: rect.top - 3, width: rect.width + 6, height: rect.height + 6 }} />}
    <section className="usage-guide__card">
      <header><span>使い方ガイド · {index + 1} / {steps.length}</span><button type="button" onClick={onClose} aria-label="ガイドを閉じる">×</button></header>
      <h2 ref={heading} tabIndex={-1} id="usage-guide-title">{step.title}</h2>
      <p>{step.body}</p>
      <footer><button type="button" onClick={() => move(index - 1)} disabled={index === 0}>戻る</button><button type="button" className="usage-guide__next" onClick={() => index === steps.length - 1 ? onClose() : move(index + 1)}>{index === steps.length - 1 ? '完了' : '次へ'}</button></footer>
    </section>
  </dialog>;
}
