import { Check, ChevronDown } from 'lucide-react';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { ModelInfo } from '../../../shared/types';
import { useModels } from '../models';

/** provider/model → [provider, model] */
function splitId(id: string): [string, string] {
  const i = id.indexOf('/');
  return i > 0 ? [id.slice(0, i), id.slice(i + 1)] : ['', id];
}

/** 按输入的关键词筛选：每个词都要出现在 id 或名字里，名字开头匹配的排前面 */
export function filterModels(models: ModelInfo[], query: string): ModelInfo[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return models;
  const hit = models.filter((m) => {
    const hay = `${m.id} ${m.name ?? ''}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
  const first = terms[0];
  const score = (m: ModelInfo) => (splitId(m.id)[1].toLowerCase().startsWith(first) ? 0 : 1);
  return [...hit].sort((a, b) => score(a) - score(b));
}

/** 完整列表按服务商分组（保持每组第一次出现的顺序） */
function groupByProvider(models: ModelInfo[]): ModelInfo[] {
  const order = new Map<string, number>();
  for (const m of models) {
    const g = splitId(m.id)[0];
    if (!order.has(g)) order.set(g, order.size);
  }
  return models
    .map((m, i) => ({ m, i, g: order.get(splitId(m.id)[0])! }))
    .sort((a, b) => a.g - b.g || a.i - b.i)
    .map((x) => x.m);
}

type Pos = { left: number; width: number; top?: number; bottom?: number; maxHeight: number };

/**
 * 模型选择：可以从 Magpie 的模型列表里选，也可以直接输入。
 * 下拉列表是自己画的，不用浏览器的 datalist（有的手机浏览器会把它显示成一排空白方块）。
 */
export function ModelInput({
  value,
  onChange,
  placeholder = '从列表选择，或直接输入模型 id',
  showStatus = true,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  showStatus?: boolean;
}) {
  const listId = useId();
  const { models, error, loading } = useModels();
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  // null：刚打开，显示全部；字符串：用户正在输入，按它筛选
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(-1);
  const [pos, setPos] = useState<Pos | null>(null);

  const grouped = useMemo(() => groupByProvider(models), [models]);
  const list = useMemo(() => (query === null ? grouped : filterModels(models, query)), [grouped, models, query]);
  // 筛选结果按匹配程度排序，不再分组，服务商写在每一项后面
  const showGroups = query === null;

  const openList = (q: string | null) => {
    setQuery(q);
    setOpen(true);
    const items = q === null ? grouped : filterModels(models, q);
    setActive(q === null ? items.findIndex((m) => m.id === value) : items.length ? 0 : -1);
  };
  const close = () => {
    setOpen(false);
    setQuery(null);
  };
  const choose = (m: ModelInfo) => {
    onChange(m.id);
    close();
  };

  // 列表用 fixed 定位，避免被弹窗的滚动区域裁掉；放不下时向上展开
  const place = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vh = window.visualViewport?.height ?? window.innerHeight;
    const below = vh - r.bottom - 10;
    const above = r.top - 10;
    const up = below < 220 && above > below;
    const width = Math.max(r.width, Math.min(300, window.innerWidth - 16));
    const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
    setPos(
      up
        ? { left, width, bottom: window.innerHeight - r.top + 4, maxHeight: Math.min(340, above) }
        : { left, width, top: r.bottom + 4, maxHeight: Math.min(340, below) },
    );
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    place();
    const onMove = (e: Event) => {
      // 列表自己滚动时不用重新定位
      if (e.target instanceof Node && listRef.current?.contains(e.target)) return;
      place();
    };
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    window.visualViewport?.addEventListener('resize', onMove);
    return () => {
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
      window.visualViewport?.removeEventListener('resize', onMove);
    };
  }, [open, place]);

  // 点外面就收起
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) close();
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  // 键盘上下移动时，让高亮的那一项保持可见
  useEffect(() => {
    if (!open || active < 0) return;
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active, pos]);

  let lastGroup: string | null = null;

  return (
    <>
      <div className="combo" ref={wrapRef}>
        <input
          ref={inputRef}
          value={value}
          placeholder={placeholder}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          onFocus={() => openList(null)}
          onChange={(e) => {
            onChange(e.target.value);
            openList(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              if (!open) return openList(null);
              if (!list.length) return;
              const d = e.key === 'ArrowDown' ? 1 : -1;
              setActive((i) => (i < 0 ? (d > 0 ? 0 : list.length - 1) : (i + d + list.length) % list.length));
            } else if (e.key === 'Enter' && open) {
              if (active >= 0 && list[active]) {
                e.preventDefault();
                choose(list[active]);
              } else close();
            } else if (e.key === 'Escape' && open) {
              e.preventDefault();
              e.stopPropagation();
              close();
            } else if (e.key === 'Tab') close();
          }}
        />
        <button
          type="button"
          className="combo-toggle"
          tabIndex={-1}
          aria-label={open ? '收起模型列表' : '展开模型列表'}
          // 只展开列表，不弹出手机键盘
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => (open ? close() : openList(null))}
        >
          <ChevronDown />
        </button>
        {open && pos && (
          <div
            ref={listRef}
            id={listId}
            role="listbox"
            className="combo-list"
            style={{ left: pos.left, width: pos.width, top: pos.top, bottom: pos.bottom, maxHeight: pos.maxHeight } as CSSProperties}
            // 点列表时输入框不要失去焦点
            onPointerDown={(e) => e.preventDefault()}
          >
            {loading && !models.length ? (
              <div className="combo-empty">正在读取模型列表…</div>
            ) : error && !models.length ? (
              <div className="combo-empty">读取模型列表失败，可以直接输入模型 id。</div>
            ) : !list.length ? (
              <div className="combo-empty">没有匹配的模型，会直接使用你输入的「{value}」。</div>
            ) : (
              list.map((m, i) => {
                const [group, short] = splitId(m.id);
                const header = showGroups && group !== lastGroup ? (lastGroup = group) : null;
                return (
                  <div key={m.id}>
                    {header !== null && <div className="combo-group">{header || '其他'}</div>}
                    <button
                      type="button"
                      role="option"
                      aria-selected={m.id === value}
                      data-index={i}
                      className={`combo-option ${i === active ? 'active' : ''} ${m.id === value ? 'selected' : ''}`}
                      onMouseEnter={() => setActive(i)}
                      onClick={() => choose(m)}
                      title={m.id}
                    >
                      <span className="combo-name">{m.name && m.name !== m.id && m.name !== short ? m.name : short}</span>
                      {m.reasoning && <span className="badge">推理</span>}
                      <span className="spacer" />
                      {!showGroups && group && <span className="combo-meta">{group}</span>}
                      {m.contextWindow ? <span className="combo-meta">{Math.round(m.contextWindow / 1000)}k</span> : null}
                      {m.id === value && <Check className="combo-check" />}
                    </button>
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>
      {showStatus && (
        <span className="hint">
          {loading ? '正在读取模型列表…' : error ? `读取模型列表失败：${error}` : `共 ${models.length} 个可用模型`}
        </span>
      )}
    </>
  );
}
