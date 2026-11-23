// 粗略估算 token 数（前后端共用）

function isWide(code: number) {
  return (
    (code >= 0x2e80 && code <= 0x9fff) || // 中日韩文字和标点
    (code >= 0xac00 && code <= 0xd7af) || // 韩文
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xff00 && code <= 0xffef) // 全角符号
  );
}

/**
 * 粗略估算 token 数（没有各家的分词器，宁可估多一点）：
 * 中日韩字符每个算 1 个 token，其他字符每 3.5 个算 1 个。
 */
export function estimateTokens(text: string) {
  let wide = 0;
  for (let i = 0; i < text.length; i++) if (isWide(text.charCodeAt(i))) wide++;
  return Math.ceil(wide + (text.length - wide) / 3.5);
}
