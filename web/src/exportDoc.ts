// 导出：文档样式（图片 / HTML 共用）和文本格式

import { kpDisplayText } from '../../shared/coc';
import { effortLabel, type Message, type Room } from '../../shared/types';

export interface ExportOptions {
  modelInfo: boolean;
  time: boolean;
  reasoning: boolean;
  scenario: boolean;
  rolls: boolean;
  theme: 'light' | 'dark';
}

export const isKpMessage = (room: Room, m: Message) =>
  room.mode === 'trpg' && room.participants.some((p) => p.id === m.participantId && p.role === 'kp');

/** 显示用的消息正文（去掉守秘人指令） */
export function displayContent(room: Room, m: Message) {
  return isKpMessage(room, m) ? kpDisplayText(m.content) : m.content.trim();
}

export function speakerOf(room: Room, m: Message) {
  if (m.role === 'human' && room.mode === 'trpg' && !m.ooc) return room.trpg?.sheets.player?.name ?? m.speakerName;
  return m.speakerName;
}

const fmtTime = (ts: number) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

export function toMarkdown(room: Room, messages: Message[], o: ExportOptions) {
  const lines = [`# ${room.title}`, ''];
  if (o.scenario && room.scenario.trim()) lines.push(`> ${room.scenario.trim().replace(/\n/g, '\n> ')}`, '');
  if (room.participants.length) {
    lines.push('**参与者**', '');
    for (const p of room.participants) {
      const model = o.modelInfo ? `（${p.model}${p.reasoningEffort ? ` · 思考强度 ${effortLabel(p.reasoningEffort)}` : ''}）` : '';
      lines.push(`- ${p.avatar} **${p.name}**${model}${p.bio ? `：${p.bio}` : ''}`);
    }
    lines.push('');
  }
  lines.push('---', '');
  for (const m of messages) {
    if (m.kind === 'roll' || m.kind === 'note') {
      if (o.rolls) lines.push(`> ${m.kind === 'note' ? '📒' : '🎲'} ${m.content}`, '');
      continue;
    }
    const text = displayContent(room, m);
    if (!text) continue;
    const who = m.role === 'human' ? `🧑 ${speakerOf(room, m)}${m.ooc ? '（场外）' : ''}` : `${m.avatar ?? '🤖'} ${m.speakerName}`;
    const meta = [
      o.modelInfo && m.model ? `\`${m.model}${m.reasoningEffort ? ` · ${effortLabel(m.reasoningEffort)}` : ''}\`` : '',
      o.time ? fmtTime(m.createdAt) : '',
      m.status === 'interrupted' ? '（被打断）' : '',
    ]
      .filter(Boolean)
      .join(' · ');
    lines.push(`**${who}**${meta ? ` ${meta}` : ''}`, '');
    if (o.reasoning && m.reasoning) lines.push('<details><summary>思考过程</summary>', '', m.reasoning.trim(), '', '</details>', '');
    lines.push(text, '');
  }
  lines.push('---', '', `*导出自 AI 对话室 · ${fmtTime(Date.now())}*`);
  return lines.join('\n');
}

export function toPlainText(room: Room, messages: Message[], o: ExportOptions) {
  const out = [`【${room.title}】`, ''];
  for (const m of messages) {
    if (m.kind === 'roll' || m.kind === 'note') {
      if (o.rolls) out.push(`${m.kind === 'note' ? '📒' : '🎲'} ${m.content}`, '');
      continue;
    }
    const text = displayContent(room, m);
    if (!text) continue;
    out.push(`${speakerOf(room, m)}${m.ooc ? '（场外）' : ''}：${text}`, '');
  }
  return out.join('\n').trim();
}

export function download(filename: string, data: Blob | string, type = 'text/plain;charset=utf-8') {
  const blob = typeof data === 'string' ? new Blob([data], { type }) : data;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename.replace(/[\\/:*?"<>|]/g, '_');
  a.style.display = 'none';
  // 部分浏览器要求链接在页面里才会使用 download 指定的文件名
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

/** 导出文档的样式：既用于预览 / 图片，也内嵌进 HTML 文件 */
export const EXPORT_CSS = `
.export-doc{--bg:#ffffff;--surface:#f6f7f9;--border:#e5e7eb;--text:#111827;--text2:#4b5563;--text3:#9ca3af;--accent:#5866f0;--accentSoft:#eef0ff;
  width:720px;background:var(--bg);color:var(--text);padding:36px 40px 28px;border-radius:16px;
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei','Noto Sans CJK SC',sans-serif;
  font-size:14.5px;line-height:1.7;box-sizing:border-box}
.export-doc.theme-dark{--bg:#12151c;--surface:#1a1e28;--border:#2a303c;--text:#e9ebf1;--text2:#a3a9b8;--text3:#6c7385;--accent:#8b98ff;--accentSoft:#1f2541}
.export-doc *{box-sizing:border-box}
.export-doc .x-head{border-bottom:1px solid var(--border);padding-bottom:18px;margin-bottom:22px}
.export-doc .x-kicker{font-size:12px;color:var(--accent);font-weight:600;letter-spacing:.06em;margin-bottom:4px}
.export-doc h1{font-size:24px;margin:0 0 6px;letter-spacing:-.01em;line-height:1.3}
.export-doc .x-meta{font-size:12.5px;color:var(--text3)}
.export-doc .x-cast{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px}
.export-doc .x-pill{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--border);background:var(--surface);border-radius:999px;padding:2px 10px 2px 4px;font-size:12px}
.export-doc .x-pill .a{width:20px;height:20px;border-radius:50%;display:inline-grid;place-items:center;font-size:12px;background:var(--bg)}
.export-doc .x-pill .m{color:var(--text3);font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px}
.export-doc .x-scenario{margin:14px 0 0;padding:10px 14px;border-left:3px solid var(--accent);background:var(--surface);border-radius:8px;color:var(--text2);font-size:13px;white-space:pre-wrap}
.export-doc .x-msgs{display:flex;flex-direction:column;gap:16px}
.export-doc .x-msg{display:flex;gap:12px}
.export-doc .x-msg.h{flex-direction:row-reverse}
.export-doc .x-av{flex:none;width:34px;height:34px;border-radius:11px;display:grid;place-items:center;font-size:18px;background:var(--surface);border:1px solid var(--border)}
.export-doc .x-body{min-width:0;max-width:calc(100% - 46px);display:flex;flex-direction:column;gap:4px}
.export-doc .x-msg.h .x-body{align-items:flex-end}
.export-doc .x-who{display:flex;align-items:center;gap:7px;font-size:12px;color:var(--text3);flex-wrap:wrap}
.export-doc .x-name{font-weight:650;font-size:13px}
.export-doc .x-model{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;border:1px solid var(--border);border-radius:5px;padding:0 6px;color:var(--text2);background:var(--surface)}
.export-doc .x-bubble{background:var(--surface);border:1px solid var(--border);border-radius:4px 14px 14px 14px;padding:9px 14px;position:relative}
.export-doc .x-msg.a .x-bubble{border-left:3px solid var(--c)}
.export-doc .x-msg.h .x-bubble{background:var(--accentSoft);border-radius:14px 4px 14px 14px}
.export-doc .x-msg.ooc .x-bubble{border-style:dashed;background:transparent;color:var(--text2)}
.export-doc .x-bubble p{margin:0 0 .6em}.export-doc .x-bubble>:last-child{margin-bottom:0}.export-doc .x-bubble>:first-child{margin-top:0}
.export-doc .x-bubble ul,.export-doc .x-bubble ol{margin:.3em 0 .6em;padding-left:1.4em}
.export-doc .x-bubble pre{background:var(--bg);border:1px solid var(--border);padding:8px 10px;border-radius:8px;overflow-x:auto;font-size:12.5px}
.export-doc .x-bubble blockquote{margin:.4em 0;padding-left:10px;border-left:3px solid var(--border);color:var(--text2)}
.export-doc .x-bubble table{border-collapse:collapse}.export-doc .x-bubble th,.export-doc .x-bubble td{border:1px solid var(--border);padding:3px 8px}
.export-doc .x-tip{margin-top:8px;padding:6px 10px;border-radius:8px;background:var(--accentSoft);color:var(--accent);font-size:12.5px}
.export-doc .x-think{font-size:12px;color:var(--text3);border-left:2px solid var(--border);padding-left:10px;white-space:pre-wrap;margin:2px 0}
.export-doc details.x-think{border:none;padding:0}
.export-doc details.x-think summary{cursor:pointer}
.export-doc details.x-think div{border-left:2px solid var(--border);padding-left:10px;margin-top:4px}
.export-doc .x-roll{align-self:center;font-size:12.5px;color:var(--text2);background:var(--surface);border:1px solid var(--border);border-radius:999px;padding:4px 14px;max-width:92%;text-align:center}
.export-doc .x-roll b{color:var(--text)}
.export-doc .x-foot{margin-top:26px;padding-top:14px;border-top:1px solid var(--border);font-size:11.5px;color:var(--text3);display:flex;justify-content:space-between}
body.x-page{margin:0;padding:32px 16px;background:#e9ebf0;display:flex;justify-content:center}
body.x-page.dark{background:#07080b}
`;

export function toHtml(room: Room, docHtml: string, theme: 'light' | 'dark') {
  const title = room.title.replace(/[<>&]/g, '');
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>${EXPORT_CSS}
@media (max-width:760px){body.x-page{padding:0}.export-doc{width:100%;border-radius:0;padding:24px 16px}}</style>
</head>
<body class="x-page ${theme}">
${docHtml}
</body>
</html>`;
}
