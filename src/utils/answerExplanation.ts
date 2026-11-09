import { normalizeExplanationMarkdown } from './explanationMarkdown';

const key = (value: string) => value.trim().replace(/\s+/gu, ' ');
const fixedHeading = /^(重要事項|解説|ポイント|ポイントまとめ|選択肢の検討)$/u;

/** Display-only adaptation: stored Markdown and old backups remain unchanged.
 * Match choice text, never a displayed index (choices can be randomized). */
export function splitAnswerExplanation(text: string, knownChoices: readonly string[]) {
  const known = new Set(knownChoices.map(key));
  const important: string[] = [], reasons = new Map<string, string>();
  let target: string | null = null, block: string[] = [], fence = '', legacyTitle = '';
  const flush = () => {
    let body = block.join('\n').trim();
    if (legacyTitle) body = body && !/^(?:[-*+]\s|[0-9]+[.)]\s|[|>`~])/u.test(body) ? `${legacyTitle}：${body}` : `${legacyTitle}。\n\n${body}`;
    if (target && known.has(target)) reasons.set(target, [reasons.get(target), body].filter(Boolean).join('\n\n'));
    else if (body) important.push(body);
    block = []; target = null; legacyTitle = '';
  };
  for (const line of normalizeExplanationMarkdown(text).split('\n')) {
    const code = line.match(/^\s*(`{3,}|~{3,})/);
    if (code) { if (!fence) fence = code[1][0]; else if (fence === code[1][0]) fence = ''; block.push(line); continue; }
    if (fence) { block.push(line); continue; }
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (!heading) { if (!fixedHeading.test(line.trim().replace(/^\*\*(.*?)\*\*$/, '$1').replace(/[：:]$/, ''))) block.push(line); continue; }
    const title = heading[1].replace(/^\*\*(.*?)\*\*$/, '$1');
    const choice = title.match(/^選択肢\s*[：:]\s*(.+)$/u);
    if (choice) {
      flush(); target = key(choice[1]);
      if (!known.has(target)) block.push(choice[1]);
    } else {
      flush();
      // Retain meaningful legacy titles as prose, not nested decorative headings.
      if (!fixedHeading.test(title)) legacyTitle = title;
    }
  }
  flush();
  return { important: important.join('\n\n').trim(), reasons };
}

export function choiceReason(reasons: Map<string,string>, choice: string) { return reasons.get(key(choice)) ?? ''; }

export const ANSWER_EXPLANATION_INSTRUCTIONS = `【解説の共通形式】
explanationは従来どおり1本のMarkdown文字列です。冒頭には問題全体の理解に必要な概念・病態生理・判断条件を本文だけで書いてください。「重要事項」「選択肢の検討」はUIが表示する固定見出しなので生成しません。問題固有の装飾見出しや「ポイント」欄も生成しません。
続けてchoicesとdistractorsの各語句について、必ず「### 選択肢：選択肢本文と完全に同じ文字列」の行、その次の行にその選択肢が正しい／誤っている根拠を書いてください。番号・○×・「理由」というラベルは付けません。正誤表示にはanswerIndex/answerIndexesが使われます。選択肢本文に改行は入れないでください。
冒頭の概念説明と個別の根拠は重複させず、各根拠は必要な長さで簡潔にします。根拠が不明な選択肢は作らず、原文の不明点は明記します。
重要事項と各根拠の重要語（疾患・構造・病態・検査・治療など）を必要な箇所だけ**太字**で囲んでください。赤寄りのオレンジ色で表示されます。文章全体や重要でない語は強調しません。HTMLや色指定タグは禁止です。JSONの改行は\\nで表します。`;

export function exampleAnswerExplanation(choices: string[], distractors: string[] = []) {
  return '問題全体の理解に必要な**重要な条件**を説明します。\n\n'
    + [...choices,...distractors].map(choice => `### 選択肢：${choice}\nこの選択肢の正誤を分ける**判断条件**を具体的に説明します。`).join('\n\n');
}
