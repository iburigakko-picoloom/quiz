// Relevant classifier from 4aaf913119b717c1a89dd64f5dd9ee2cc3f31676.
// Fixed evidence fixture; deliberately independent of the checkout's future HEAD.
export function historicalMediaReason(message){
  if(message.includes('クラウドの画像・教材を完全')||message.includes('クラウドの参照関係')){
    const cause=message.includes('原本を保持しています。')?message.split('原本を保持しています。')[1]:message;
    if(message.includes('クラウドの参照関係')||cause.includes('存在しない問題セット')||cause.includes('存在しないフォルダ')||cause.includes('参照が壊れ'))return 'クラウドの教材の紐づけ情報に不備があります。';
    if(cause.includes('PDF'))return 'クラウドのPDFを読み込めません。';
    if(cause.includes('画像'))return 'クラウドの画像を読み込めません。';
    return 'クラウドの教材・画像を読み込めません。';
  }
}
