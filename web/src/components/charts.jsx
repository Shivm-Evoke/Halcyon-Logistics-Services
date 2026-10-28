// Shared chart kit: one look for every Recharts chart in the app.
// Hairline recessive grid, muted axis ink, square bar ends, 2px lines, one tooltip style,
// HTML legends (identity is never colour-only), and a donut with its total in the centre.
import { PieChart, Pie, Cell, Tooltip } from 'recharts';
import { ResponsiveContainer, anim } from './motion.jsx';
import { PAL } from '../theme.js';

// Getters, so spreading these ({...axisX}) picks up the current theme's colours on every render.
export const axisX = { tickLine: false, tickMargin: 8, get axisLine() { return { stroke: PAL.base }; }, get tick() { return { fontSize: 12, fill: PAL.muted }; } };
export const axisY = { tickLine: false, axisLine: false, width: 48, get tick() { return { fontSize: 12, fill: PAL.muted }; } };
export const gridProps = { vertical: false, get stroke() { return PAL.grid; } };
export const barProps = { maxBarSize: 36, ...anim };
export const hbarProps = { maxBarSize: 18, ...anim };
export const lineProps = {
  type: 'monotone', strokeWidth: 2, ...anim,
  get dot() { return { r: 3.5, strokeWidth: 2, stroke: PAL.surface }; },
  get activeDot() { return { r: 5, strokeWidth: 2, stroke: PAL.surface }; },
};
export const cursor = { get fill() { return PAL.cursor; } };

/**
 * Tooltip content. format(value, name, entry) -> string; title(label, payload) -> string.
 */
export function ChartTip({ active, payload, label, format = (v) => v, title }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="chart-tip">
      <div className="tip-title">{title ? title(label, payload) : label}</div>
      {payload.map((p) => (
        <div key={p.dataKey ?? p.name} className="tip-row">
          <span className="dot" style={{ background: p.payload?.fill || p.color || p.fill }} />
          {p.name}
          <b>{format(p.value, p.name, p.payload)}</b>
        </div>
      ))}
    </div>
  );
}

export const tip = (format, title) => <Tooltip cursor={{ ...cursor }} content={<ChartTip format={format} title={title} />} />;

export function Legend({ items }) {
  return (
    <div className="legend">
      {items.map((i) => (
        <span key={i.label}><span className="dot" style={{ background: i.color }} />{i.label}{i.value != null && <b style={{ color: 'var(--ink)', fontWeight: 600 }}>{i.value}</b>}</span>
      ))}
    </div>
  );
}

/** Donut for part-to-whole (≤ 6 segments). data: [{ name, value, color }]. */
export function Donut({ data, height = 190, centerValue, centerLabel, format = (v) => v }) {
  return (
    <div style={{ position: 'relative', height }}>
      <ResponsiveContainer height="100%">
        <PieChart>
          <Pie data={data} dataKey="value" nameKey="name" innerRadius="64%" outerRadius="94%" paddingAngle={1.2}
            stroke={PAL.surface} strokeWidth={2} {...anim}>
            {data.map((d) => <Cell key={d.name} fill={d.color} />)}
          </Pie>
          <Tooltip content={<ChartTip format={format} title={(_, p) => p?.[0]?.name} />} />
        </PieChart>
      </ResponsiveContainer>
      {centerValue != null && (
        <div className="donut-center"><div><div className="v">{centerValue}</div><div className="l">{centerLabel}</div></div></div>
      )}
    </div>
  );
}
