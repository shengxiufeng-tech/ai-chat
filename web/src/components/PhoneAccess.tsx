import { Copy, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { get, post } from '../api';
import { copyText } from '../clipboard';
import { askConfirm } from '../confirm';
import { attempt, toast } from '../toast';
import { Field } from './ui';

interface AccessInfo {
  lan: boolean;
  port: number;
  code: string;
  urls: { url: string; qr: string }[];
}

/** 设置里的「手机访问」：显示局域网地址、二维码和访问码 */
export function PhoneAccess() {
  const [info, setInfo] = useState<AccessInfo | null>(null);
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    void attempt(() => get<AccessInfo>('/access')).then((x) => x && setInfo(x));
  }, []);

  if (!info) return null;
  const current = info.urls[idx] ?? info.urls[0];

  const reset = async () => {
    const ok = await askConfirm({
      title: '重置访问码',
      message: '换一个新的访问码？已经登录的手机需要重新扫码或输入新的访问码。',
      confirmText: '重置',
    });
    if (!ok) return;
    const r = await attempt(() => post<AccessInfo>('/access/reset'));
    if (r) {
      setInfo(r);
      toast('访问码已重置');
    }
  };

  return (
    <Field label="手机访问" hint="（手机和电脑连同一个 Wi-Fi）">
      {!info.lan ? (
        <span className="hint">
          现在只有这台电脑能打开。想用手机（连同一个 Wi-Fi）访问的话，关掉当前的服务，改用 <code>npm run lan</code> 启动，然后回到这里扫码。
        </span>
      ) : !current ? (
        <span className="hint">局域网访问已开启，但没有找到这台电脑的局域网 IP，请确认电脑已经连上 Wi-Fi 或网线。</span>
      ) : !info.code ? (
        <span className="hint">
          你正在用手机访问：<code>{current.url}</code>。查看或重置访问码请在电脑上打开设置。
        </span>
      ) : (
        <div className="phone-access">
          <div className="phone-qr" dangerouslySetInnerHTML={{ __html: current.qr }} aria-label="手机扫码打开" />
          <div className="form-stack" style={{ gap: 8, minWidth: 0 }}>
            <span className="hint">手机和电脑连同一个 Wi-Fi，用相机扫左边的二维码就能打开，不用输入访问码。</span>
            <div className="phone-row">
              <span className="phone-label">地址</span>
              <code className="phone-value">{current.url}</code>
              <button className="icon-btn sm" title="复制地址" onClick={() => void copyText(current.url).then(() => toast('地址已复制'))}>
                <Copy />
              </button>
            </div>
            {info.urls.length > 1 && (
              <div className="row wrap" style={{ gap: 4 }}>
                <span className="hint">这台电脑有多个网络地址，扫不开可以换一个：</span>
                {info.urls.map((u, i) => (
                  <button key={u.url} className={`chip ${i === idx ? 'active' : ''}`} onClick={() => setIdx(i)}>
                    {new URL(u.url).hostname}
                  </button>
                ))}
              </div>
            )}
            <div className="phone-row">
              <span className="phone-label">访问码</span>
              <code className="phone-value phone-code">{info.code}</code>
              <button className="icon-btn sm" title="换一个新的访问码" onClick={reset}>
                <RefreshCw />
              </button>
            </div>
            <span className="hint">手动输入地址的话，第一次打开需要输入访问码，之后手机会记住。打不开时检查电脑防火墙是否允许 Node.js 接受局域网连接。</span>
          </div>
        </div>
      )}
    </Field>
  );
}
