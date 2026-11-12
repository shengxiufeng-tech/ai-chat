// 文件指纹：认出「同一个剧本文件」。不用 crypto.subtle，因为手机通过局域网（http）打开时浏览器不提供它；
// 这里用两路 32 位混合哈希，加上文件大小，碰撞的概率可以忽略。

export function bytesHash(b: Uint8Array): string {
  let h1 = 0x811c9dc5 ^ b.length;
  let h2 = 0x01000193 ^ (b.length * 31);
  const words = b.length >> 2;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  for (let i = 0; i < words; i++) {
    const k = dv.getUint32(i * 4, true);
    h1 = Math.imul(h1 ^ k, 2654435761);
    h1 = (h1 << 13) | (h1 >>> 19);
    h2 = Math.imul(h2 ^ k, 1597334677);
    h2 = (h2 << 15) | (h2 >>> 17);
  }
  for (let i = words * 4; i < b.length; i++) {
    h1 = Math.imul(h1 ^ b[i], 2654435761);
    h2 = Math.imul(h2 ^ b[i], 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const hex = (n: number) => (n >>> 0).toString(16).padStart(8, '0');
  return `${b.length.toString(36)}-${hex(h2)}${hex(h1)}`;
}

export async function fileHash(file: Blob) {
  return bytesHash(new Uint8Array(await file.arrayBuffer()));
}

export const textHash = (text: string) => `t-${bytesHash(new TextEncoder().encode(text.trim()))}`;
