// Motion for the story scroll: blocks rise into view, charts draw when they arrive, numbers count up.
// Everything is skipped when the viewer asks for reduced motion (and the browser tests run that way).
import { useEffect, useRef, useState } from 'react';
import { ResponsiveContainer as RechartsContainer } from 'recharts';

export const MOTION = !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
// A page in a background tab never reports elements entering view and doesn't run animation frames,
// so it shows everything at once instead of waiting for motion that cannot happen.
const live = () => MOTION && !document.hidden;

/** [ref, seen]: seen turns true the first time the element scrolls into view, and stays true. */
export function useInView({ margin = '0px 0px -10% 0px' } = {}) {
  const ref = useRef(null);
  const [seen, setSeen] = useState(() => !live());
  useEffect(() => {
    if (seen || !ref.current) return undefined;
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { setSeen(true); io.disconnect(); } }, { rootMargin: margin });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [seen, margin]);
  return [ref, seen];
}

const REPLAY = 'story:replay-charts';

/** Ask every already-drawn chart on screen `id` to draw again; `scrolling` waits for the scroll to arrive first. */
export function replayCharts(id, scrolling) {
  if (live()) window.dispatchEvent(new CustomEvent(REPLAY, { detail: { id, scrolling } }));
}

/**
 * Drop-in for Recharts' ResponsiveContainer. Holds the chart's space, and mounts the chart only once it
 * scrolls into view, so its bars grow, lines trace and donuts sweep while the viewer is looking.
 * When the viewer jumps back to a screen they've already seen, its charts clear and draw again on arrival.
 */
export function ResponsiveContainer({ height, children, ...rest }) {
  const [ref, seen] = useInView();
  const [round, setRound] = useState(0);       // a new round remounts the chart, which replays its animation
  const [waiting, setWaiting] = useState(false);
  useEffect(() => {
    if (!seen) return undefined;               // not drawn yet: it draws normally when it scrolls into view
    let timer;
    const draw = () => { clearTimeout(timer); window.removeEventListener('scrollend', draw); setRound((r) => r + 1); setWaiting(false); };
    const onReplay = ({ detail }) => {
      if (ref.current?.closest('.screen')?.id !== detail.id) return;
      setWaiting(true);
      if (detail.scrolling) {
        window.addEventListener('scrollend', draw, { once: true });
        timer = setTimeout(draw, 1600);        // browsers without scrollend
      } else timer = setTimeout(draw, 120);
    };
    window.addEventListener(REPLAY, onReplay);
    return () => { window.removeEventListener(REPLAY, onReplay); window.removeEventListener('scrollend', draw); clearTimeout(timer); };
  }, [seen, ref]);
  return (
    <div ref={ref} className="chart-slot" style={{ height, width: '100%' }}>
      {seen && !waiting && <RechartsContainer key={round} width="100%" height="100%" {...rest}>{children}</RechartsContainer>}
    </div>
  );
}

// Recharts animation settings shared by every series.
export const anim = { get isAnimationActive() { return live(); }, animationBegin: 300, animationDuration: 2200, animationEasing: 'ease-in-out' };

/** Counts a formatted figure ("71.0%", "$14.2M", "1,044") up from zero when it comes into view. */
export function CountUp({ value }) {
  const text = String(value);
  const match = typeof value === 'string' || typeof value === 'number' ? text.match(/\d[\d,]*(\.\d+)?/) : null;
  const [ref, seen] = useInView();
  const [t, setT] = useState(() => (match && live() ? 0 : 1));
  useEffect(() => {
    if (!seen || t === 1) return undefined;
    let raf;
    const start = performance.now();
    const tick = (now) => {
      const k = Math.min(1, (now - start) / 1000);
      setT(k);
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [seen]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!match || t === 1) return <span ref={ref}>{value}</span>;
  const digits = match[0];
  const decimals = (digits.split('.')[1] || '').length;
  const eased = 1 - (1 - t) ** 3;
  const now = (Number(digits.replace(/,/g, '')) * eased).toLocaleString('en-US', {
    minimumFractionDigits: decimals, maximumFractionDigits: decimals, useGrouping: digits.includes(','),
  });
  return <span ref={ref}>{text.slice(0, match.index)}{now}{text.slice(match.index + digits.length)}</span>;
}

// Blocks that rise into view. A block inside one that is still waiting to rise moves with its parent.
const REVEAL = '.screen-label, .page-head, .card, .callout, .table-wrap, .next-up';

/** Watches `root` (including content that loads later) and lets each block rise in as it enters the screen. */
export function useReveal(rootRef, key) {
  useEffect(() => {
    const root = rootRef.current;
    if (!MOTION || !root) return undefined;
    const io = new IntersectionObserver((entries) => {
      let i = 0;
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const el = e.target;
        el.style.transitionDelay = `${Math.min(i++, 5) * 70}ms`;
        el.classList.add('rv-in');
        el.addEventListener('transitionend', () => { el.style.transitionDelay = ''; }, { once: true });
        io.unobserve(el);
      }
    }, { rootMargin: '0px 0px -40px 0px' });
    const watched = new WeakSet();
    const scan = () => root.querySelectorAll(REVEAL).forEach((el) => {
      if (watched.has(el) || el.classList.contains('rv-in') || el.parentElement?.closest('.rv:not(.rv-in)')) return;
      watched.add(el);
      el.classList.add('rv');
      if (document.hidden) el.classList.add('rv-in');
      else io.observe(el);
    });
    scan();
    const mo = new MutationObserver(scan);
    mo.observe(root, { childList: true, subtree: true });
    return () => { io.disconnect(); mo.disconnect(); };
  }, [rootRef, key]);
}
