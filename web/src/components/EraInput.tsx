const PRESETS = ['1920 年代，美国新英格兰', '民国时期的中国', '维多利亚时代的英国（1890 年代）', '现代'];

/** 时代背景：自由填写，常用的可以一键选 */
export function EraInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <>
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder="例如：1920 年代，美国新英格兰的海边小镇" />
      <div className="row wrap" style={{ gap: 4 }}>
        {PRESETS.map((p) => (
          <button key={p} type="button" className="chip" onClick={() => onChange(p)}>
            {p}
          </button>
        ))}
      </div>
      <span className="hint">
        时代决定故事发生的年代和地点：守秘人会按这个背景描写科技、社会和人物；技能列表也会跟着变（比如现代才有「计算机使用」「电子学」）。
      </span>
    </>
  );
}
