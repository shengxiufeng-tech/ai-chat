// 复制到剪贴板：优先用 Clipboard API，不可用（没有权限、非安全上下文）时退回旧方法

import { toast } from './toast';

export async function copyText(text: string, okMessage?: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    if (!ok) {
      toast('复制失败：浏览器不允许访问剪贴板', 'error');
      return false;
    }
  }
  if (okMessage) toast(okMessage);
  return true;
}
