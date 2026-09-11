import type { ImportedProblemSet, ImportedQuestion } from '../types';

type ValidationResult = { ok: true; value: ImportedProblemSet } | { ok: false; errors: string[] };

export const IMPORT_RESOURCE_LIMITS = {
  maxFiles: 20,
  maxFileBytes: 8 * 1024 * 1024,
  maxTotalFileBytes: 24 * 1024 * 1024,
  maxJsonCharacters: 12 * 1024 * 1024,
  maxQuestions: 2_000,
  setTitle: 300,
  source: 5_000,
  id: 200,
  question: 20_000,
  choice: 10_000,
  answerText: 50_000,
  explanation: 100_000,
  detailedExplanation: 250_000,
  sourcePage: 5_000,
  category: 300,
  difficulty: 100,
} as const;

export interface ImportFileDescriptor {
  id: string;
  name: string;
  size: number;
}

export function getImportFileSelectionError(
  existingFiles: readonly ImportFileDescriptor[],
  incomingFiles: readonly ImportFileDescriptor[],
): string | null {
  const invalidSize = incomingFiles.find((file) => !Number.isFinite(file.size) || file.size < 0);
  if (invalidSize) return `${invalidSize.name} のファイルサイズを確認できません。`;

  const oversized = incomingFiles.find((file) => file.size > IMPORT_RESOURCE_LIMITS.maxFileBytes);
  if (oversized) {
    return `${oversized.name} は1ファイルの上限（${formatMiB(IMPORT_RESOURCE_LIMITS.maxFileBytes)}）を超えています。`;
  }

  const incomingIds = new Set(incomingFiles.map((file) => file.id));
  const combinedFiles = [
    ...existingFiles.filter((file) => !incomingIds.has(file.id)),
    ...incomingFiles,
  ];
  if (combinedFiles.length > IMPORT_RESOURCE_LIMITS.maxFiles) {
    return `一度に選択できるJSONは${IMPORT_RESOURCE_LIMITS.maxFiles}件までです。`;
  }

  const totalBytes = combinedFiles.reduce((total, file) => total + file.size, 0);
  if (totalBytes > IMPORT_RESOURCE_LIMITS.maxTotalFileBytes) {
    return `選択したJSONの合計は${formatMiB(IMPORT_RESOURCE_LIMITS.maxTotalFileBytes)}以下にしてください。`;
  }
  return null;
}

export const CHATGPT_MATERIAL_TEMPLATE_PROMPT = `以下の資料をもとに、Quiz makeへ取り込む選択式問題のJSONを作成してください。

【最優先】
正確性、資料の網羅性、JSONの正しさを優先する。出力はJSON本体だけにし、説明文・Markdownコードフェンス・作業メモは出力しない。

【作業手順】
1. 資料を先頭から末尾まで確認し、見出し、表、図、脚注、注記、重要な数値や条件を内部的に一覧化する。
2. PDF・画像のOCRは下書きとして使う。文字化け、欠落、段組みの混線、改行崩れがある場合は、OCRから推測せず、ChatGPTが該当ページを直接目視する。数字、単位、否定語、薬剤名、疾患名、選択肢番号を必ず原本と照合する。
3. ページをまたぐ問題や続きの選択肢は一問に正しく結合し、別問題との誤結合や重複を避ける。
4. 判読できない内容は創作・推測で補完しない。問題文、選択肢、正答の根拠を確定できるまで原本や前後ページを再確認する。
5. 資料にない内容を資料の事実として追加しない。補足知識は解答に必要な最小限にする。
6. 作成後、資料全体とquestionsを照合し、重要事項・条件・例外の漏れを確認する。

【JSON条件】
- 問題は4択または5択、choicesも4個または5個。
- 正解が1つならanswerIndex、複数ならanswerIndexesを使う。両方を同時に使わない。
- indexは0始まり（4択は0〜3、5択は0〜4）。answerIndexesに重複を入れない。
- choices本文にA/B/Cや1/2などのラベルを付けない。
- 問題文・choices・explanation・category・referenceを文字列として正しく入れる。
- answerIndexまたはanswerIndexesは必ず1つ以上の正解を示す。
- 出力はそのまま保存できる.json形式にする。ファイル出力できる場合もJSON本体のみを保存する。

【形式】
{
  "setTitle": "問題セット名",
  "source": "資料名",
  "questions": [
    {
      "id": "q001",
      "category": "大分類名",
      "question": "問題文",
      "choices": ["選択肢1", "選択肢2", "選択肢3", "選択肢4"],
      "answerIndex": 0,
      "explanation": "解説",
      "reference": "参照ページや資料位置"
    }
  ]
}

複数正解の場合はanswerIndexesを使い、問題文に「正しいものをすべて選べ」または「誤っているものをすべて選べ」と明記する。誤りを選ばせる場合も、問題文に「誤っているものを1つ選べ」などと明記する。

【問題の作り方】
- 単一正答・誤答選択・複数正解のいずれも使ってよい。資料の原文、問いの目的、学習効果に最も合う形式を選び、無理に単一正答へ変換しない。
- 内容は定義、分類、違い、病態・機序、検査・診断、治療・適応・禁忌、合併症、鑑別、数値・基準、試験で問われやすい点を資料に応じて選ぶ。
- 誤答は、似た概念、適応と禁忌、検査目的、病態の一部、対象疾患、数値・順序の混同など、実際に迷う内容にする。
- 「だけ」「必ず」「常に」「絶対に」などを付けるだけの極端な誤答、資料と無関係な選択肢、正答だけ長い選択肢は禁止。ただし資料上必要な表現は使ってよい。
- 選択肢の文体、長さ、粒度をそろえ、正答番号を偏らせない。

【explanation】
一般的な問題は300〜600字程度を目安にするが、文字数の上限にはしない。単純な問題は短くてもよく、症例・計算・複数正解などは必要なだけ詳しくする。初学者が「なぜ」を理解し、類題にも判断を応用できるよう、次の順で整理する。
1. 正解の根拠。
2. 判断に使う知識・分類・機序・検査・治療など。
3. 迷いやすい誤答がなぜ違うのか、判断を分ける条件。
4. 理解に役立つ用例・具体例・例外。計算問題は途中式と単位も示す。
資料の記述と補足知識を区別し、未確認の根拠・出典は捏造しない。選択肢が並び替わっても理解できるよう、番号ではなく語句を使う。複数正解はそれぞれの根拠を説明する。出力を短くするために後半の解説を省略しない。
正解を一言で示すだけ、全選択肢を毎回機械的に長く説明すること、問題と無関係な一般論、見出しの羅列は禁止する。改行が必要な場合は短い段落に分け、JSON文字列内ではエスケープした改行（例: \\n）を使う。

【categoryと並び順】
- categoryは問題の主題を表す大分類。年度、問題番号、出題形式、難易度、単独の属性をcategory名にしない。
- 先に少数の分類表を作り、同義語・略称・表記ゆれを統一する。問題セット全体で原則3〜10分類、大規模でも15分類以内を目安にする。1〜2問だけの分類は、独立した重要領域でない限り近い上位分類へ統合する。
- category同士も、基礎・全体像から各論・応用へ進む順にする。五十音順や資料に出た順だけにしない。
- 同じcategory内では、近い疾患・概念・検査・治療、比較問題、混同しやすい問題をまとめる。順番は「定義・全体像 → 分類・違い → 病態・機序 → 検査・診断 → 治療・適応・禁忌 → 合併症・鑑別・例外 → 統合問題」を基本とする。
- 前提知識を要する問題を先に置かず、基礎から応用へ並べる。idは最終出力順でq001から連番にする。
- 未分類は主題を判断できない場合だけ使う。

【reference】
参照ページ、章、資料位置、年度・問題番号が分かる場合に入れる。年度・問題番号はquestion本文に入れず、referenceに短く記載する。分からない場合は空文字でもよい。

【最終確認】
JSONのみであること、全問題にcategoryがあること、choicesが4個または5個であること、正答indexが正しいこと、answerIndexとanswerIndexesが混在していないこと、原本との照合が済んでいること、重要事項の漏れがないこと、分類が増えすぎていないこと、questionsが学習順であること、explanationが十分な情報量を持ちながら冗長でないこと、必要な改行がJSONとして正しくエスケープされていることを確認してから出力する。
`;
export const CHATGPT_TEMPLATE_PROMPT = CHATGPT_MATERIAL_TEMPLATE_PROMPT;

export const CHATGPT_PAST_EXAM_TEMPLATE_PROMPT = `以下の過去問資料をもとに、Quiz makeへ取り込む過去問集約JSONを作成してください。

【最優先】
過去問原文の正確性、全問題の追跡可能性、重複整理、学習しやすい順番、JSONの正しさの順に確認する。出力はJSON本体だけにし、説明文・Markdownコードフェンス・作業メモは出力しない。

【全問題の棚卸し】
1. 年度・試験回・ファイルごとに全ページを先頭から末尾まで確認する。問題ページだけでなく、解答表、脚注、別紙、続きのページも見る。
2. 内部チェックリストに「年度・回・問題番号・掲載ページ・続きの有無・正答」を記録する。問題番号が飛んでいる場合は、未掲載か読み落としかを確認する。
3. 二段組み、ページ跨ぎ、表中の選択肢、画像化された文字、ヘッダー・フッターの混入を確認し、問題文と選択肢の対応を崩さない。
4. 各チェック項目を、出力問題のidとreference、または統合先のidとreferenceに対応づける。資料内の問題を重複を理由に黙って削除しない。
5. 出力前にreferenceを全件確認し、資料内のすべての年度・問題番号がJSON内のどこに入ったか追跡できる状態にする。

【原文・OCRの扱い】
- 問題文と選択肢は原文を優先し、意味が変わる言い換えをしない。許可するのは空白・改行・選択肢ラベルの整理と明らかなOCR誤りの補正だけ。
- OCRは下書きにとどめ、数字、単位、否定語、順位、薬剤名、疾患名、選択肢番号はPDF・画像の原本と照合する。
- OCRが欠落、文字化け、段組み混線、判読不能の場合は、OCRから推測せず、ChatGPTが該当PDF・画像を直接目視する。必要なら前後ページ、表、図、解答表も確認する。
- 原本と正答表を確認しても判読できない問題は、創作・推測で再構成しない。確認できるまで出力を完了しない。
- 年度・問題番号はquestion本文に入れず、referenceに「2025 Q2」のように記載する。

【重複・類似問題】
- 問題文・選択肢・問う知識・正答根拠がほぼ同じ場合は1問に統合し、referenceに全年度・問題番号を「2022 Q4 / 2025 Q2」のように併記する。
- 問い方、条件、選択肢、ひっかけ方、正答根拠が重要に異なる場合は別問題として残す。同じテーマというだけで統合しない。
- 統合後は、代表として最も正確で自然な原文を採用し、失われる年度差や出題意図はexplanationに短く反映する。
- 重複を減らすことより、問題の漏れを防ぐことを優先する。同じ年度・問題番号が複数箇所に出る場合は、原本の重複か別問題かを確認する。

【JSON条件】
- 問題は4択または5択、choicesも4個または5個。
- 正解が1つならanswerIndex、複数ならanswerIndexes。両方を同じ問題に入れない。
- indexは0始まり、answerIndexesに重複を入れない。
- choices本文にA/B/Cや1/2などのラベルを付けない。
- 出力はそのまま保存できる.json形式で、JSON本体以外を出力しない。
- 単一正答・誤答選択・複数正解のいずれも使ってよい。原文の設問形式と学習効果に合う形式を優先し、無理に単一正答へ変換しない。

【形式】
{
  "setTitle": "過去問集約 問題セット名",
  "source": "過去問資料名",
  "questions": [
    {
      "id": "q001",
      "category": "大分類名",
      "question": "過去問の問題文",
      "choices": ["選択肢1", "選択肢2", "選択肢3", "選択肢4"],
      "answerIndex": 0,
      "explanation": "解説",
      "reference": "2025 Q2"
    }
  ]
}

【categoryと並び順】
- categoryは問題が主に問う知識領域で決める。年度、試験回、問題番号、出題形式、難易度をcategory名にしない。
- 先に分類表を作り、同じ疾患・概念・制度・テーマを同じcategoryへ統一する。問題セット全体で原則3〜10分類、大規模でも15分類以内を目安にする。1〜2問だけの分類は、独立した重要領域でない限り近い上位分類へ統合する。
- 「未分類」は原本から主題を判断できない場合だけ使う。
- category同士は基礎・全体像から各論・応用へ、category内は近い内容をまとめて、定義 → 分類・違い → 病態・機序 → 検査・診断 → 治療・適応・禁忌 → 合併症・鑑別・例外 → 統合的な過去問の順に並べる。
- 五十音順、年度順、資料に出た順だけで並べず、前提知識から応用へ進める。元の年度・問題番号はreferenceで保持する。
- idは最終出力順でq001から連番にする。

【誤答】
原文選択肢を優先し、OCR補正でも意味を変えない。「だけ」「必ず」「常に」「絶対に」を付けるだけの雑な誤答は作らない。選択肢の文体・長さ・粒度をそろえる。

【explanation】
一般的な問題は300〜600字程度を目安にするが、文字数の上限にはしない。単純な問題は短くてもよく、複雑な問題は必要なだけ詳しくする。初学者が理解できるよう、正解の根拠 → 判断に必要な知識・手順 → 迷いやすい誤答との違い → 必要なら具体例・例外の順に整理する。計算は途中式・単位、複数正解はそれぞれの根拠を示す。原本・正答表の記述と補足知識を区別し、食い違いがある場合はその点を明記して断定しない。未確認の出典は捏造しない。選択肢番号ではなく語句で説明する。全選択肢を機械的に長く説明せず、無関係な一般論や繰り返しによる水増しを避ける。出力を短くするために後半の解説を省略しない。短い段落や箇条書きを使い、改行はJSON文字列内ではエスケープした改行（例: \\n）で表現する。

【最終確認】
各年度・問題番号がquestionsのreferenceから追跡できること、同一問題が重複していないこと、異なる問題を統合していないこと、問題の漏れがないこと、原本・正答表との照合が済んでいること、categoryが増えすぎていないこと、questionsが学習順であること、choicesと正答indexが正しいこと、explanationが情報量と簡潔さを両立していること、JSON以外がないことを確認してから出力する。
`;
export function validateImportJson(text: string): ValidationResult {
  if (text.length > IMPORT_RESOURCE_LIMITS.maxJsonCharacters) {
    return {
      ok: false,
      errors: [`JSONが大きすぎます。${formatMiB(IMPORT_RESOURCE_LIMITS.maxJsonCharacters)}相当以下に分割してください。`],
    };
  }
  let parsed: unknown;
  const normalizedText = text.replace(/^\uFEFF/u, '').trim();

  try {
    parsed = JSON.parse(normalizedText);
  } catch (error) {
    return {
      ok: false,
      errors: [error instanceof Error ? `JSONの解析に失敗しました: ${error.message}` : 'JSONの解析に失敗しました。'],
    };
  }

  const errors: string[] = [];
  if (!isRecord(parsed)) {
    return { ok: false, errors: ['最上位はオブジェクトにしてください。'] };
  }

  if (parsed.setTitle !== undefined && typeof parsed.setTitle !== 'string') {
    errors.push('setTitle は文字列にしてください。');
  } else if (typeof parsed.setTitle === 'string') {
    validateStringLength(parsed.setTitle, 'setTitle', IMPORT_RESOURCE_LIMITS.setTitle, errors);
  }

  if (parsed.source !== undefined && typeof parsed.source !== 'string') {
    errors.push('source は文字列にしてください。');
  } else if (typeof parsed.source === 'string') {
    validateStringLength(parsed.source, 'source', IMPORT_RESOURCE_LIMITS.source, errors);
  }

  if (!Array.isArray(parsed.questions)) {
    errors.push('questions は配列にしてください。');
  }

  if (errors.length > 0) return { ok: false, errors };

  const rawQuestions = parsed.questions as unknown[];
  if (rawQuestions.length === 0) {
    errors.push('questions が空です。1問以上入れてください。');
  }
  if (rawQuestions.length > IMPORT_RESOURCE_LIMITS.maxQuestions) {
    errors.push(`questions は${IMPORT_RESOURCE_LIMITS.maxQuestions.toLocaleString('ja-JP')}問以下に分割してください。現在 ${rawQuestions.length.toLocaleString('ja-JP')} 問です。`);
  }
  if (errors.length > 0) return { ok: false, errors };

  const questions: ImportedQuestion[] = [];
  for (let index = 0; index < rawQuestions.length; index += 1) {
    if (errors.length >= 100) {
      errors.push('エラーが100件を超えたため、残りの検証を省略しました。');
      break;
    }
    const rawQuestion = rawQuestions[index];
    const path = `questions[${index}]`;
    if (!isRecord(rawQuestion)) {
      errors.push(`${path} はオブジェクトにしてください。`);
      continue;
    }

    if (rawQuestion.id !== undefined && typeof rawQuestion.id !== 'string') {
      errors.push(`${path}.id は文字列にしてください。`);
    } else if (typeof rawQuestion.id === 'string') {
      validateStringLength(rawQuestion.id, `${path}.id`, IMPORT_RESOURCE_LIMITS.id, errors);
    }

    if (!isNonEmptyString(rawQuestion.question)) {
      errors.push(`${path}.question は空でない文字列にしてください。`);
    } else {
      validateStringLength(rawQuestion.question, `${path}.question`, IMPORT_RESOURCE_LIMITS.question, errors);
    }

    if (!Array.isArray(rawQuestion.choices)) {
      errors.push(`${path}.choices は配列にしてください。`);
    } else if (rawQuestion.choices.length !== 4 && rawQuestion.choices.length !== 5) {
      errors.push(`${path}.choices は4個または5個にしてください。現在 ${rawQuestion.choices.length} 個です。`);
    } else {
      rawQuestion.choices.forEach((choice, choiceIndex) => {
        if (!isNonEmptyString(choice)) {
          errors.push(`${path}.choices[${choiceIndex}] は空でない文字列にしてください。`);
        } else {
          validateStringLength(choice, `${path}.choices[${choiceIndex}]`, IMPORT_RESOURCE_LIMITS.choice, errors);
        }
      });
    }

    if (rawQuestion.shuffleChoices !== undefined && typeof rawQuestion.shuffleChoices !== 'boolean') errors.push(`${path}.shuffleChoices は真偽値にしてください。`);
    if (rawQuestion.distractors !== undefined && (!Array.isArray(rawQuestion.distractors) || rawQuestion.distractors.length > 50 || !rawQuestion.distractors.every((item) => isNonEmptyString(item) && item.length <= IMPORT_RESOURCE_LIMITS.choice))) errors.push(`${path}.distractors は空でない文字列50個以内にしてください。`);
    if (!isNonEmptyString(rawQuestion.explanation)) {
      errors.push(`${path}.explanation は空でない文字列にしてください。`);
    } else {
      validateStringLength(rawQuestion.explanation, `${path}.explanation`, IMPORT_RESOURCE_LIMITS.explanation, errors);
    }

    if (rawQuestion.answerText !== undefined && typeof rawQuestion.answerText !== 'string') {
      errors.push(`${path}.answerText は文字列にしてください。`);
    } else if (typeof rawQuestion.answerText === 'string') {
      validateStringLength(rawQuestion.answerText, `${path}.answerText`, IMPORT_RESOURCE_LIMITS.answerText, errors);
    }

    if (rawQuestion.detailedExplanation !== undefined && typeof rawQuestion.detailedExplanation !== 'string') {
      errors.push(`${path}.detailedExplanation は文字列にしてください。`);
    } else if (typeof rawQuestion.detailedExplanation === 'string') {
      validateStringLength(
        rawQuestion.detailedExplanation,
        `${path}.detailedExplanation`,
        IMPORT_RESOURCE_LIMITS.detailedExplanation,
        errors,
      );
    }

    if (rawQuestion.sourcePage !== undefined && typeof rawQuestion.sourcePage !== 'string') {
      errors.push(`${path}.sourcePage は文字列にしてください。`);
    } else if (typeof rawQuestion.sourcePage === 'string') {
      validateStringLength(rawQuestion.sourcePage, `${path}.sourcePage`, IMPORT_RESOURCE_LIMITS.sourcePage, errors);
    }

    if (rawQuestion.reference !== undefined && typeof rawQuestion.reference !== 'string') {
      errors.push(`${path}.reference は文字列にしてください。`);
    } else if (typeof rawQuestion.reference === 'string') {
      validateStringLength(rawQuestion.reference, `${path}.reference`, IMPORT_RESOURCE_LIMITS.sourcePage, errors);
    }

    if (rawQuestion.category !== undefined && typeof rawQuestion.category !== 'string') {
      errors.push(`${path}.category は文字列にしてください。`);
    } else if (typeof rawQuestion.category === 'string') {
      validateStringLength(rawQuestion.category, `${path}.category`, IMPORT_RESOURCE_LIMITS.category, errors);
    }

    if (rawQuestion.difficulty !== undefined && typeof rawQuestion.difficulty !== 'string') {
      errors.push(`${path}.difficulty は文字列にしてください。`);
    } else if (typeof rawQuestion.difficulty === 'string') {
      validateStringLength(rawQuestion.difficulty, `${path}.difficulty`, IMPORT_RESOURCE_LIMITS.difficulty, errors);
    }

    const choices = Array.isArray(rawQuestion.choices) && (rawQuestion.choices.length === 4 || rawQuestion.choices.length === 5)
      ? rawQuestion.choices.map((choice) => (typeof choice === 'string' ? stripChoicePrefix(choice) : choice))
      : ['', '', '', ''];
    const answerIndexesResult = getAnswerIndexes(rawQuestion, choices.length, path);
    errors.push(...answerIndexesResult.errors);
    if (Array.isArray(rawQuestion.distractors) && rawQuestion.distractors.some((text) => typeof text === 'string' && answerIndexesResult.value.some((index) => choices[index] === text.trim()))) errors.push(`${path}.distractors に正解と同じ語句が含まれています。`);

    if (
      isNonEmptyString(rawQuestion.question) &&
      (choices.length === 4 || choices.length === 5) &&
      choices.every(isNonEmptyString) &&
      answerIndexesResult.value.length > 0 &&
      isNonEmptyString(rawQuestion.explanation)
    ) {
      const answerIndexes = answerIndexesResult.value;
      questions.push({
        id: typeof rawQuestion.id === 'string' ? rawQuestion.id : undefined,
        question: rawQuestion.question,
        choices: choices as ImportedQuestion['choices'],
        distractors: Array.isArray(rawQuestion.distractors) ? [...new Set(rawQuestion.distractors as string[])].filter((text) => typeof text === 'string').map((text) => text.trim()) : undefined,
        shuffleChoices: typeof rawQuestion.shuffleChoices === 'boolean' ? rawQuestion.shuffleChoices : undefined,
        answerIndex: answerIndexes[0],
        answerIndexes,
        answerText: typeof rawQuestion.answerText === 'string' && rawQuestion.answerText.trim() !== ''
          ? rawQuestion.answerText
          : answerIndexes.map((index) => choices[index]).join(' / '),
        explanation: rawQuestion.explanation,
        detailedExplanation: typeof rawQuestion.detailedExplanation === 'string' ? rawQuestion.detailedExplanation : '',
        sourcePage: getSourcePage(rawQuestion),
        category: typeof rawQuestion.category === 'string' && rawQuestion.category.trim() !== '' ? rawQuestion.category : '未分類',
        difficulty: typeof rawQuestion.difficulty === 'string' ? rawQuestion.difficulty : 'basic',
      });
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: {
      setTitle: typeof parsed.setTitle === 'string' && parsed.setTitle.trim() !== '' ? parsed.setTitle : '無題の問題セット',
      source: typeof parsed.source === 'string' ? parsed.source : '',
      questions,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateStringLength(value: string, path: string, maxLength: number, errors: string[]): void {
  if (value.length > maxLength) {
    errors.push(`${path} は${maxLength.toLocaleString('ja-JP')}文字以下にしてください。現在 ${value.length.toLocaleString('ja-JP')}文字です。`);
  }
}

function formatMiB(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))}MB`;
}

function getSourcePage(rawQuestion: Record<string, unknown>) {
  if (typeof rawQuestion.sourcePage === 'string') return rawQuestion.sourcePage;
  if (typeof rawQuestion.reference === 'string') return rawQuestion.reference;
  return '';
}

function stripChoicePrefix(text: string) {
  return text.replace(/^\s*(?:[A-EＡ-Ｅａ-ｅa-e]|[1-5１-５])\s*[\.\)\]:：．）]\s*/u, '').trim();
}

function getAnswerIndexes(rawQuestion: Record<string, unknown>, choiceCount: number, path: string): { value: number[]; errors: string[] } {
  const errors: string[] = [];

  if (Array.isArray(rawQuestion.answerIndexes)) {
    if (rawQuestion.answerIndexes.length === 0) {
      errors.push(`${path}.answerIndexes は1つ以上指定してください。`);
      return { value: [], errors };
    }
    if (rawQuestion.answerIndexes.length > choiceCount) {
      errors.push(`${path}.answerIndexes は選択肢数（${choiceCount}個）以下にしてください。`);
      return { value: [], errors };
    }

    const indexes: number[] = [];
    rawQuestion.answerIndexes.forEach((item, index) => {
      if (!Number.isInteger(item)) {
        errors.push(`${path}.answerIndexes[${index}] は整数にしてください。`);
      } else if (Number(item) < 0 || Number(item) >= choiceCount) {
        errors.push(`${path}.answerIndexes[${index}] は0〜${choiceCount - 1}の整数にしてください。`);
      } else {
        indexes.push(Number(item));
      }
    });

    if (new Set(indexes).size !== indexes.length) {
      errors.push(`${path}.answerIndexes に重複があります。`);
    }

    return { value: Array.from(new Set(indexes)).sort((a, b) => a - b), errors };
  }

  if (!Number.isInteger(rawQuestion.answerIndex)) {
    errors.push(`${path}.answerIndex または answerIndexes を指定してください。`);
    return { value: [], errors };
  }

  const answerIndex = Number(rawQuestion.answerIndex);
  if (answerIndex < 0 || answerIndex >= choiceCount) {
    errors.push(`${path}.answerIndex は0〜${choiceCount - 1}の整数にしてください。`);
    return { value: [], errors };
  }

  return { value: [answerIndex], errors };
}
