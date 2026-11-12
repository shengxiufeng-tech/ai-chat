// 在浏览器里读 PDF（pdf.js）：每页取出文字层、统计图片数量、渲染成 JPEG。
// 只有选了 PDF 才加载 pdf.js，平时不占体积。

import type { PDFDocumentProxy } from 'pdfjs-dist';

type PdfLib = typeof import('pdfjs-dist');
let lib: PdfLib | null = null;

async function pdfjs(): Promise<PdfLib> {
  if (!lib) {
    const [m, worker] = await Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]);
    m.GlobalWorkerOptions.workerSrc = worker.default;
    lib = m;
  }
  return lib;
}

export async function openPdf(file: File): Promise<PDFDocumentProxy> {
  const m = await pdfjs();
  try {
    return await m.getDocument({
      data: new Uint8Array(await file.arrayBuffer()),
      cMapUrl: '/api/pdfjs/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: '/api/pdfjs/standard_fonts/',
    }).promise;
  } catch (err) {
    const name = (err as { name?: string })?.name;
    if (name === 'PasswordException') throw new Error('这个 PDF 有密码保护，请先去掉密码再导入');
    if (name === 'InvalidPDFException') throw new Error('这个文件不是有效的 PDF');
    throw err;
  }
}

export interface PdfPage {
  text: string;
  images: number;
  jpeg: Blob;
}

/** 读一页：文字层 + 图片数量 + 整页图片（长边 maxSide 像素） */
export async function readPdfPage(doc: PDFDocumentProxy, n: number, maxSide = 2000): Promise<PdfPage> {
  const m = await pdfjs();
  const page = await doc.getPage(n);
  try {
    const tc = await page.getTextContent();
    let text = '';
    for (const item of tc.items) {
      if (!('str' in item)) continue;
      text += item.str;
      if (item.hasEOL) text += '\n';
    }
    const ops = await page.getOperatorList();
    const imageOps = new Set([m.OPS.paintImageXObject, m.OPS.paintInlineImageXObject, m.OPS.paintImageMaskXObject]);
    const images = ops.fnArray.filter((fn) => imageOps.has(fn)).length;

    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(4, maxSide / Math.max(base.width, base.height)) });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas, canvasContext: ctx, viewport }).promise;
    const jpeg = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('页面渲染失败'))), 'image/jpeg', 0.85),
    );
    // 尽快释放内存（手机上很重要）
    canvas.width = 0;
    canvas.height = 0;
    return { text, images, jpeg };
  } finally {
    page.cleanup();
  }
}

export function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error('读取图片失败'));
    r.readAsDataURL(blob);
  });
}
