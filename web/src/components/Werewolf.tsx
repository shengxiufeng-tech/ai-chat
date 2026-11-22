// 狼人杀的界面部件：座位表、法官消息、轮到你时的操作面板、对局信息、设置
import { Crown, Eye, Lock, Megaphone, Moon, Play, Send, Skull, Sun, Swords, Users, Vote } from 'lucide-react';
import { useEffect, useState, type CSSProperties } from 'react';
import {
  DEATH_LABELS,
  ROLE_INFO,
  ROLE_ORDER,
  isWolf,
  rolesText,
  seatLabel,
  viewerOf,
  type WerewolfState,
  type WwPending,
  type WwSeat,
} from '../../../shared/werewolf';
import type { Message, Participant, Room, RunnerState } from '../../../shared/types';
import { patch, post } from '../api';
import { askConfirm } from '../confirm';
import { attempt } from '../toast';
import { ModelInput } from './ModelInput';
import { Field, Segmented, ToggleRow } from './ui';

/** 这个座位的身份现在能不能给你看 */
export function roleVisible(ww: WerewolfState, s: WwSeat) {
  const v = viewerOf(ww);
  if (ww.phase === 'end') return true;
  if (s.seat === ww.humanSeat) return true;
  if (v.god) return ww.humanSeat != null || ww.showRoles;
  if (v.wolf && isWolf(s.role)) return true;
  return !!s.idiotRevealed || s.death?.cause === 'explode' || s.death?.cause === 'knight';
}

export function wwStatus(ww: WerewolfState, runner: RunnerState | null, speaker?: Participant) {
  if (ww.phase === 'setup') return '还没开始';
  if (ww.phase === 'end') return `游戏结束 · ${ww.winner === 'wolf' ? '狼人' : '好人'}阵营胜利`;
  if (ww.pending && ww.pending.seat === ww.humanSeat) return '轮到你了';
  if (speaker) return `${speaker.name} 正在发言…`;
  if (ww.activity) return ww.activity;
  const when = ww.phase === 'night' ? `第 ${ww.day} 夜` : `第 ${ww.day} 天`;
  return runner?.status === 'running' ? when : `${when} · 已暂停`;
}

// ---------------- 座位表 ----------------

export function SeatBar({ room, runner }: { room: Room; runner: RunnerState | null }) {
  const ww = room.werewolf!;
  const speakingId = runner?.generating?.participantId;
  return (
    <div className="seat-bar">
      {ww.seats.map((s) => {
        const p = room.participants.find((x) => x.id === s.participantId);
        const show = roleVisible(ww, s);
        const info = ROLE_INFO[s.role];
        const speaking = (speakingId && speakingId === s.participantId) || (ww.pending?.seat === s.seat && s.human);
        return (
          <div
            key={s.seat}
            className={`seat ${s.alive ? '' : 'dead'} ${speaking ? 'speaking' : ''} ${s.human ? 'me' : ''} ${show && isWolf(s.role) ? 'wolf' : ''}`}
            style={{ '--c': p?.color ?? 'var(--accent)' } as CSSProperties}
            title={`${seatLabel(s.seat)} ${s.name}${show ? ` · ${info.name}` : ''}${s.alive ? '' : ` · ${DEATH_LABELS[s.death!.cause]}`}${p ? ` · ${p.model}` : ''}`}
          >
            <span className="seat-num">{s.seat}</span>
            <span className="seat-avatar">{s.alive ? s.avatar : <Skull />}</span>
            <span className="seat-name">
              {s.human ? '你' : s.name}
              {ww.sheriff === s.seat && <Crown className="seat-badge" aria-label="警长" />}
            </span>
            {show && (
              <span className="seat-role">
                {info.icon} {info.name}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---------------- 法官消息 ----------------

export function WwCard({ room, m }: { room: Room; m: Message }) {
  const ww = room.werewolf!;
  const type = m.ww?.type;
  if (type === 'phase') {
    return (
      <div className="ww-phase">
        {m.content.includes('天黑') ? <Moon /> : <Sun />}
        <span>{m.content}</span>
      </div>
    );
  }
  if (type === 'vote' && m.ww?.votes) {
    const groups = new Map<number | null, number[]>();
    for (const v of m.ww.votes) groups.set(v.target, [...(groups.get(v.target) ?? []), v.voter]);
    const rows = [...groups].sort((a, b) => (a[0] == null ? 1 : b[0] == null ? -1 : b[1].length - a[1].length));
    return (
      <div className="ww-vote">
        <div className="ww-vote-title">
          <Vote /> {m.ww.voteKind === 'sheriff' ? '警长竞选投票' : '放逐投票'}
        </div>
        {rows.map(([target, voters]) => (
          <div key={String(target)} className="ww-vote-row">
            <span className={`ww-vote-target ${target == null ? 'abstain' : ''}`}>{target == null ? '弃票' : seatLabel(target)}</span>
            <span className="ww-vote-voters">
              {voters
                .sort((a, b) => a - b)
                .map((v) => (
                  <span key={v} className={`chip ${v === ww.sheriff && m.ww?.voteKind === 'exile' ? 'chip-strong' : ''}`}>
                    {seatLabel(v)}
                  </span>
                ))}
            </span>
          </div>
        ))}
        <div className="hint">{m.content.split('结果：')[1] ?? ''}</div>
      </div>
    );
  }
  if (type === 'private') {
    const owner = m.visibility?.startsWith('seat:') ? Number(m.visibility.slice(5)) : null;
    const mine = owner === ww.humanSeat;
    return (
      <div className="ww-private">
        <Lock />
        <span>
          <b>{mine ? '只有你知道' : `${owner ? seatLabel(owner) : ''}的私密信息`}：</b>
          {m.content}
        </span>
      </div>
    );
  }
  if (type === 'night') {
    return (
      <div className={`ww-night ${m.visibility === 'wolves' ? 'wolves' : ''}`}>
        <Moon />
        <span>
          <b>{m.visibility === 'wolves' ? '狼队频道' : '上帝视角'}：</b>
          {m.content}
        </span>
      </div>
    );
  }
  return (
    <div className={`ww-announce ${type === 'skill' ? 'skill' : ''} ${type === 'end' ? 'end' : ''} ${m.status === 'streaming' ? 'streaming' : ''}`}>
      <Megaphone />
      <span>{m.content || '…'}</span>
    </div>
  );
}

// ---------------- 轮到你：操作面板 ----------------

const ACTION_TITLES: Record<string, string> = {
  guard: '守卫行动',
  check: '预言家查验',
  shoot: '开枪',
  badge: '移交警徽',
  vote: '投票放逐',
  sheriffVote: '投票选警长',
  whitewolf: '白狼王自爆',
  speech: '轮到你发言',
  pk: 'PK 发言',
  lastWords: '发表遗言',
  sheriffSpeech: '警长竞选发言',
  wolfchat: '狼人夜聊（只有狼人能看到）',
  sheriffRun: '警长竞选',
};

const SKIP_LABELS: Record<string, string> = { guard: '今晚不守', shoot: '不开枪', badge: '撕掉警徽', vote: '弃票', sheriffVote: '弃票' };

function SeatPicker({ room, options, value, onPick }: { room: Room; options: number[]; value: number | null; onPick: (n: number) => void }) {
  const ww = room.werewolf!;
  return (
    <div className="seat-picker">
      {options.map((n) => {
        const s = ww.seats.find((x) => x.seat === n)!;
        return (
          <button key={n} type="button" className={`seat-pick ${value === n ? 'active' : ''}`} onClick={() => onPick(n)}>
            <b>{n}</b>
            <span>{s.human ? '你' : s.name}</span>
          </button>
        );
      })}
    </div>
  );
}

export function WwActionPanel({ room }: { room: Room }) {
  const ww = room.werewolf!;
  const p = ww.pending;
  const [text, setText] = useState('');
  const [pick, setPick] = useState<number | null>(null);
  const [sending, setSending] = useState(false);
  // 新的决定出现时清空上一次的选择
  useEffect(() => {
    setText('');
    setPick(null);
  }, [p?.id]);

  if (!p || p.seat !== ww.humanSeat) return null;
  const send = async (answer: Record<string, unknown>) => {
    setSending(true);
    await attempt(() => post(`/rooms/${room.id}/werewolf/act`, { id: p.id, answer }));
    setSending(false);
  };
  const title = ACTION_TITLES[p.kind === 'target' || p.kind === 'speech' || p.kind === 'yesno' ? p.action : 'witch'] ?? '轮到你了';

  return (
    <div className="ww-action">
      <div className="ww-action-head">
        <span className="badge badge-accent">{title}</span>
        <span className="hint">{p.prompt}</span>
      </div>
      {p.kind === 'target' && <TargetAction room={room} p={p} pick={pick} setPick={setPick} sending={sending} send={send} />}
      {p.kind === 'yesno' && (
        <div className="row">
          <button className="btn btn-primary" disabled={sending} onClick={() => void send({ yes: true })}>
            上警
          </button>
          <button className="btn" disabled={sending} onClick={() => void send({ yes: false })}>
            不上警
          </button>
        </div>
      )}
      {p.kind === 'witch' && (
        <div className="form-stack" style={{ gap: 8 }}>
          {p.canSave && p.victim != null && (
            <button className="btn btn-primary" disabled={sending} onClick={() => void send({ action: 'save' })}>
              用解药救 {seatLabel(p.victim)}
            </button>
          )}
          {p.canPoison && (
            <>
              <span className="hint">或者选一名玩家用毒药：</span>
              <SeatPicker room={room} options={p.options} value={pick} onPick={setPick} />
              <button
                className="btn btn-danger"
                disabled={sending || pick == null}
                onClick={async () => {
                  if (await askConfirm({ title: '使用毒药', message: `确定毒死 ${seatLabel(pick!)}？毒药只有一瓶。`, confirmText: '毒死', danger: true })) void send({ action: 'poison', target: pick });
                }}
              >
                毒死 {pick ? seatLabel(pick) : '…'}
              </button>
            </>
          )}
          <button className="btn" disabled={sending} onClick={() => void send({ action: 'none' })}>
            今晚不用药
          </button>
        </div>
      )}
      {p.kind === 'speech' && <SpeechAction room={room} p={p} text={text} setText={setText} pick={pick} setPick={setPick} sending={sending} send={send} />}
    </div>
  );
}

function TargetAction({
  room,
  p,
  pick,
  setPick,
  sending,
  send,
}: {
  room: Room;
  p: Extract<WwPending, { kind: 'target' }>;
  pick: number | null;
  setPick: (n: number | null) => void;
  sending: boolean;
  send: (a: Record<string, unknown>) => Promise<void>;
}) {
  return (
    <>
      <SeatPicker room={room} options={p.options} value={pick} onPick={setPick} />
      <div className="row">
        <button className="btn btn-primary" disabled={sending || pick == null} onClick={() => void send({ target: pick })}>
          确定{pick ? `：${seatLabel(pick)}` : ''}
        </button>
        {p.allowSkip && (
          <button className="btn" disabled={sending} onClick={() => void send({ target: null })}>
            {SKIP_LABELS[p.action] ?? '不选'}
          </button>
        )}
      </div>
    </>
  );
}

function SpeechAction({
  room,
  p,
  text,
  setText,
  pick,
  setPick,
  sending,
  send,
}: {
  room: Room;
  p: Extract<WwPending, { kind: 'speech' }>;
  text: string;
  setText: (s: string) => void;
  pick: number | null;
  setPick: (n: number | null) => void;
  sending: boolean;
  send: (a: Record<string, unknown>) => Promise<void>;
}) {
  const [extra, setExtra] = useState<'explode' | 'duel' | null>(null);
  const [extraPick, setExtraPick] = useState<number | null>(null);
  const needKill = !!p.killOptions?.length;
  const placeholder =
    p.action === 'wolfchat' ? '和狼队友商量今晚杀谁（只有狼人能看到）…' : p.action === 'lastWords' ? '你的遗言…' : p.action === 'sheriffSpeech' ? '你的竞选发言…' : '你的发言…（可以撒谎、跳身份）';
  return (
    <div className="form-stack" style={{ gap: 8 }}>
      {needKill && (
        <>
          <span className="hint">今晚杀谁：</span>
          <SeatPicker room={room} options={p.killOptions!} value={pick} onPick={setPick} />
        </>
      )}
      <textarea
        rows={3}
        value={text}
        placeholder={placeholder}
        enterKeyHint="send"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229 && (!needKill || pick != null)) {
            e.preventDefault();
            void send({ text, target: pick });
          }
        }}
      />
      {extra && (
        <>
          <span className="hint">{extra === 'duel' ? '和谁决斗：' : '自爆时带走谁：'}</span>
          <SeatPicker room={room} options={(extra === 'duel' ? p.duelOptions : p.explodeOptions) ?? []} value={extraPick} onPick={setExtraPick} />
        </>
      )}
      <div className="row wrap">
        <button className="btn btn-primary" disabled={sending || (needKill && pick == null)} onClick={() => void send({ text, target: pick })}>
          <Send /> {text.trim() ? '发言' : '过'}
        </button>
        {p.canExplode && (
          <button
            className="btn btn-danger"
            disabled={sending}
            onClick={async () => {
              if (p.explodeOptions && extra !== 'explode') return setExtra('explode');
              if (await askConfirm({ title: '自爆', message: '自爆会暴露你是狼人并立刻出局，今天的发言和投票直接结束。确定吗？', confirmText: '自爆', danger: true })) {
                void send({ text, explode: true, explodeTarget: extraPick ?? undefined });
              }
            }}
          >
            <Skull /> {p.explodeOptions && extra === 'explode' ? `自爆${extraPick ? `并带走 ${seatLabel(extraPick)}` : ''}` : '自爆'}
          </button>
        )}
        {!!p.duelOptions?.length && (
          <button
            className="btn"
            disabled={sending || (extra === 'duel' && extraPick == null)}
            onClick={async () => {
              if (extra !== 'duel') return setExtra('duel');
              if (await askConfirm({ title: '骑士决斗', message: `和 ${seatLabel(extraPick!)} 决斗？对方是狼人则对方出局，否则你出局。一局只能用一次。`, confirmText: '决斗', danger: true })) {
                void send({ text, duel: extraPick });
              }
            }}
          >
            <Swords /> {extra === 'duel' ? `和 ${extraPick ? seatLabel(extraPick) : '…'} 决斗` : '翻牌决斗'}
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------- 对局信息（右侧栏） ----------------

export function WwInfoPanel({ room }: { room: Room }) {
  const ww = room.werewolf!;
  const v = viewerOf(ww);
  const me = ww.seats.find((s) => s.seat === ww.humanSeat);
  const showAll = v.god && (ww.humanSeat != null || ww.showRoles || ww.phase === 'end');
  return (
    <div className="panel-section form-stack">
      {me && (
        <div className={`role-card ${isWolf(me.role) ? 'wolf' : ''}`}>
          <div className="role-card-icon">{ROLE_INFO[me.role].icon}</div>
          <div className="grow">
            <div className="role-card-name">
              你是 {seatLabel(me.seat)}：{ROLE_INFO[me.role].name}
              {!me.alive && <span className="badge">已出局</span>}
            </div>
            <div className="hint">{ROLE_INFO[me.role].desc}</div>
            {isWolf(me.role) && (
              <div className="hint">
                狼队友：
                {ww.seats
                  .filter((s) => s.seat !== me.seat && isWolf(s.role))
                  .map((s) => `${seatLabel(s.seat)} ${s.name}`)
                  .join('、')}
              </div>
            )}
            {me.role === 'witch' && (
              <div className="hint">
                解药：{ww.witch.save ? '还在' : '已用'} · 毒药：{ww.witch.poison ? '还在' : '已用'}
              </div>
            )}
            {me.role === 'seer' && ww.nights.some((n) => n.check) && (
              <div className="hint">
                查验：
                {ww.nights
                  .filter((n) => n.check)
                  .map((n) => `${seatLabel(n.check!.target)} ${n.check!.wolf ? '狼人' : '好人'}`)
                  .join('，')}
              </div>
            )}
          </div>
        </div>
      )}
      {!me && <div className="callout callout-info"><Eye /><span>你在旁观这局（上帝视角）。{ww.showRoles ? '' : '身份现在是隐藏的，可以在「设置」里打开。'}</span></div>}

      <Field label="本局角色" hint={`（${ww.seats.length} 人 · ${ww.winRule === 'edge' ? '屠边' : '屠城'}${ww.sheriffEnabled ? ' · 有警长' : ''}）`}>
        <div className="role-list">
          {ROLE_ORDER.filter((r) => (ww.roles[r] ?? 0) > 0).map((r) => (
            <div key={r} className="role-row">
              <span className="role-row-icon">{ROLE_INFO[r].icon}</span>
              <div className="grow">
                <b>
                  {ROLE_INFO[r].name}
                  {(ww.roles[r] ?? 0) > 1 ? ` ×${ww.roles[r]}` : ''}
                </b>
                <div className="hint">{ROLE_INFO[r].desc}</div>
              </div>
            </div>
          ))}
        </div>
      </Field>

      {showAll && (
        <Field label="上帝视角" hint="（所有人的身份和每晚发生的事）">
          <div className="role-list">
            {ww.seats.map((s) => (
              <div key={s.seat} className={`role-row ${s.alive ? '' : 'dead'}`}>
                <span className="role-row-icon">{ROLE_INFO[s.role].icon}</span>
                <div className="grow">
                  <b>
                    {seatLabel(s.seat)} {s.human ? `${s.name}（你）` : s.name}：{ROLE_INFO[s.role].name}
                  </b>
                  {!s.alive && <div className="hint">第 {s.death!.day} 天 · {DEATH_LABELS[s.death!.cause]}</div>}
                </div>
              </div>
            ))}
          </div>
          {ww.nights.map((n) => (
            <div key={n.day} className="hint night-log">
              <b>第 {n.day} 夜：</b>
              {[
                n.guard !== undefined ? `守卫守 ${n.guard ? seatLabel(n.guard) : '无人'}` : '',
                n.wolfKill !== undefined ? `狼人刀 ${n.wolfKill ? seatLabel(n.wolfKill) : '无人'}` : '',
                n.saved ? '女巫救人' : '',
                n.poison ? `女巫毒 ${seatLabel(n.poison)}` : '',
                n.check ? `预言家验 ${seatLabel(n.check.target)}（${n.check.wolf ? '狼' : '好人'}）` : '',
                n.deaths.length ? `出局 ${n.deaths.map((d) => seatLabel(d.seat)).join('、')}` : '平安夜',
              ]
                .filter(Boolean)
                .join(' · ')}
            </div>
          ))}
        </Field>
      )}
    </div>
  );
}

export function WwSettingsPanel({ room }: { room: Room }) {
  const ww = room.werewolf!;
  const set = (body: Record<string, unknown>) => attempt(() => patch(`/rooms/${room.id}/werewolf`, body));
  const [model, setModel] = useState(ww.narratorModel);
  return (
    <div className="panel-section form-stack">
      <Field label="播报" hint="（天亮公告、放逐结果、游戏结束）">
        <Segmented
          value={ww.narration}
          onChange={(v) => void set({ narration: v })}
          options={[
            { value: 'fixed', label: '固定文字' },
            { value: 'ai', label: 'AI 主持人' },
          ]}
        />
        {ww.narration === 'ai' && (
          <>
            <ModelInput value={model} onChange={setModel} showStatus={false} />
            {model !== ww.narratorModel && (
              <button className="btn btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => void set({ narratorModel: model })}>
                使用这个模型
              </button>
            )}
            <span className="hint">规则仍然由程序结算；AI 主持人只负责把结果说得有氛围，后面会附上准确的结果。</span>
          </>
        )}
      </Field>
      <Field label={`节奏：每一步之间停 ${(ww.pace / 1000).toFixed(1)} 秒`}>
        <input type="range" min={0} max={3000} step={100} value={ww.pace} onChange={(e) => void set({ pace: Number(e.target.value) })} />
      </Field>
      {ww.humanSeat == null && (
        <ToggleRow label="显示每个人的身份" hint="旁观时的上帝视角；想自己猜就关掉" checked={ww.showRoles} onChange={(v) => void set({ showRoles: v })} />
      )}
      <div className="hint">AI 玩家的模型和思考强度在「AI」页修改，从下一次发言开始生效。</div>
    </div>
  );
}

// ---------------- 开局前 ----------------

export function WwSetupCard({ room, onStart }: { room: Room; onStart: () => void }) {
  const ww = room.werewolf!;
  const me = ww.seats.find((s) => s.seat === ww.humanSeat);
  return (
    <div className="setup-card">
      <h2>
        <Users style={{ width: 20, height: 20, color: '#a78bfa' }} /> {ww.boardName}
      </h2>
      <div className="scenario-intro">
        {ww.seats.length} 人局：{rolesText(ww.roles)}。{ww.winRule === 'edge' ? '狼人杀光所有神职或所有平民获胜（屠边）' : '狼人杀光所有好人获胜（屠城）'}，好人放逐所有狼人获胜。
        {ww.sheriffEnabled ? '第一天先竞选警长。' : ''}
      </div>
      {me ? (
        <div className="player-info">
          <div>
            你是 <b>{seatLabel(me.seat)}</b>，身份：
            <b>
              {ROLE_INFO[me.role].icon} {ROLE_INFO[me.role].name}
            </b>
            ——{ROLE_INFO[me.role].desc}
            {isWolf(me.role) && ww.seats.filter((s) => s.seat !== me.seat && isWolf(s.role)).length > 0 && (
              <> 你的狼队友：{ww.seats.filter((s) => s.seat !== me.seat && isWolf(s.role)).map((s) => `${seatLabel(s.seat)} ${s.name}`).join('、')}。</>
            )}
          </div>
        </div>
      ) : (
        <p className="hint">你在旁观：所有座位都是 AI，你能看到每个人的身份和夜里发生的事（可以在设置里隐藏身份）。</p>
      )}
      <p className="hint" style={{ fontSize: 13 }}>
        <b style={{ color: 'var(--text)' }}>怎么玩？</b> 法官（程序）负责发身份、夜里结算、安排发言和计票。
        {me ? '轮到你行动时，下方会出现操作面板；夜里只有你的身份需要行动时才会问你。' : '点「开始游戏」，AI 们就会开始一局。'}
        右上角可以暂停，右侧「对局」页有角色说明。
      </p>
      <div className="row wrap">
        <button className="btn btn-primary btn-lg" onClick={onStart}>
          <Play /> 开始游戏
        </button>
      </div>
    </div>
  );
}

export async function restartWerewolf(room: Room) {
  const ok = await askConfirm({ title: '再来一局', message: '用同样的玩家和板子重新发身份，开始新的一局？这一局的记录会清空（需要的话先导出）。', confirmText: '再来一局' });
  if (ok) await attempt(() => post(`/rooms/${room.id}/werewolf/restart`));
}
