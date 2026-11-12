// 图片处理（纯 JavaScript，不需要装系统软件）：解码 JPEG、按相对坐标裁切、缩小、再编码

import jpeg from 'jpeg-js';

export interface RawImage {
  width: number;
  height: number;
  data: Uint8Array;
}

/** 0~1000 的相对坐标：left / top 是左上角，right / bottom 是右下角 */
export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export function decodeJpeg(buf: Buffer | Uint8Array): RawImage {
  const img = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 1024, maxResolutionInMP: 200 });
  return { width: img.width, height: img.height, data: img.data };
}

export function encodeJpeg(img: RawImage, quality = 85): Buffer {
  return Buffer.from(jpeg.encode({ width: img.width, height: img.height, data: img.data }, quality).data);
}

/** 把模型给的坐标整理成合法的框：限制在 0~1000，左上角在右下角之前，至少有一点大小 */
export function normalizeBox(b: Partial<Box>): Box {
  const n = (v: unknown, d: number) => {
    const x = Number(v);
    return Number.isFinite(x) ? Math.min(1000, Math.max(0, x)) : d;
  };
  let left = n(b.left, 0);
  let right = n(b.right, 1000);
  let top = n(b.top, 0);
  let bottom = n(b.bottom, 1000);
  if (left > right) [left, right] = [right, left];
  if (top > bottom) [top, bottom] = [bottom, top];
  if (right - left < 10) right = Math.min(1000, left + 10);
  if (bottom - top < 10) bottom = Math.min(1000, top + 10);
  return { left, top, right, bottom };
}

export function crop(img: RawImage, box: Box): RawImage {
  const b = normalizeBox(box);
  const x0 = Math.floor((b.left / 1000) * img.width);
  const y0 = Math.floor((b.top / 1000) * img.height);
  const x1 = Math.max(x0 + 1, Math.min(img.width, Math.ceil((b.right / 1000) * img.width)));
  const y1 = Math.max(y0 + 1, Math.min(img.height, Math.ceil((b.bottom / 1000) * img.height)));
  const width = x1 - x0;
  const height = y1 - y0;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const src = ((y0 + y) * img.width + x0) * 4;
    data.set(img.data.subarray(src, src + width * 4), y * width * 4);
  }
  return { width, height, data };
}

/** 缩小到长边不超过 maxSide（区域平均，文字比较清楚）；本来就小的不放大 */
export function fit(img: RawImage, maxSide: number): RawImage {
  const scale = maxSide / Math.max(img.width, img.height);
  if (scale >= 1) return img;
  const width = Math.max(1, Math.round(img.width * scale));
  const height = Math.max(1, Math.round(img.height * scale));
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const sy0 = Math.floor(y / scale);
    const sy1 = Math.max(sy0 + 1, Math.min(img.height, Math.floor((y + 1) / scale)));
    for (let x = 0; x < width; x++) {
      const sx0 = Math.floor(x / scale);
      const sx1 = Math.max(sx0 + 1, Math.min(img.width, Math.floor((x + 1) / scale)));
      let r = 0;
      let g = 0;
      let bl = 0;
      let count = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        let i = (sy * img.width + sx0) * 4;
        for (let sx = sx0; sx < sx1; sx++, i += 4) {
          r += img.data[i];
          g += img.data[i + 1];
          bl += img.data[i + 2];
          count++;
        }
      }
      const o = (y * width + x) * 4;
      data[o] = r / count;
      data[o + 1] = g / count;
      data[o + 2] = bl / count;
      data[o + 3] = 255;
    }
  }
  return { width, height, data };
}

export const jpegDataUrl = (buf: Buffer) => `data:image/jpeg;base64,${buf.toString('base64')}`;
