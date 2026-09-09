export interface CreationPromptOptions { choiceCount: 4 | 5; questionCount: number; allowMultiple: boolean }

export function applyCreationConditions(template: string, options: CreationPromptOptions): string {
  if (![4, 5].includes(options.choiceCount) || !Number.isInteger(options.questionCount) || options.questionCount < 1 || options.questionCount > 2000) throw new Error('invalid creation conditions');
  return `${template}\n\n【今回の作成条件：上記の既定値・例より優先】\n問題数：${options.questionCount}問。各問のchoicesは必ず${options.choiceCount}個（${options.choiceCount}択）。追加の誤答候補はchoicesとは別に管理してください。\n${options.allowMultiple ? '複数回答の問題を含めても構いません。複数回答ではanswerIndexesを使い、正解は2個以上かつ選択肢数未満にし、問題文に「すべて選べ」と明示してください。単一回答も使用できます。' : '全問を単一回答にしてください。正解は必ず1個で、answerIndexを使用してください。複数回答問題は作らないでください。'}\n資料に根拠が足りない場合は捏造して問題数を埋めないでください。`;
}

export function buildSimpleCreationPrompt(request: string, options: CreationPromptOptions = { choiceCount: 4, questionCount: 20, allowMultiple: false }): string {
  return `Quiz Make用の問題集を作成してください。
依頼：${request.trim()}

標準レベルの${options.questionCount}問・${options.choiceCount}択にしてください。単語問題は語義が一意になる短い文脈を添え、多義語・同義語による意図しない複数正解を避けてください。根拠が曖昧な問題や架空の出典は作らないでください。
出力は次の構造のJSONのみ（コードフェンス不要）。
{"setTitle":"問題集名","source":"","questions":[{"question":"問題文","choices":${JSON.stringify(['正解', ...Array.from({ length: options.choiceCount - 1 }, (_, i) => `誤答${i + 1}`)])},"answerIndex":0,"distractors":["追加誤答1","追加誤答2","追加誤答3","追加誤答4","追加誤答5","追加誤答6"],"shuffleChoices":true,"explanation":"正解の根拠と混同しやすい点","category":"分類"}]}
choicesは${options.choiceCount}個。answerIndexは0始まり。${options.allowMultiple ? '複数正解も可。answerIndexの代わりにanswerIndexes配列を使い、すべて選べと明示する。' : '正解は必ず1個。複数回答問題は作らない。'}
distractorsには各問で明確に不正解になる追加候補を6〜12個（最大50個）作る。正解・同義語・choicesとの重複は禁止。選択肢の長さと文体をそろえる。十分な誤答を確実に作れない問題では無理に増やさない。
Quiz Makeが正解を必ず残し、誤答候補から必要数を抽選して位置も並べ替える。問題文・解説で選択肢番号や「上記すべて」を参照せず、語句そのものを使う。語句の内部の文字順は変えない。
全問の正解、誤答候補、JSON形式を確認してから出力する。`;
}
