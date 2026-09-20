export const publicationPurposes = ['中学入試', '高校入試', '大学入試', '中学校の定期テスト', '高校の定期テスト', '大学の定期テスト', '資格・検定', '就職・公務員試験', '語学学習', 'その他'];
export interface PublicationInfo { audience: string; description: string }
export function PublicationDetails({ value, onChange, disabled = false }: { value: PublicationInfo; onChange: (value: PublicationInfo) => void; disabled?: boolean }) {
  return <div className="publication-details">
    <label><span>対策・用途 <small>必須</small></span><select required disabled={disabled} value={value.audience} onChange={(event) => onChange({ ...value, audience: event.target.value })}>
      <option value="">選んでください</option>{value.audience && !publicationPurposes.includes(value.audience) ? <option>{value.audience}</option> : null}
      {publicationPurposes.map((purpose) => <option key={purpose}>{purpose}</option>)}
    </select></label>
    <label><span>かんたんな説明 <small>任意</small></span><textarea disabled={disabled} value={value.description} maxLength={300} rows={2} placeholder="内容やおすすめの使い方など" onChange={(event) => onChange({ ...value, description: event.target.value })} /></label>
  </div>;
}
