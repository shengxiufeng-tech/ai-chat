import { Brain, Clover, Dices, Flame, Heart, Package, Sparkles, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { DIFFICULTY_LABELS, LEVEL_LABELS, thresholds, type RollRecord } from '../../../shared/coc';

const STAT_ICON = { HP: Heart, MP: Sparkles, SAN: Brain, 幸运: Clover, 物品: Package } as const;

export function RollCard({
  roll: r,
  canAct,
  onRoll,
  onPush,
}: {
  roll: RollRecord;
  /** 这次掷骰属于人类玩家 */
  canAct: boolean;
  onRoll: () => Promise<unknown>;
  onPush: () => Promise<unknown>;
}) {
  const [rolling, setRolling] = useState(false);
  const [flicker, setFlicker] = useState(0);

  useEffect(() => {
    if (!rolling) return;
    const t = setInterval(() => setFlicker(1 + Math.floor(Math.random() * 100)), 50);
    return () => clearInterval(t);
  }, [rolling]);

  const doRoll = async (fn: () => Promise<unknown>) => {
    setRolling(true);
    await Promise.all([fn(), new Promise((r) => setTimeout(r, 650))]);
    setRolling(false);
  };

  if (r.type === 'stat') {
    const Icon = STAT_ICON[r.stat ?? '物品'] ?? Package;
    const down = r.stat === '物品' ? !r.itemAdded : (r.delta ?? 0) < 0;
    return (
      <div className="roll-row">
        <div className={`stat-chip ${down ? 'down' : 'up'}`}>
          <Icon />
          {r.stat === '物品' ? (
            <span>
              {r.actorName} {r.itemAdded ? '获得了' : '失去了'} <b>{r.item}</b>
            </span>
          ) : (
            <span>
              {r.actorName} 的 {r.stat} <b>{r.before}</b> → <b>{r.after}</b>（{(r.delta ?? 0) >= 0 ? '+' : ''}
              {r.delta}
              {r.detail ? `，${r.detail}` : ''}）
            </span>
          )}
          {r.note && <span className="badge badge-danger">{r.note}</span>}
        </div>
      </div>
    );
  }

  if (r.type === 'dice') {
    return (
      <div className="roll-row">
        <div className="roll-card">
          <div className="roll-head">
            <div className="roll-icon">
              <Dices />
            </div>
            <div className="grow">
              <div className="roll-title">守秘人掷骰 {r.note && <span className="badge">{r.note}</span>}</div>
              <div className="roll-sub">{r.detail}</div>
            </div>
            <div className="roll-number">{r.total}</div>
          </div>
        </div>
      </div>
    );
  }

  const isSan = r.type === 'san';
  const th = thresholds(r.target ?? 0);
  const required = r.difficulty ?? 'regular';
  const title = isSan ? '理智检定' : `${r.label} 检定`;

  return (
    <div className="roll-row">
      <div className={`roll-card ${r.pending ? 'pending' : ''} ${rolling ? 'rolling' : ''}`}>
        <div className="roll-head">
          <div className="roll-icon">{isSan ? <Brain /> : <Dices />}</div>
          <div className="grow">
            <div className="roll-title">
              {title}
              {!isSan && required !== 'regular' && (
                <span className="badge badge-warn">{DIFFICULTY_LABELS[required]}</span>
              )}
              {!!r.bonus && (
                <span className="badge">{r.bonus > 0 ? `奖励骰 ×${r.bonus}` : `惩罚骰 ×${-r.bonus}`}</span>
              )}
              {r.pushed && (
                <span className="badge badge-danger">
                  <Flame /> 孤注一掷
                </span>
              )}
            </div>
            <div className="roll-sub">
              {r.actorName} ·{' '}
              {isSan ? `当前理智 ${r.before ?? r.target} · 损失 ${r.sanSuccess}/${r.sanFail}` : `技能值 ${r.target}`}
            </div>
          </div>
          {!r.pending && !rolling && r.level && (
            <span className={`level-badge level-${r.level}`}>
              {isSan ? (r.success ? '理智检定成功' : '理智检定失败') : LEVEL_LABELS[r.level]}
            </span>
          )}
        </div>

        {(r.pending || rolling) && !isSan && (
          <div className="roll-thresholds">
            {(['regular', 'hard', 'extreme'] as const).map((d) => (
              <div key={d} className={`threshold ${d === required ? 'required' : ''}`}>
                <span>{DIFFICULTY_LABELS[d]}成功</span>
                <b>≤ {th[d]}</b>
              </div>
            ))}
          </div>
        )}

        {(rolling || !r.pending) && (
          <div className="roll-body">
            <div className="roll-number">{rolling ? flicker : r.total}</div>
            {!rolling && r.tens && (
              <div className="grow">
                <div className="roll-dice">
                  {r.tens.map((t, i) => {
                    const chosen = r.tens!.length === 1 || (t === 0 && r.units === 0 ? 100 : t + r.units!) === r.total;
                    return (
                      <span key={i} className={`die ${chosen ? '' : 'dim'}`} title="十位骰">
                        {String(t).padStart(2, '0')}
                      </span>
                    );
                  })}
                  <span className="die" title="个位骰">
                    {r.units}
                  </span>
                </div>
              </div>
            )}
          </div>
        )}

        {!r.pending && !rolling && (
          <div className="roll-explain">
            {isSan ? (
              <>
                {r.total} {r.success ? '≤' : '>'} {r.before}，失去 <b>{r.loss}</b> 点理智（{r.lossDetail}），理智{' '}
                {r.before} → <b>{r.after}</b>
              </>
            ) : (
              <>
                掷出 {r.total}，{r.level === 'critical' ? '01 是大成功！' : r.level === 'fumble' ? '大失败！' : `${LEVEL_LABELS[r.level!]}`}
                {required !== 'regular' && `（本次要求${DIFFICULTY_LABELS[required]}成功）`}，{r.success ? '检定通过。' : '检定没有通过。'}
              </>
            )}
            {r.note && (
              <div className="row" style={{ marginTop: 4, color: 'var(--warn)', alignItems: 'flex-start' }}>
                <TriangleAlert style={{ width: 14, height: 14, flex: 'none', marginTop: 3 }} />
                {r.note}
              </div>
            )}
          </div>
        )}

        {r.pending && !rolling && (
          <div className="roll-actions">
            {canAct ? (
              <>
                <button className="btn btn-primary roll-dice-btn" onClick={() => doRoll(onRoll)}>
                  <Dices /> 掷骰
                </button>
                <span className="hint">
                  {isSan
                    ? `掷 1d100，≤ 当前理智 ${r.target} 就算成功，失去的理智更少。`
                    : `掷 1d100，结果 ≤ ${th[required]} 就算${DIFFICULTY_LABELS[required]}成功。数字越小越好。`}
                </span>
              </>
            ) : (
              <span className="hint">等待掷骰…</span>
            )}
          </div>
        )}

        {!r.pending && !rolling && canAct && r.pushable && !r.pushedAlready && (
          <div className="roll-actions">
            <button
              className="btn btn-sm btn-warn"
              onClick={() => doRoll(onPush)}
              title="说明你如何更努力地尝试，然后重骰一次；如果再失败，后果会很严重"
            >
              <Flame /> 孤注一掷
            </button>
            <span className="hint">再试一次，但失败的后果会更严重。可以先在输入框里描述你怎么更努力地尝试。</span>
          </div>
        )}
      </div>
    </div>
  );
}
