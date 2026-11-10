import { ArrowLeft, ArrowRight, Dices, Sparkles, UserRound, Wand2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  CHAR_DESC,
  CHAR_KEYS,
  CHAR_NAMES,
  OCCUPATIONS,
  SKILL_CAP,
  SKILL_CATEGORIES,
  autoAllocate,
  buildSheet,
  derivedStats,
  occupationById,
  occupationFormula,
  occupationSkills,
  remainingPoints,
  rollCharacteristics,
  skillBase,
  skillsForEra,
  type Characteristics,
} from '../../../shared/coc';
import type { Room } from '../../../shared/types';
import { put } from '../api';
import { attempt, toast } from '../toast';
import { Modal } from './Modal';
import { SheetView } from './SheetPanel';
import { Field, Segmented } from './ui';

const STEPS = ['身份与职业', '掷属性', '分配技能', '背景与确认'];

export function CharacterWizard({ room, onClose }: { room: Room; onClose: () => void }) {
  const era = room.trpg?.era ?? '1920s';
  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [gender, setGender] = useState('男');
  const [age, setAge] = useState(28);
  const [occId, setOccId] = useState('journalist');
  const [chars, setChars] = useState<{ characteristics: Characteristics; luck: number } | null>(null);
  const [rolling, setRolling] = useState(false);
  const [alloc, setAlloc] = useState<Record<string, number>>({});
  const [appearance, setAppearance] = useState('');
  const [backstory, setBackstory] = useState('');
  const [items, setItems] = useState('');
  const [saving, setSaving] = useState(false);

  const occ = occupationById(occId)!;
  const rest = chars ? remainingPoints(occ, chars.characteristics, alloc) : null;
  const sheet = useMemo(
    () =>
      chars &&
      buildSheet({
        name: name || '无名调查员',
        occupation: occ.name,
        age,
        gender,
        appearance,
        backstory,
        characteristics: chars.characteristics,
        luck: chars.luck,
        allocation: alloc,
        items: items
          .split(/[,，、\n]/)
          .map((s) => s.trim())
          .filter(Boolean),
        era,
      }),
    [chars, name, occ.name, age, gender, appearance, backstory, alloc, items, era],
  );

  const roll = () => {
    setRolling(true);
    let n = 0;
    const t = setInterval(() => {
      setChars(rollCharacteristics());
      if (++n >= 8) {
        clearInterval(t);
        setRolling(false);
      }
    }, 60);
    setAlloc({});
  };

  const chooseOcc = (id: string) => {
    setOccId(id);
    setAlloc({});
    setItems((occupationById(id)?.items ?? []).join('、'));
  };

  const quick = () => {
    const o = occ;
    const c = rollCharacteristics();
    setChars(c);
    setAlloc(autoAllocate(o, c.characteristics));
    if (!items) setItems(o.items.join('、'));
    if (!name) setName(['林知秋', '沈砚', '顾青', '陆远', '苏小满', '许清和'][Math.floor(Math.random() * 6)]);
    setStep(3);
  };

  const finish = async () => {
    if (!sheet) return;
    setSaving(true);
    const ok = await attempt(() => put(`/rooms/${room.id}/trpg/sheets/player`, { sheet }));
    setSaving(false);
    if (ok) {
      toast(`调查员「${sheet.name}」创建好了！`);
      onClose();
    }
  };

  const canNext = step === 0 ? true : step === 1 ? !!chars && !rolling : step === 2 ? !!rest && rest.interest >= 0 : true;

  const occSet = new Set(occupationSkills(occ));
  const skillDefs = skillsForEra(era);

  return (
    <Modal
      title="创建调查员"
      icon={<UserRound />}
      size="xl"
      onClose={onClose}
      header={
        <div className="wizard-steps">
          {STEPS.map((s, i) => (
            <div key={s} className={`wizard-step ${i < step ? 'done' : i === step ? 'current' : ''}`}>
              {i + 1}. {s}
            </div>
          ))}
        </div>
      }
      footer={
        <>
          {step === 0 && (
            <button className="btn" onClick={quick} title="随机掷属性并自动分配技能，直接跳到最后一步">
              <Wand2 /> 快速生成（新手推荐）
            </button>
          )}
          <span className="spacer" />
          {step > 0 && (
            <button className="btn" onClick={() => setStep(step - 1)}>
              <ArrowLeft /> 上一步
            </button>
          )}
          {step < 3 ? (
            <button
              className="btn btn-primary"
              disabled={!canNext}
              onClick={() => {
                if (step === 0 && !items) setItems(occ.items.join('、'));
                if (step === 0 && !chars) roll();
                setStep(step + 1);
              }}
            >
              下一步 <ArrowRight />
            </button>
          ) : (
            <button className="btn btn-primary" disabled={!sheet || saving} onClick={finish}>
              <Sparkles /> 完成，就用这个调查员
            </button>
          )}
        </>
      }
    >
      {step === 0 && (
        <div className="form-stack">
          <div className="callout callout-info">
            <Sparkles />
            <span>
              调查员就是你在故事里扮演的角色。COC 的调查员都是普通人：记者、医生、教授……不是超级英雄。
              不想研究规则的话，选好职业后直接点左下角的「快速生成」。
            </span>
          </div>
          <div className="form-grid">
            <Field label="名字">
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：林知秋" />
            </Field>
            <div className="row" style={{ alignItems: 'flex-end' }}>
              <Field label="性别">
                <Segmented value={gender} onChange={setGender} options={['男', '女', '其他'].map((g) => ({ value: g, label: g }))} />
              </Field>
              <Field label="年龄">
                <input type="number" min={18} max={70} value={age} onChange={(e) => setAge(Number(e.target.value) || 28)} style={{ width: 80 }} />
              </Field>
            </div>
          </div>
          <Field label="职业" hint="（职业决定了你擅长哪些技能）">
            <div className="card-grid">
              {OCCUPATIONS.map((o) => (
                <button key={o.id} className={`select-card ${o.id === occId ? 'active' : ''}`} onClick={() => chooseOcc(o.id)}>
                  <div className="select-card-title">
                    {o.name}
                    {o.desc.includes('新手推荐') && <span className="badge badge-accent">推荐</span>}
                  </div>
                  <div className="select-card-desc">{o.desc.replace('新手推荐。', '')}</div>
                  <div className="select-card-desc" style={{ color: 'var(--text-2)' }}>
                    {o.skills.slice(0, 5).join('、')}…
                  </div>
                </button>
              ))}
            </div>
          </Field>
        </div>
      )}

      {step === 1 && (
        <div className="form-stack">
          <div className="row">
            <div className="grow hint" style={{ fontSize: 13 }}>
              属性由骰子决定：力量、体质、敏捷、外貌、意志掷 3d6×5，体型、智力、教育掷 (2d6+6)×5。新手可以随便重骰，直到满意为止。
            </div>
            <button className="btn btn-primary" onClick={roll} disabled={rolling}>
              <Dices /> {chars ? '重新掷骰' : '掷骰'}
            </button>
          </div>
          {chars && (
            <>
              <div className="char-roll-grid">
                {CHAR_KEYS.map((k) => (
                  <div key={k} className="char-roll">
                    <div className="name">
                      {CHAR_NAMES[k]}
                      <span className="hint">{k}</span>
                    </div>
                    <div className="val">{chars.characteristics[k]}</div>
                    <div className="desc">{CHAR_DESC[k]}</div>
                  </div>
                ))}
              </div>
              <div className="derived-row">
                {(() => {
                  const d = derivedStats(chars.characteristics);
                  return (
                    <>
                      <span className="derived">幸运<b>{chars.luck}</b></span>
                      <span className="derived">生命值<b>{d.hp}</b></span>
                      <span className="derived">魔法值<b>{d.mp}</b></span>
                      <span className="derived">理智<b>{d.san}</b></span>
                      <span className="derived">移动力<b>{d.mov}</b></span>
                      <span className="derived">伤害加值<b>{d.damageBonus}</b></span>
                    </>
                  );
                })()}
              </div>
            </>
          )}
        </div>
      )}

      {step === 2 && chars && rest && (
        <div className="form-stack">
          <div className="points-bar">
            <span className={`points ${rest.occ < 0 ? 'over' : ''}`}>
              职业点数（{occupationFormula(occ)}）<b>{rest.occ}</b> / {rest.occTotal}
            </span>
            <span className={`points ${rest.interest < 0 ? 'over' : ''}`}>
              兴趣点数（智力×2）<b>{rest.interest}</b> / {rest.intTotal}
            </span>
            <span className="spacer" />
            <button className="btn btn-sm" onClick={() => setAlloc(autoAllocate(occ, chars.characteristics))}>
              <Wand2 /> 自动分配
            </button>
            <button className="btn btn-sm btn-ghost" onClick={() => setAlloc({})}>
              清空
            </button>
          </div>
          <div className="hint">
            高亮的是<b>职业技能</b>，可以用职业点数和兴趣点数；其他技能只能用兴趣点数。单项技能最高 {SKILL_CAP}。
            信用评级建议在 {occ.credit[0]}~{occ.credit[1]} 之间。
          </div>
          <div className="alloc-table">
            {[{ title: '职业技能', defs: skillDefs.filter((s) => occSet.has(s.name)) }, ...SKILL_CATEGORIES.map((cat) => ({ title: cat, defs: skillDefs.filter((s) => s.category === cat && !occSet.has(s.name)) }))]
              .filter((g) => g.defs.length)
              .map((g) => (
                <div key={g.title} style={{ display: 'contents' }}>
                  <div className="alloc-group">{g.title}</div>
                  {g.defs.map((s) => {
                    const base = skillBase(s.name, chars.characteristics);
                    const add = alloc[s.name] ?? 0;
                    const locked = s.name === '克苏鲁神话';
                    return (
                      <div key={s.name} className={`alloc-row ${occSet.has(s.name) ? 'occ' : ''}`}>
                        <div className="name">
                          {s.name}
                          <small>{s.desc}</small>
                        </div>
                        <span className="base">{base}</span>
                        <input
                          type="number"
                          min={0}
                          step={5}
                          disabled={locked}
                          value={add || ''}
                          placeholder="+0"
                          onChange={(e) => {
                            const v = Math.max(0, Math.min(Math.max(0, SKILL_CAP - base), Number(e.target.value) || 0));
                            setAlloc((a) => ({ ...a, [s.name]: v }));
                          }}
                        />
                        <span className="total">{base + add}</span>
                      </div>
                    );
                  })}
                </div>
              ))}
          </div>
        </div>
      )}

      {step === 3 && sheet && (
        <div className="form-grid" style={{ alignItems: 'start' }}>
          <div className="form-stack">
            <Field label="名字">
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="给你的调查员起个名字" />
            </Field>
            <Field label="形象" hint="（可选：外貌、穿着、习惯）">
              <textarea rows={2} value={appearance} onChange={(e) => setAppearance(e.target.value)} placeholder="例如：戴圆框眼镜，总穿一件洗旧的灰色长衫" />
            </Field>
            <Field label="背景故事" hint="（可选：和失踪的老友是什么关系？有什么信念？）">
              <textarea rows={4} value={backstory} onChange={(e) => setBackstory(e.target.value)} placeholder="例如：沈怀瑾是我大学时的室友，他曾在我最困难的时候帮过我……" />
            </Field>
            <Field label="随身物品" hint="（用顿号或逗号分隔）">
              <textarea rows={2} value={items} onChange={(e) => setItems(e.target.value)} />
            </Field>
          </div>
          <div style={{ border: '1px solid var(--border)', borderRadius: 14, padding: 14, background: 'var(--surface-2)' }}>
            <SheetView sheet={sheet} />
          </div>
        </div>
      )}
    </Modal>
  );
}
