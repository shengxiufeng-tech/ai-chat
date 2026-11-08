// 后端接口封装

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    // 没有 JSON 内容
  }
  if (!res.ok) throw new Error(data?.error || `请求失败（${res.status}）`);
  return data as T;
}

export const get = <T,>(path: string) => api<T>('GET', path);
export const post = <T,>(path: string, body: unknown = {}) => api<T>('POST', path, body);
export const patch = <T,>(path: string, body: unknown) => api<T>('PATCH', path, body);
export const put = <T,>(path: string, body: unknown) => api<T>('PUT', path, body);
export const del = <T,>(path: string) => api<T>('DELETE', path);
