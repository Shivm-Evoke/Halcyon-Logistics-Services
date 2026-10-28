import { useMemo, useState } from 'react';
import { ArrowUpDown, ArrowUp, ArrowDown, Search, X, SlidersHorizontal, Download, ChevronLeft, ChevronRight } from 'lucide-react';

/**
 * Sortable, filterable table.
 *
 * columns: [{
 *   key, label,
 *   value?:  (row) => primitive used for sorting, filtering and CSV (defaults to row[key]),
 *   render?: (row) => cell content (defaults to the value),
 *   filter?: 'text' | 'select' | 'range' | false   (default 'text'; 'range' takes ">25", "<=30", "20-30" or "=5"),
 *   options?: [{ value, label }] for 'select' (defaults to the distinct values),
 *   align?: 'num', sortable?: boolean (default true), width?, title?
 * }]
 * compact: no toolbar, filters or paging — for short reference tables.
 */
// ">25", ">=25", "<30", "<=30", "20-30", "=5" or a bare number (equals). Unparseable text matches everything.
export function matchRange(n, expr) {
  const e = String(expr).replace(/[\s,%$]/g, '');
  let m;
  if ((m = e.match(/^(>=|<=|>|<|=)?(-?\d*\.?\d+)$/))) {
    const x = Number(m[2]);
    return { '>': n > x, '>=': n >= x, '<': n < x, '<=': n <= x, '=': n === x, undefined: n === x }[m[1]];
  }
  if ((m = e.match(/^(-?\d*\.?\d+)-(-?\d*\.?\d+)$/))) return n >= Number(m[1]) && n <= Number(m[2]);
  return true;
}

export default function DataTable({
  columns, rows, rowKey = (r, i) => r.id ?? i, onRowClick, initialSort, pageSize: initialPageSize = 25,
  search = true, searchPlaceholder = 'Search', toolbar, maxHeight, exportName, emptyText = 'No rows match these filters.',
  showFilters: initiallyShown = true, compact = false,
}) {
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState({});
  const [sort, setSort] = useState(initialSort || null);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(initialPageSize);
  const [showFilters, setShowFilters] = useState(initiallyShown);

  const valueOf = (col, row) => (col.value ? col.value(row) : row[col.key]);

  const selectOptions = useMemo(() => Object.fromEntries(columns.filter((c) => c.filter === 'select').map((c) => {
    if (c.options) return [c.key, c.options];
    const distinct = [...new Set(rows.map((r) => valueOf(c, r)).filter((v) => v !== null && v !== undefined && v !== ''))];
    distinct.sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }));
    return [c.key, distinct.map((v) => ({ value: v, label: c.optionLabel ? c.optionLabel(v) : String(v) }))];
  })), [columns, rows]); // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let out = rows.filter((row) => {
      if (q && !columns.some((c) => String(valueOf(c, row) ?? '').toLowerCase().includes(q))) return false;
      return columns.every((c) => {
        const f = filters[c.key];
        if (f === undefined || f === '') return true;
        const v = valueOf(c, row);
        if (c.filter === 'select') return String(v) === String(f);
        if (c.filter === 'range') return matchRange(Number(v), f);
        return String(v ?? '').toLowerCase().includes(String(f).toLowerCase());
      });
    });
    if (sort) {
      const col = columns.find((c) => c.key === sort.key);
      if (col) {
        out = [...out].sort((a, b) => {
          const x = valueOf(col, a); const y = valueOf(col, b);
          const r = typeof x === 'number' && typeof y === 'number' ? x - y
            : String(x ?? '').localeCompare(String(y ?? ''), undefined, { numeric: true });
          return sort.dir === 'asc' ? r : -r;
        });
      }
    }
    return out;
  }, [rows, columns, filters, query, sort]); // eslint-disable-line react-hooks/exhaustive-deps

  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const current = Math.min(page, pages - 1);
  const visible = filtered.slice(current * pageSize, current * pageSize + pageSize);

  const setFilter = (key, value) => { setFilters((f) => ({ ...f, [key]: value })); setPage(0); };
  const toggleSort = (col) => {
    if (col.sortable === false) return;
    // First click: numbers largest-first, text A–Z. Further clicks flip the direction.
    setSort((s) => (s?.key !== col.key
      ? { key: col.key, dir: col.align === 'num' ? 'desc' : 'asc' }
      : { key: col.key, dir: s.dir === 'asc' ? 'desc' : 'asc' }));
  };

  const chips = columns.flatMap((c) => {
    const f = filters[c.key];
    if (f === undefined || f === '') return [];
    if (c.filter === 'range') return [{ key: c.key, text: `${c.label} ${f.trim()}` }];
    const label = c.filter === 'select' ? selectOptions[c.key]?.find((o) => String(o.value) === String(f))?.label ?? f : `“${f}”`;
    return [{ key: c.key, text: `${c.label}: ${label}` }];
  });
  const hasFilterable = !compact && columns.some((c) => c.filter !== false);

  const exportCsv = () => {
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = [columns.map((c) => esc(c.label)).join(','), ...filtered.map((r) => columns.map((c) => esc(valueOf(c, r))).join(','))].join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `${exportName}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div>
      {!compact && <div className="dt-toolbar">
        {search && (
          <div className="dt-search">
            <Search size={14} />
            <input className="input" placeholder={searchPlaceholder} value={query} onChange={(e) => { setQuery(e.target.value); setPage(0); }} aria-label="Search table" />
          </div>
        )}
        {hasFilterable && (
          <button className={`btn sm ${showFilters ? '' : 'ghost'}`} onClick={() => setShowFilters((s) => !s)} aria-pressed={showFilters}>
            <SlidersHorizontal size={13} /> Column filters
          </button>
        )}
        {toolbar}
        <span className="dt-count">{filtered.length === rows.length ? `${rows.length.toLocaleString()} rows` : `${filtered.length.toLocaleString()} of ${rows.length.toLocaleString()} rows`}</span>
        {exportName && <button className="btn sm ghost" onClick={exportCsv} title="Download the filtered rows as CSV"><Download size={13} /> CSV</button>}
      </div>}
      {chips.length > 0 && (
        <div className="dt-chips" style={{ marginBottom: 10 }}>
          {chips.map((c) => (
            <span key={c.key} className="dt-chip">{c.text}
              <button aria-label={`Clear ${c.text}`} onClick={() => setFilter(c.key, '')}><X size={12} /></button>
            </span>
          ))}
          <button className="btn sm ghost" onClick={() => { setFilters({}); setPage(0); }}>Clear all</button>
        </div>
      )}
      <div className="table-wrap" style={{ maxHeight }}>
        <table>
          <thead>
            <tr>
              {columns.map((c) => {
                const sorted = sort?.key === c.key;
                const Icon = !sorted ? ArrowUpDown : sort.dir === 'asc' ? ArrowUp : ArrowDown;
                return (
                  <th key={c.key} className={`${c.align === 'num' ? 'num' : ''} ${c.sortable === false ? '' : 'sortable'} ${sorted ? 'sorted' : ''}`}
                    style={{ width: c.width }} onClick={() => toggleSort(c)} title={c.title}
                    aria-sort={sorted ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
                    <span className="th-inner">{c.label}{c.sortable !== false && c.label && <Icon size={12} className="sort-icon" />}</span>
                  </th>
                );
              })}
            </tr>
            {showFilters && hasFilterable && (
              <tr className="filter-row">
                {columns.map((c) => (
                  <th key={c.key} className={c.align === 'num' ? 'num' : ''}>
                    {c.filter === 'select' ? (
                      <select className="input" value={filters[c.key] ?? ''} onChange={(e) => setFilter(c.key, e.target.value)} aria-label={`Filter ${c.label}`}>
                        <option value="">All</option>
                        {selectOptions[c.key].map((o) => <option key={String(o.value)} value={o.value}>{o.label}</option>)}
                      </select>
                    ) : c.filter === 'range' ? (
                      <input className="input range-input" placeholder="> < or a-b" value={filters[c.key] ?? ''} onChange={(e) => setFilter(c.key, e.target.value)}
                        aria-label={`Filter ${c.label}`} title="Type >25, <=30, 20-30 or =5" />
                    ) : c.filter === false || !c.label ? null : (
                      <input className="input" placeholder="Filter…" value={filters[c.key] ?? ''} onChange={(e) => setFilter(c.key, e.target.value)} aria-label={`Filter ${c.label}`} />
                    )}
                  </th>
                ))}
              </tr>
            )}
          </thead>
          <tbody>
            {visible.map((row, i) => (
              <tr key={rowKey(row, i)} className={onRowClick ? 'clickable' : undefined} onClick={onRowClick ? () => onRowClick(row) : undefined}>
                {columns.map((c) => (
                  <td key={c.key} className={c.align === 'num' ? 'num' : undefined}>{c.render ? c.render(row) : valueOf(c, row) ?? '—'}</td>
                ))}
              </tr>
            ))}
            {visible.length === 0 && <tr><td colSpan={columns.length} className="dt-empty">{emptyText}</td></tr>}
          </tbody>
        </table>
      </div>
      {!compact && filtered.length > Math.min(pageSize, 10) && (
        <div className="dt-foot">
          <span className="row" style={{ gap: 6 }}>Rows per page
            <select className="input" style={{ width: 72, height: 28 }} value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(0); }} aria-label="Rows per page">
              {[10, 25, 50, 100].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </span>
          <span className="row" style={{ gap: 8 }}>
            {current * pageSize + 1}–{Math.min(filtered.length, (current + 1) * pageSize)} of {filtered.length.toLocaleString()}
            <button className="btn sm" disabled={current === 0} onClick={() => setPage(current - 1)} aria-label="Previous page"><ChevronLeft size={14} /></button>
            <button className="btn sm" disabled={current >= pages - 1} onClick={() => setPage(current + 1)} aria-label="Next page"><ChevronRight size={14} /></button>
          </span>
        </div>
      )}
    </div>
  );
}
