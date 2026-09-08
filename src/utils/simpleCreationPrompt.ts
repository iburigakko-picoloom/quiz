export function buildSimpleCreationPrompt(request: string): string {
  return `Quiz Make用の問題集を作成してください。
依頼：${request.trim()}

指定がなければ標準レベルの20問・4択にしてください。単語問題は語義が一意になる短い文脈を添え、多義語・同義語が複数正解にならないようにしてください。根拠が曖昧な問題や架空の出典は作らないでください。
出力は次の構造のJSONのみ（コードフェンス不要）。
{"setTitle":"問題集名","source":"","questions":[{"question":"問題文","choices":["正解","誤答1","誤答2","誤答3"],"answerIndex":0,"distractors":["追加誤答1","追加誤答2","追加誤答3","追加誤答4","追加誤答5","追加誤答6"],"shuffleChoices":true,"explanation":"正解の根拠と混同しやすい点","category":"分類"}]}
choicesは4個または5個。answerIndexは0始まり。複数正解はanswerIndexの代わりにanswerIndexes配列を使う。
distractorsには各問で明確に不正解になる追加候補を6〜12個（最大50個）作る。正解・同義語・choicesとの重複は禁止。選択肢の長さと文体をそろえる。十分な誤答を確実に作れない問題では無理に増やさない。
Quiz Makeが正解を必ず残し、誤答候補から必要数を抽選して位置も並べ替える。問題文・解説で選択肢番号や「上記すべて」を参照せず、語句そのものを使う。語句の内部の文字順は変えない。
全問の正解、誤答候補、JSON形式を確認してから出力する。`;
}
