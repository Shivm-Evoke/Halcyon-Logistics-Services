import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import {
  Microscope, Warehouse, Truck, Radar, Users, BrainCircuit, ShieldCheck, Network, Sun, Moon, Monitor, Compass, ArrowDown,
  PlayCircle, LineChart as LineChartIcon, Bot, Scale, Database, UploadCloud,
} from 'lucide-react';
import Inventory from './pages/Inventory.jsx';
import Carriers from './pages/Carriers.jsx';
import ControlTower from './pages/ControlTower.jsx';
import Accounts from './pages/Accounts.jsx';
import { applyTheme, savedChoice, onSystemChange, resolve } from './theme.js';
import AiModel from './pages/AiModel.jsx';
import DataQuality from './pages/DataQuality.jsx';
import Inbound from './pages/Inbound.jsx';
import StartHere from './pages/StartHere.jsx';
import WhyLate from './pages/WhyLate.jsx';
import OperationsDay from './pages/OperationsDay.jsx';
import SixMonths from './pages/SixMonths.jsx';
import Agents from './pages/Agents.jsx';
import Decision from './pages/Decision.jsx';
import TestData from './pages/TestData.jsx';
import { MOTION, replayCharts, useReveal } from './components/motion.jsx';

// Sidebar in presentation order: the problem, the solution at work, the decision, then what is under the hood.
const NAV = [
  { to: '/', label: 'Start here', icon: Compass, el: <StartHere />, section: 'Guide' },
  { section: '1 · The problem' },
  { to: '/why-late', label: 'Why we\'re late', icon: Microscope, el: <WhyLate /> },
  { section: '2 · The solution at work' },
  { to: '/operations-day', label: 'Operations day', icon: PlayCircle, tag: 'LIVE', el: <OperationsDay /> },
  { to: '/six-months', label: 'Six months with agents', icon: LineChartIcon, el: <SixMonths /> },
  { to: '/agents', label: 'Meet the agents', icon: Bot, el: <Agents /> },
  { to: '/test-data', label: 'Test data', icon: UploadCloud, tag: 'TRY', el: <TestData /> },
  { section: '3 · The decision' },
  { to: '/decision', label: 'The decision', icon: Scale, el: <Decision /> },
  { section: '4 · Under the hood' },
  { to: '/inbound', label: 'Inbound gateway', icon: Network, tag: 'Intake', el: <Inbound /> },
  { to: '/carriers', label: 'Carrier scorecard', icon: Truck, tag: 'Carrier', el: <Carriers /> },
  { to: '/inventory', label: 'Inventory placement', icon: Warehouse, tag: 'Stock', el: <Inventory /> },
  { to: '/control-tower', label: 'Exceptions control tower', icon: Radar, tag: 'Watch', el: <ControlTower /> },
  { to: '/ai-model', label: 'AI risk model', icon: BrainCircuit, tag: 'ML', el: <AiModel /> },
  { to: '/data-quality', label: 'Data quality', icon: ShieldCheck, el: <DataQuality /> },
  { to: '/accounts', label: 'Account health', icon: Users, el: <Accounts /> },
];
let section = '';
const PAGES = NAV.flatMap((n) => (n.section && !n.to ? ((section = n.section), []) : [{ ...n, section: n.section || section }]));

const TOPBAR = 56;
const idOf = (to) => (to === '/' ? 'start-here' : to.slice(1));
const top = (to) => {
  const el = document.getElementById(idOf(to));
  return el ? el.getBoundingClientRect().top + window.scrollY - TOPBAR : null;
};

/**
 * One continuous story: every screen sits on one page in sidebar order.
 * - Scrolling moves the sidebar highlight, breadcrumb and URL to the screen under the reading line.
 * - Choosing a screen (sidebar, in-page link, back/forward, a pasted URL) scrolls to the top of it.
 */
function useStoryScroll() {
  const location = useLocation();
  const navigate = useNavigate();
  const path = useRef(location.pathname);
  const pinnedUntil = useRef(0);   // while a chosen screen is being scrolled to, scrolling doesn't change the URL
  const firstLoad = useRef(true);
  path.current = location.pathname;

  useEffect(() => {
    if (location.state?.fromScroll) return undefined;
    const smooth = MOTION && !firstLoad.current;
    firstLoad.current = false;
    const go = (behavior) => { const y = top(location.pathname); if (y != null) window.scrollTo({ top: y, behavior }); };
    pinnedUntil.current = Date.now() + 1500;
    // Charts on a screen the viewer has already seen draw again once the scroll arrives (motion.jsx).
    if (smooth) {
      const y = top(location.pathname);
      replayCharts(idOf(location.pathname), y != null && Math.abs(y - window.scrollY) > 2);
    }
    go(smooth ? 'smooth' : 'instant');
    // Screens above may still be loading and change height: keep the chosen screen pinned while they settle.
    const timers = (smooth ? [1300] : [250, 700, 1300]).map((ms) => setTimeout(() => {
      if (Date.now() < pinnedUntil.current + 100) go('instant');
    }, ms));
    const release = () => { pinnedUntil.current = 0; };   // the viewer took over the scroll
    const opts = { passive: true };
    ['wheel', 'touchstart', 'keydown', 'mousedown'].forEach((e) => window.addEventListener(e, release, opts));
    return () => {
      timers.forEach(clearTimeout);
      ['wheel', 'touchstart', 'keydown', 'mousedown'].forEach((e) => window.removeEventListener(e, release, opts));
    };
  }, [location.key]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (Date.now() < pinnedUntil.current) return;
        const line = window.scrollY + window.innerHeight * 0.35;
        const atEnd = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;
        let active = PAGES[0];
        for (const p of PAGES) { const y = top(p.to); if (y != null && y <= line) active = p; }
        if (atEnd) active = PAGES.at(-1);
        if (active.to !== path.current) navigate(active.to, { replace: true, state: { fromScroll: true } });
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => { window.removeEventListener('scroll', onScroll); cancelAnimationFrame(frame); };
  }, [navigate]);
}

const THEMES = [['light', Sun, 'Light'], ['dark', Moon, 'Dark'], ['system', Monitor, 'Match system']];

export default function App() {
  const { pathname } = useLocation();
  const [choice, setChoice] = useState(savedChoice);
  const [mode, setMode] = useState(() => resolve(savedChoice()));
  const savedY = useRef(null);
  const chooseTheme = (value) => { savedY.current = window.scrollY; setChoice(value); setMode(applyTheme(value)); };
  const story = useRef(null);
  useStoryScroll();
  useReveal(story, mode);
  // Charts redraw on a theme change (the story remounts); stay where the viewer was.
  useLayoutEffect(() => {
    if (savedY.current != null) window.scrollTo({ top: savedY.current, behavior: 'instant' });
    savedY.current = null;
  }, [mode]);
  // While following the system, track OS light/dark changes.
  useEffect(() => (choice === 'system' ? onSystemChange(() => setMode(applyTheme('system'))) : undefined), [choice]);
  const current = PAGES.find((p) => p.to === pathname) || PAGES[0];
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">H</div>
          <div>Halcyon<small>Operations console</small></div>
        </div>
        <nav className="nav">
          {NAV.map((n, i) => (n.section && !n.to)
            ? <div key={i} className="nav-section">{n.section}</div>
            : (
              <NavLink key={n.to} to={n.to} end>
                <n.icon size={16} strokeWidth={1.9} />{n.label}{n.tag && <span className="tag">{n.tag}</span>}
              </NavLink>
            ))}
        </nav>
        <div className="sidebar-foot">
          280 clients · 5 warehouses · 6 carriers
          <div style={{ marginTop: 4 }}>Tags refer to the issue register (I1–I10).</div>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <div className="crumb">{current.section} <span style={{ margin: '0 6px', color: 'var(--faint)' }}>/</span> <b>{current.label}</b></div>
          <div className="row">
            <span className="pill"><Database size={13} /> 48,340 deliveries · Apr–Sep 2026</span>
            <span className="pill"><span className="live" /> Data through 25 Sep</span>
            <div className="seg" role="radiogroup" aria-label="Colour theme">
              {THEMES.map(([value, Icon, label]) => (
                <button key={value} role="radio" aria-checked={choice === value} aria-label={label} title={label}
                  className={choice === value ? 'on' : ''} onClick={() => chooseTheme(value)}><Icon size={14} /></button>
              ))}
            </div>
          </div>
        </header>
        {/* Charts read the theme while rendering; remounting on a theme change redraws them. */}
        <main className="page story" key={mode} ref={story}>
          {PAGES.map((p, i) => (
            <section key={p.to} id={idOf(p.to)} className="screen" aria-label={p.label}>
              <div className="screen-label">
                <span className="screen-no">{String(i + 1).padStart(2, '0')} / {PAGES.length}</span>
                <span>{p.section.replace(/^\d · /, '')}</span>
              </div>
              <div className="screen-body">{p.el}</div>
              {PAGES[i + 1] && (
                <Link to={PAGES[i + 1].to} className="next-up">
                  <span className="next-kicker">Next</span>
                  <span className="next-title">{PAGES[i + 1].label}</span>
                  <ArrowDown size={18} strokeWidth={1.6} />
                </Link>
              )}
            </section>
          ))}
        </main>
      </div>
    </div>
  );
}
