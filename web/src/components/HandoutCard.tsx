import { Map as MapIcon, ScrollText, X, ZoomIn } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ASSET_KIND_LABELS, type AssetKind } from '../../../shared/types';

export const assetUrl = (roomId: string, assetId: string) => `/api/rooms/${roomId}/assets/${assetId}`;

/** 点开看大图 */
export function Lightbox({ src, title, onClose }: { src: string; title: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="lightbox" onClick={onClose} role="dialog" aria-label={title}>
      <div className="lightbox-bar">
        <span>{title}</span>
        <button className="icon-btn" aria-label="关闭">
          <X />
        </button>
      </div>
      <img src={src} alt={title} onClick={(e) => e.stopPropagation()} />
    </div>
  );
}

/** 对话里：守秘人展示的手出物 / 地图 */
export function HandoutCard({ roomId, asset }: { roomId: string; asset: { id: string; title: string; kind: AssetKind } }) {
  const [open, setOpen] = useState(false);
  const src = assetUrl(roomId, asset.id);
  const label = ASSET_KIND_LABELS[asset.kind];
  return (
    <div className="roll-row">
      <figure className="handout-card">
        <div className="handout-head">
          {asset.kind === 'map' ? <MapIcon /> : <ScrollText />}
          <span>
            守秘人展示了{label}
            <b>「{asset.title}」</b>
          </span>
        </div>
        <button className="handout-img" onClick={() => setOpen(true)} title="点击放大">
          <img src={src} alt={asset.title} loading="lazy" />
          <span className="handout-zoom">
            <ZoomIn /> 放大
          </span>
        </button>
      </figure>
      {open && <Lightbox src={src} title={`${label}「${asset.title}」`} onClose={() => setOpen(false)} />}
    </div>
  );
}
