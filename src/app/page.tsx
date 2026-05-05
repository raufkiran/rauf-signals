'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS — preserved verbatim from v2.2.1 (DO NOT MODIFY)
// ═══════════════════════════════════════════════════════════════════════════
const COINS = [
  { symbol: 'BTCUSDT', display: 'BTC' },
  { symbol: 'ETHUSDT', display: 'ETH' },
  { symbol: 'SOLUSDT', display: 'SOL' },
  { symbol: 'XRPUSDT', display: 'XRP' },
  { symbol: 'BNBUSDT', display: 'BNB' },
  { symbol: 'DOGEUSDT', display: 'DOGE' },
  { symbol: 'ADAUSDT', display: 'ADA' },
  { symbol: 'AVAXUSDT', display: 'AVAX' },
  { symbol: 'LINKUSDT', display: 'LINK' },
  { symbol: 'POLUSDT', display: 'POL' },
];

const FACTOR_WEIGHTS = { obi: 0.30, pressure: 0.25, delta: 0.20, spread: 0.10, vol: 0.15 };
const DIRECTION_THRESHOLD = 25;
const MIN_FACTOR_AGREEMENT = 2;
const MIN_RR_RATIO = 1.5;
const MIN_TP_DISTANCE_PCT = 0.15;
const SIGNAL_LOG_MIN_CONFIDENCE = 70;
const SIGNAL_COOLDOWN_MS = 5 * 60 * 1000;
const WHALE_NOTIONAL_USD = 500_000;
const TOP_OB_LEVELS = 20;
const SIGNAL_RECOMPUTE_MS = 500;
const MAX_RECENT_TRADES = 500;
const MAX_PRICE_HISTORY = 100;
const MAX_RATIONALE_FEED = 30;

// ═══════════════════════════════════════════════════════════════════════════
// TYPES — preserved verbatim
// ═══════════════════════════════════════════════════════════════════════════
interface CoinData { price: number; change: number; volume: number; }
interface DepthLevel { price: number; qty: number; notional: number; isWhale: boolean; }
interface DepthData {
  bids: DepthLevel[]; asks: DepthLevel[];
  bestBid: number; bestAsk: number; mid: number; spreadBps: number;
  bidNotional: number; askNotional: number;
  whaleZones: { side: 'bid' | 'ask'; price: number; notional: number }[];
}
interface FactorScores { obi: number; pressure: number; delta: number; spread: number; vol: number; }
interface RiskZones { stopLoss: number; takeProfit: number; riskPct: number; rewardPct: number; rr: number; }
interface Signal {
  direction: 'LONG' | 'SHORT' | 'NEUTRAL';
  confidence: number; finalScore: number;
  factors: FactorScores; agreement: number;
  rationale: string; risk: RiskZones | null; flags: string[];
}
interface SignalLog {
  id: number; symbol: string;
  direction: 'LONG' | 'SHORT' | 'NEUTRAL';
  confidence: number; entryPrice: number;
  stopLoss: number; takeProfit: number; rr: number;
  timestamp: number;
  resolvedPrice?: number; pnlPct?: number;
  outcome?: 'win' | 'loss' | 'pending';
}
interface TradeData {
  buyVol: number; sellVol: number;
  recentTrades: { ts: number; price: number; qty: number; isBuyer: boolean }[];
  lastPrice: number;
  priceHistory: { ts: number; price: number }[];
}
interface LiquidityZone {
  type: 'support' | 'resistance';
  price: number;
  notional: number;
  distance: number;
  strength: 'WHALE' | 'STRONG' | 'MEDIUM';
}
interface RationaleEntry {
  id: number;
  ts: number;
  level: 'INFO' | 'SIGNAL' | 'WARN' | 'WHALE' | 'FLIP';
  msg: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// SIGNAL ENGINE — preserved verbatim (5-factor, RR fix, whale, sweep)
// ═══════════════════════════════════════════════════════════════════════════
function calcOBI(bids: DepthLevel[], asks: DepthLevel[]): number {
  const bn = bids.reduce((s, b) => s + b.notional, 0);
  const an = asks.reduce((s, a) => s + a.notional, 0);
  const t = bn + an;
  if (t === 0) return 0;
  return ((bn - an) / t) * 100;
}
function calcPressure(bids: DepthLevel[], asks: DepthLevel[]): number {
  const bw = bids.reduce((s, b, i) => s + b.qty * (TOP_OB_LEVELS - i), 0);
  const aw = asks.reduce((s, a, i) => s + a.qty * (TOP_OB_LEVELS - i), 0);
  const t = bw + aw;
  if (t === 0) return 0;
  return ((bw - aw) / t) * 100;
}
function calcDelta(trade: TradeData): number {
  const t = trade.buyVol + trade.sellVol;
  if (t === 0) return 0;
  return ((trade.buyVol - trade.sellVol) / t) * 100;
}
function calcSpreadScore(s: number): number {
  if (s < 0.5) return 100;
  if (s < 1) return 80;
  if (s < 2) return 60;
  if (s < 5) return 40;
  if (s < 10) return 20;
  return 0;
}
function calcVolScore(ph: { ts: number; price: number }[]): { score: number; volPct: number } {
  if (ph.length < 5) return { score: 50, volPct: 0 };
  const now = Date.now();
  const r = ph.filter(p => now - p.ts < 60_000);
  if (r.length < 3) return { score: 50, volPct: 0 };
  const prices = r.map(p => p.price);
  const high = Math.max(...prices);
  const low = Math.min(...prices);
  const mid = (high + low) / 2;
  const volPct = ((high - low) / mid) * 100;
  let score = 50;
  if (volPct < 0.05) score = 100;
  else if (volPct < 0.1) score = 85;
  else if (volPct < 0.2) score = 70;
  else if (volPct < 0.5) score = 50;
  else if (volPct < 1.0) score = 30;
  else score = 10;
  return { score, volPct };
}
function findRiskZones(direction: 'LONG' | 'SHORT', entry: number, bids: DepthLevel[], asks: DepthLevel[]): RiskZones | null {
  if (bids.length === 0 || asks.length === 0) return null;
  const bidAvg = bids.reduce((s, b) => s + b.qty, 0) / bids.length;
  const askAvg = asks.reduce((s, a) => s + a.qty, 0) / asks.length;
  if (direction === 'LONG') {
    const wall = bids.find(b => b.qty > bidAvg * 3);
    const sl = wall ? wall.price - (entry * 0.0001) : entry * 0.997;
    const slDist = entry - sl;
    const minTpPrice = entry + (entry * MIN_TP_DISTANCE_PCT / 100);
    const minRrTp = entry + (slDist * MIN_RR_RATIO);
    const targetTp = Math.max(minTpPrice, minRrTp);
    let tp = targetTp;
    const wallTarget = asks.find(a => a.price >= targetTp && a.qty > askAvg * 2);
    if (wallTarget) {
      tp = wallTarget.price - (entry * 0.0001);
    } else {
      for (let i = 1; i < asks.length - 1; i++) {
        if (asks[i].price >= targetTp && asks[i].qty < askAvg * 0.5) { tp = asks[i].price; break; }
      }
    }
    const riskPct = ((entry - sl) / entry) * 100;
    const rewardPct = ((tp - entry) / entry) * 100;
    return { stopLoss: sl, takeProfit: tp, riskPct, rewardPct, rr: rewardPct / riskPct };
  } else {
    const wall = asks.find(a => a.qty > askAvg * 3);
    const sl = wall ? wall.price + (entry * 0.0001) : entry * 1.003;
    const slDist = sl - entry;
    const minTpPrice = entry - (entry * MIN_TP_DISTANCE_PCT / 100);
    const minRrTp = entry - (slDist * MIN_RR_RATIO);
    const targetTp = Math.min(minTpPrice, minRrTp);
    let tp = targetTp;
    const wallTarget = bids.find(b => b.price <= targetTp && b.qty > bidAvg * 2);
    if (wallTarget) {
      tp = wallTarget.price + (entry * 0.0001);
    } else {
      for (let i = 1; i < bids.length - 1; i++) {
        if (bids[i].price <= targetTp && bids[i].qty < bidAvg * 0.5) { tp = bids[i].price; break; }
      }
    }
    const riskPct = ((sl - entry) / entry) * 100;
    const rewardPct = ((entry - tp) / entry) * 100;
    return { stopLoss: sl, takeProfit: tp, riskPct, rewardPct, rr: rewardPct / riskPct };
  }
}
function detectSweep(ph: { ts: number; price: number }[]): boolean {
  if (ph.length < 5) return false;
  const now = Date.now();
  const r = ph.filter(p => now - p.ts < 10_000);
  if (r.length < 3) return false;
  const high = Math.max(...r.map(p => p.price));
  const low = Math.min(...r.map(p => p.price));
  const last = r[r.length - 1].price;
  const range = ((high - low) / last) * 100;
  if (range > 0.3) {
    const mid = (high + low) / 2;
    if (Math.abs(last - mid) / last < 0.001) return true;
  }
  return false;
}
function findLiquidityZones(depth: DepthData): { longZones: LiquidityZone[]; shortZones: LiquidityZone[] } {
  if (!depth) return { longZones: [], shortZones: [] };
  const bidAvg = depth.bids.reduce((s, b) => s + b.qty, 0) / depth.bids.length;
  const askAvg = depth.asks.reduce((s, a) => s + a.qty, 0) / depth.asks.length;
  const longZones: LiquidityZone[] = depth.bids
    .filter(b => b.qty > bidAvg * 1.8 || b.isWhale)
    .slice(0, 3)
    .map(b => ({
      type: 'support' as const,
      price: b.price,
      notional: b.notional,
      distance: ((depth.mid - b.price) / depth.mid) * 100,
      strength: b.isWhale ? ('WHALE' as const) : (b.qty > bidAvg * 3 ? 'STRONG' as const : 'MEDIUM' as const),
    }));
  const shortZones: LiquidityZone[] = depth.asks
    .filter(a => a.qty > askAvg * 1.8 || a.isWhale)
    .slice(0, 3)
    .map(a => ({
      type: 'resistance' as const,
      price: a.price,
      notional: a.notional,
      distance: ((a.price - depth.mid) / depth.mid) * 100,
      strength: a.isWhale ? ('WHALE' as const) : (a.qty > askAvg * 3 ? 'STRONG' as const : 'MEDIUM' as const),
    }));
  return { longZones, shortZones };
}
function computeUnifiedSignal(depth: DepthData, trade: TradeData, flags: string[]): Signal {
  const obi = calcOBI(depth.bids, depth.asks);
  const pressure = calcPressure(depth.bids, depth.asks);
  const delta = calcDelta(trade);
  const spread = calcSpreadScore(depth.spreadBps);
  const { score: vol } = calcVolScore(trade.priceHistory);
  const obiSign = Math.sign(obi);
  const pressureSign = Math.sign(pressure);
  const deltaSign = Math.sign(delta);
  const longCount = [obiSign, pressureSign, deltaSign].filter(s => s > 0).length;
  const shortCount = [obiSign, pressureSign, deltaSign].filter(s => s < 0).length;
  let agreeing = 0;
  let dominant = 0;
  if (longCount >= MIN_FACTOR_AGREEMENT) { dominant = 1; agreeing = longCount; }
  else if (shortCount >= MIN_FACTOR_AGREEMENT) { dominant = -1; agreeing = shortCount; }
  const directionalRaw = (obi * FACTOR_WEIGHTS.obi) + (pressure * FACTOR_WEIGHTS.pressure) + (delta * FACTOR_WEIGHTS.delta);
  const qualityMult = ((spread * FACTOR_WEIGHTS.spread) + (vol * FACTOR_WEIGHTS.vol)) / 25;
  const finalScore = directionalRaw * Math.max(0.3, qualityMult);
  let direction: 'LONG' | 'SHORT' | 'NEUTRAL' = 'NEUTRAL';
  let rationale = '';
  if (dominant === 0) {
    rationale = `MIXED FACTORS · ${longCount}L/${shortCount}S/${3 - longCount - shortCount}N`;
  } else if (Math.abs(finalScore) < DIRECTION_THRESHOLD) {
    rationale = `WEAK SCORE · ${finalScore.toFixed(1)} below ±${DIRECTION_THRESHOLD}`;
  } else if (dominant > 0 && finalScore > DIRECTION_THRESHOLD) {
    direction = 'LONG';
    rationale = `BULLISH ALIGNMENT · ${agreeing}/3 factors`;
  } else if (dominant < 0 && finalScore < -DIRECTION_THRESHOLD) {
    direction = 'SHORT';
    rationale = `BEARISH ALIGNMENT · ${agreeing}/3 factors`;
  } else {
    rationale = `SCORE/SIGN MISMATCH · ${finalScore.toFixed(1)}`;
  }
  let confidence = 60;
  if (direction !== 'NEUTRAL') {
    const sb = Math.min(20, (Math.abs(finalScore) / 50) * 20);
    const ab = (agreeing - 1) * 6;
    const qb = qualityMult * 4;
    confidence = Math.min(92, 60 + sb + ab + qb);
    if (flags.includes('SWEEP')) confidence = Math.min(92, confidence + 3);
  } else {
    confidence = Math.min(55, 30 + Math.abs(finalScore) / 5);
  }
  let risk: RiskZones | null = null;
  if (direction !== 'NEUTRAL') {
    risk = findRiskZones(direction, depth.mid, depth.bids, depth.asks);
    if (risk && risk.rr < MIN_RR_RATIO) {
      direction = 'NEUTRAL';
      rationale = `BAD RR ${risk.rr.toFixed(2)} < ${MIN_RR_RATIO}`;
      confidence = 50;
      risk = null;
    }
  }
  return {
    direction,
    confidence: Math.round(confidence),
    finalScore: parseFloat(finalScore.toFixed(2)),
    factors: {
      obi: parseFloat(obi.toFixed(1)),
      pressure: parseFloat(pressure.toFixed(1)),
      delta: parseFloat(delta.toFixed(1)),
      spread: Math.round(spread),
      vol: Math.round(vol),
    },
    agreement: agreeing,
    rationale, risk, flags,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// DESIGN-SYSTEM PRIMITIVES (UI ONLY — pure presentation)
// ═══════════════════════════════════════════════════════════════════════════

// Funding Bias half-circle gauge — derived from OBI factor (-100..+100)
function FundingBiasGauge({ value, label }: { value: number; label: string }) {
  // value: -100 (bearish) → +100 (bullish). Map to angle 180° (left) → 0° (right).
  const clamped = Math.max(-100, Math.min(100, value));
  const angle = 180 - ((clamped + 100) / 200) * 180; // degrees
  const rad = (angle * Math.PI) / 180;
  const cx = 100, cy = 100, r = 80;
  const nx = cx + r * Math.cos(rad);
  const ny = cy - r * Math.sin(rad);
  const valColor = clamped > 25 ? '#4ADE80' : clamped < -25 ? '#EC4899' : '#FACC15';
  return (
    <div className="border border-gray-800 rounded bg-gray-900/30 p-3 flex flex-col">
      <div className="flex justify-between items-center mb-2">
        <span className="text-[9px] font-bold tracking-[0.3em] text-gray-500">▸ FUNDING BIAS</span>
        <span className="text-[9px] text-cyan-400 tracking-[0.25em]">OBI · LIVE</span>
      </div>
      <div className="relative flex-1 flex items-center justify-center">
        <svg viewBox="0 0 200 120" className="w-full max-w-[220px]">
          <defs>
            <linearGradient id="fgrad" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="#EC4899" />
              <stop offset="50%" stopColor="#FACC15" />
              <stop offset="100%" stopColor="#4ADE80" />
            </linearGradient>
          </defs>
          {/* Track */}
          <path d="M 20 100 A 80 80 0 0 1 180 100" fill="none" stroke="#1F2937" strokeWidth="14" strokeLinecap="round" />
          {/* Gradient arc */}
          <path d="M 20 100 A 80 80 0 0 1 180 100" fill="none" stroke="url(#fgrad)" strokeWidth="14" strokeLinecap="round" opacity="0.85" />
          {/* Tick marks */}
          {[0, 45, 90, 135, 180].map(a => {
            const ar = (a * Math.PI) / 180;
            const x1 = cx + 92 * Math.cos(ar), y1 = cy - 92 * Math.sin(ar);
            const x2 = cx + 70 * Math.cos(ar), y2 = cy - 70 * Math.sin(ar);
            return <line key={a} x1={x1} y1={y1} x2={x2} y2={y2} stroke="#374151" strokeWidth="1" />;
          })}
          {/* Needle */}
          <line x1={cx} y1={cy} x2={nx} y2={ny} stroke={valColor} strokeWidth="3" strokeLinecap="round" style={{ filter: `drop-shadow(0 0 6px ${valColor})` }} />
          <circle cx={cx} cy={cy} r="6" fill="#000" stroke={valColor} strokeWidth="2" />
          {/* Labels */}
          <text x="20" y="118" fill="#EC4899" fontSize="9" fontFamily="monospace" textAnchor="middle" letterSpacing="2">SHORT</text>
          <text x="100" y="118" fill="#FACC15" fontSize="9" fontFamily="monospace" textAnchor="middle" letterSpacing="2">FLAT</text>
          <text x="180" y="118" fill="#4ADE80" fontSize="9" fontFamily="monospace" textAnchor="middle" letterSpacing="2">LONG</text>
        </svg>
      </div>
      <div className="text-center mt-2">
        <div className="text-3xl font-black tabular-nums" style={{ color: valColor, filter: `drop-shadow(0 0 8px ${valColor})` }}>
          {clamped > 0 ? '+' : ''}{clamped.toFixed(1)}
        </div>
        <div className="text-[9px] text-gray-500 tracking-[0.25em] mt-0.5">{label}</div>
      </div>
    </div>
  );
}

// Status Badge with glow
function StatusBadge({ tone, children }: { tone: 'cyan' | 'green' | 'pink' | 'yellow' | 'gray'; children: React.ReactNode }) {
  const tones: Record<string, string> = {
    cyan: 'border-cyan-400/40 bg-cyan-400/[0.08] text-cyan-400 shadow-[0_0_12px_rgba(34,211,238,0.25)]',
    green: 'border-green-400/40 bg-green-400/[0.08] text-green-400 shadow-[0_0_12px_rgba(74,222,128,0.25)]',
    pink: 'border-pink-400/40 bg-pink-400/[0.08] text-pink-400 shadow-[0_0_12px_rgba(236,72,153,0.25)]',
    yellow: 'border-yellow-400/40 bg-yellow-400/[0.08] text-yellow-400 shadow-[0_0_12px_rgba(250,204,21,0.25)]',
    gray: 'border-gray-700 bg-gray-900/40 text-gray-400',
  };
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 border rounded-sm text-[9px] font-bold tracking-[0.25em] ${tones[tone]}`}>
      {children}
    </span>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════
export default function Home() {
  const [coinData, setCoinData] = useState<Record<string, CoinData>>({});
  const [selectedSymbol, setSelectedSymbol] = useState('BTCUSDT');
  const [depth, setDepth] = useState<DepthData | null>(null);
  const [signal, setSignal] = useState<Signal>({
    direction: 'NEUTRAL', confidence: 50, finalScore: 0,
    factors: { obi: 0, pressure: 0, delta: 0, spread: 0, vol: 0 },
    agreement: 0, rationale: 'Initializing v2.3...', risk: null, flags: [],
  });
  const [time, setTime] = useState('');
  const [signalLog, setSignalLog] = useState<SignalLog[]>([]);
  const [rationaleFeed, setRationaleFeed] = useState<RationaleEntry[]>([]);

  const tradeDataRef = useRef<TradeData>({
    buyVol: 0, sellVol: 0, recentTrades: [], lastPrice: 0, priceHistory: [],
  });
  const latestDepthRef = useRef<DepthData | null>(null);
  const depthWsRef = useRef<WebSocket | null>(null);
  const tradeWsRef = useRef<WebSocket | null>(null);
  const signalIdRef = useRef(0);
  const lastSignalRef = useRef<{ symbol: string; direction: string; ts: number } | null>(null);
  const rationaleIdRef = useRef(0);
  const lastDirRef = useRef<string>('NEUTRAL');
  const lastFlagsRef = useRef<Set<string>>(new Set());

  const pushRationale = (level: RationaleEntry['level'], msg: string) => {
    setRationaleFeed(prev => [{
      id: rationaleIdRef.current++,
      ts: Date.now(),
      level,
      msg,
    }, ...prev].slice(0, MAX_RATIONALE_FEED));
  };

  // ─── Ticker stream ───────────────────────────────────────────────────────
  useEffect(() => {
    const streams = COINS.map(c => `${c.symbol.toLowerCase()}@ticker`).join('/');
    const ws = new WebSocket(`wss://stream.binance.com:9443/stream?streams=${streams}`);
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      const data = msg.data;
      if (!data) return;
      setCoinData(prev => ({
        ...prev,
        [data.s]: { price: parseFloat(data.c), change: parseFloat(data.P), volume: parseFloat(data.q) }
      }));
    };
    ws.onopen = () => pushRationale('INFO', `WS connected · ticker stream · ${COINS.length} symbols`);
    const timer = setInterval(() => setTime(new Date().toLocaleTimeString()), 1000);
    return () => { ws.close(); clearInterval(timer); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Depth + AggTrade streams ────────────────────────────────────────────
  useEffect(() => {
    if (depthWsRef.current) depthWsRef.current.close();
    if (tradeWsRef.current) tradeWsRef.current.close();
    tradeDataRef.current = { buyVol: 0, sellVol: 0, recentTrades: [], lastPrice: 0, priceHistory: [] };
    latestDepthRef.current = null;
    setDepth(null);
    pushRationale('INFO', `LOCK → ${selectedSymbol} · subscribing depth20@100ms + aggTrade`);

    const depthWs = new WebSocket(
      `wss://stream.binance.com:9443/ws/${selectedSymbol.toLowerCase()}@depth20@100ms`
    );
    depthWs.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (!data.bids || !data.asks) return;
      const bids: DepthLevel[] = data.bids.slice(0, TOP_OB_LEVELS).map((b: string[]) => {
        const price = parseFloat(b[0]); const qty = parseFloat(b[1]); const notional = price * qty;
        return { price, qty, notional, isWhale: notional > WHALE_NOTIONAL_USD };
      });
      const asks: DepthLevel[] = data.asks.slice(0, TOP_OB_LEVELS).map((a: string[]) => {
        const price = parseFloat(a[0]); const qty = parseFloat(a[1]); const notional = price * qty;
        return { price, qty, notional, isWhale: notional > WHALE_NOTIONAL_USD };
      });
      if (bids.length === 0 || asks.length === 0) return;
      const bestBid = bids[0].price;
      const bestAsk = asks[0].price;
      const mid = (bestBid + bestAsk) / 2;
      const spreadBps = ((bestAsk - bestBid) / mid) * 10000;
      const bidNotional = bids.reduce((s, b) => s + b.notional, 0);
      const askNotional = asks.reduce((s, a) => s + a.notional, 0);
      const whaleZones = [
        ...bids.filter(b => b.isWhale).map(b => ({ side: 'bid' as const, price: b.price, notional: b.notional })),
        ...asks.filter(a => a.isWhale).map(a => ({ side: 'ask' as const, price: a.price, notional: a.notional })),
      ];
      const newDepth: DepthData = { bids, asks, bestBid, bestAsk, mid, spreadBps, bidNotional, askNotional, whaleZones };
      latestDepthRef.current = newDepth;
      setDepth(newDepth);
      const trade = tradeDataRef.current;
      trade.priceHistory.push({ ts: Date.now(), price: mid });
      if (trade.priceHistory.length > MAX_PRICE_HISTORY) {
        trade.priceHistory.splice(0, trade.priceHistory.length - MAX_PRICE_HISTORY);
      }
    };
    depthWsRef.current = depthWs;

    const tradeWs = new WebSocket(
      `wss://stream.binance.com:9443/ws/${selectedSymbol.toLowerCase()}@aggTrade`
    );
    tradeWs.onmessage = (event) => {
      const t = JSON.parse(event.data);
      const ts = t.T;
      const price = parseFloat(t.p);
      const qty = parseFloat(t.q);
      const isBuyer = !t.m;
      const notional = price * qty;
      const trade = tradeDataRef.current;
      trade.recentTrades.push({ ts, price, qty: notional, isBuyer });
      trade.lastPrice = price;
      if (trade.recentTrades.length > MAX_RECENT_TRADES) {
        const cutoff = Date.now() - 60_000;
        trade.recentTrades = trade.recentTrades.filter(tr => tr.ts > cutoff);
      }
      let bv = 0, sv = 0;
      for (const tr of trade.recentTrades) { if (tr.isBuyer) bv += tr.qty; else sv += tr.qty; }
      trade.buyVol = bv;
      trade.sellVol = sv;
    };
    tradeWsRef.current = tradeWs;

    return () => { depthWs.close(); tradeWs.close(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSymbol]);

  // ─── Signal compute ──────────────────────────────────────────────────────
  useEffect(() => {
    const interval = setInterval(() => {
      const d = latestDepthRef.current;
      if (!d) return;
      const trade = tradeDataRef.current;
      const cutoff = Date.now() - 60_000;
      trade.recentTrades = trade.recentTrades.filter(tr => tr.ts > cutoff);
      const flags: string[] = [];
      if (d.whaleZones.some(w => w.side === 'bid')) flags.push('WHALE_BID');
      if (d.whaleZones.some(w => w.side === 'ask')) flags.push('WHALE_ASK');
      if (detectSweep(trade.priceHistory)) flags.push('SWEEP');
      const newSignal = computeUnifiedSignal(d, trade, flags);
      setSignal(newSignal);

      // Rationale feed: detect direction flips and new flags
      if (newSignal.direction !== lastDirRef.current) {
        pushRationale('FLIP', `SIGNAL FLIP → ${newSignal.direction} on ${selectedSymbol} · ${newSignal.confidence}%`);
        lastDirRef.current = newSignal.direction;
      }
      const flagSet = new Set(flags);
      flags.forEach(f => {
        if (!lastFlagsRef.current.has(f)) {
          if (f === 'WHALE_BID' || f === 'WHALE_ASK') {
            pushRationale('WHALE', `${f} detected on ${selectedSymbol}`);
          } else if (f === 'SWEEP') {
            pushRationale('WARN', `Liquidity SWEEP on ${selectedSymbol}`);
          }
        }
      });
      lastFlagsRef.current = flagSet;

      const now = Date.now();
      if (newSignal.direction !== 'NEUTRAL' &&
          newSignal.confidence >= SIGNAL_LOG_MIN_CONFIDENCE &&
          newSignal.risk) {
        const last = lastSignalRef.current;
        const ce = !last || last.symbol !== selectedSymbol || (now - last.ts) > SIGNAL_COOLDOWN_MS;
        if (ce) {
          lastSignalRef.current = { symbol: selectedSymbol, direction: newSignal.direction, ts: now };
          pushRationale('SIGNAL', `LOGGED ${newSignal.direction} ${selectedSymbol} @ ${d.mid.toFixed(2)} · RR ${newSignal.risk.rr.toFixed(2)}`);
          setSignalLog(prev => [{
            id: signalIdRef.current++,
            symbol: selectedSymbol,
            direction: newSignal.direction,
            confidence: newSignal.confidence,
            entryPrice: d.mid,
            stopLoss: newSignal.risk!.stopLoss,
            takeProfit: newSignal.risk!.takeProfit,
            rr: newSignal.risk!.rr,
            timestamp: now,
            outcome: 'pending' as const,
          }, ...prev].slice(0, 30));
        }
      }
    }, SIGNAL_RECOMPUTE_MS);
    return () => clearInterval(interval);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSymbol]);

  // ─── Signal resolution ───────────────────────────────────────────────────
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      setSignalLog(prev => prev.map(log => {
        if (log.outcome !== 'pending') return log;
        if (now - log.timestamp < 5 * 60 * 1000) return log;
        const cp = coinData[log.symbol]?.price;
        if (!cp) return log;
        const pnlPct = ((cp - log.entryPrice) / log.entryPrice) * 100;
        const dm = log.direction === 'LONG' ? 1 : -1;
        const adj = pnlPct * dm;
        const outcome = (adj > 0 ? 'win' : 'loss') as 'win' | 'loss';
        pushRationale(outcome === 'win' ? 'SIGNAL' : 'WARN',
          `RESOLVED ${log.direction} ${log.symbol} · ${outcome.toUpperCase()} · ${adj >= 0 ? '+' : ''}${adj.toFixed(3)}%`);
        return { ...log, resolvedPrice: cp, pnlPct: parseFloat(adj.toFixed(3)), outcome };
      }));
    }, 10_000);
    return () => clearInterval(interval);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coinData]);

  // ─── Formatters ──────────────────────────────────────────────────────────
  const formatPrice = (p: number) => {
    if (p >= 1000) return p.toLocaleString('en-US', { maximumFractionDigits: 2 });
    if (p >= 1) return p.toFixed(4);
    return p.toFixed(6);
  };
  const formatVol = (v: number) => {
    if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
    if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
    if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
    return v.toFixed(0);
  };
  const formatTime = (ts: number) => {
    const d = new Date(ts);
    return `${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}:${d.getSeconds().toString().padStart(2,'0')}`;
  };

  // ─── Derived state ───────────────────────────────────────────────────────
  const maxQty = useMemo(() =>
    depth ? Math.max(...depth.bids.map(b => b.qty), ...depth.asks.map(a => a.qty)) : 1,
    [depth]
  );
  const liquidityZones = useMemo(() =>
    depth ? findLiquidityZones(depth) : { longZones: [], shortZones: [] },
    [depth]
  );
  const { topGainers, topLosers } = useMemo(() => {
    const sorted = COINS.map(c => ({ ...c, data: coinData[c.symbol] })).filter(c => c.data);
    return {
      topGainers: [...sorted].sort((a, b) => b.data!.change - a.data!.change).slice(0, 3),
      topLosers: [...sorted].sort((a, b) => a.data!.change - b.data!.change).slice(0, 3),
    };
  }, [coinData]);
  const { wins, losses, winRate, avgPnl, resolvedSignals } = useMemo(() => {
    const r = signalLog.filter(s => s.outcome === 'win' || s.outcome === 'loss');
    const w = r.filter(s => s.outcome === 'win').length;
    const l = r.filter(s => s.outcome === 'loss').length;
    return {
      resolvedSignals: r, wins: w, losses: l,
      winRate: r.length > 0 ? (w / r.length) * 100 : 0,
      avgPnl: r.length > 0 ? r.reduce((s, x) => s + (x.pnlPct || 0), 0) / r.length : 0,
    };
  }, [signalLog]);

  const totalNotional = depth ? depth.bidNotional + depth.askNotional : 0;
  const bidPct = depth && totalNotional > 0 ? (depth.bidNotional / totalNotional) * 100 : 50;
  const askPct = 100 - bidPct;
  const pressureLabel = bidPct > 65 ? 'BULLISH PRESSURE' : bidPct < 35 ? 'BEARISH PRESSURE' : 'NEUTRAL';
  const pressureColor = bidPct > 65 ? 'text-green-400' : bidPct < 35 ? 'text-pink-400' : 'text-yellow-400';
  const hotSignals = signalLog.filter(s => s.outcome === 'pending').slice(0, 3);

  // Theme tokens for the locked direction
  const theme = signal.direction === 'LONG'
    ? { text: 'text-green-400', border: 'border-green-400/50', glow: 'shadow-[0_0_40px_rgba(74,222,128,0.35)]', bg: 'bg-green-400/[0.04]', hex: '#4ADE80' }
    : signal.direction === 'SHORT'
    ? { text: 'text-pink-400', border: 'border-pink-400/50', glow: 'shadow-[0_0_40px_rgba(236,72,153,0.35)]', bg: 'bg-pink-400/[0.04]', hex: '#EC4899' }
    : { text: 'text-yellow-400', border: 'border-yellow-400/40', glow: 'shadow-[0_0_40px_rgba(250,204,21,0.25)]', bg: 'bg-yellow-400/[0.04]', hex: '#FACC15' };

  // ═══════════════════════════════════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════════════════════════════════
  return (
    <main className="min-h-screen bg-black text-white font-mono overflow-x-hidden" style={{ fontFamily: 'var(--font-geist-mono), ui-monospace, Menlo, monospace' }}>
      {/* Cyan grid background */}
      <div
        className="fixed inset-0 pointer-events-none opacity-[0.04] z-0"
        style={{
          backgroundImage: 'linear-gradient(rgba(34,211,238,1) 1px, transparent 1px), linear-gradient(90deg, rgba(34,211,238,1) 1px, transparent 1px)',
          backgroundSize: '48px 48px',
        }}
      />

      <div className="relative z-10 px-4 md:px-6 py-4">
        {/* ═══════ HEADER ═══════ */}
        <header className="flex items-center justify-between mb-4 pb-3 border-b border-cyan-500/20">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 border border-cyan-400/50 rounded flex items-center justify-center bg-cyan-400/5 shadow-[0_0_12px_rgba(34,211,238,0.2)]">
              <span className="text-cyan-400 text-base font-black">R</span>
            </div>
            <div>
              <div className="text-base md:text-lg font-bold tracking-[0.2em] leading-none">
                RAUF<span className="text-cyan-400">·</span>SIGNALS
              </div>
              <div className="text-[9px] text-gray-500 tracking-[0.3em] mt-0.5">v2.3 · SIGNAL COMMAND CENTER</div>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <StatusBadge tone="green">
              <span className="relative flex h-1.5 w-1.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-green-400"></span>
              </span>
              WS · BINANCE SPOT
            </StatusBadge>
            <StatusBadge tone="cyan">SPOT</StatusBadge>
            <StatusBadge tone="yellow">⚠ NOT FINANCIAL ADVICE</StatusBadge>
            <div className="text-cyan-400 text-[11px] font-bold tabular-nums tracking-widest">{time || '--:--:--'}</div>
          </div>
        </header>

        {/* ═══════ TICKER STRIP ═══════ */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2 mb-4">
          <div className="border border-green-500/20 bg-green-500/[0.03] rounded-sm p-2.5 shadow-[0_0_16px_rgba(74,222,128,0.08)]">
            <div className="flex justify-between items-center mb-1.5">
              <span className="text-[9px] font-bold tracking-[0.25em] text-green-400">▸ TOP GAINERS · 24H</span>
              <span className="text-[8px] text-gray-600">3</span>
            </div>
            <div className="space-y-1">
              {topGainers.length > 0 ? topGainers.map(c => (
                <button key={c.symbol} onClick={() => setSelectedSymbol(c.symbol)}
                  className="w-full grid grid-cols-3 items-center text-[10px] hover:bg-green-500/10 px-1.5 py-0.5 rounded-sm transition-colors">
                  <span className="font-bold text-white tracking-wider text-left">{c.display}</span>
                  <span className="text-gray-400 tabular-nums text-center">${formatPrice(c.data!.price)}</span>
                  <span className="text-green-400 font-bold tabular-nums text-right">+{c.data!.change.toFixed(2)}%</span>
                </button>
              )) : <div className="text-[9px] text-gray-600 px-1.5 py-2">Loading...</div>}
            </div>
          </div>
          <div className="border border-pink-500/20 bg-pink-500/[0.03] rounded-sm p-2.5 shadow-[0_0_16px_rgba(236,72,153,0.08)]">
            <div className="flex justify-between items-center mb-1.5">
              <span className="text-[9px] font-bold tracking-[0.25em] text-pink-400">▸ TOP LOSERS · 24H</span>
              <span className="text-[8px] text-gray-600">3</span>
            </div>
            <div className="space-y-1">
              {topLosers.length > 0 ? topLosers.map(c => (
                <button key={c.symbol} onClick={() => setSelectedSymbol(c.symbol)}
                  className="w-full grid grid-cols-3 items-center text-[10px] hover:bg-pink-500/10 px-1.5 py-0.5 rounded-sm transition-colors">
                  <span className="font-bold text-white tracking-wider text-left">{c.display}</span>
                  <span className="text-gray-400 tabular-nums text-center">${formatPrice(c.data!.price)}</span>
                  <span className="text-pink-400 font-bold tabular-nums text-right">{c.data!.change.toFixed(2)}%</span>
                </button>
              )) : <div className="text-[9px] text-gray-600 px-1.5 py-2">Loading...</div>}
            </div>
          </div>
          <div className="border border-yellow-400/20 bg-yellow-400/[0.03] rounded-sm p-2.5 shadow-[0_0_16px_rgba(250,204,21,0.08)]">
            <div className="flex justify-between items-center mb-1.5">
              <span className="text-[9px] font-bold tracking-[0.25em] text-yellow-400">▸ HOT SIGNALS · LIVE</span>
              <span className="text-[8px] text-gray-600">{hotSignals.length}/3</span>
            </div>
            <div className="space-y-1">
              {hotSignals.length > 0 ? hotSignals.map(s => (
                <div key={s.id} className="grid grid-cols-4 items-center text-[10px] px-1.5 py-0.5">
                  <span className="font-bold text-white tracking-wider">{s.symbol.replace('USDT','')}</span>
                  <span className={`font-bold ${s.direction === 'LONG' ? 'text-green-400' : 'text-pink-400'}`}>{s.direction}</span>
                  <span className="text-cyan-400 tabular-nums text-right">{s.confidence}%</span>
                  <span className="text-yellow-400 tabular-nums text-right">{s.rr.toFixed(1)}R</span>
                </div>
              )) : <div className="text-[9px] text-gray-600 px-1.5 py-2">Awaiting 70%+ conviction…</div>}
            </div>
          </div>
        </div>

        {/* ═══════ MARKET SCANNER ═══════ */}
        <section className="mb-4">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-[9px] font-bold tracking-[0.3em] text-gray-500">▸ MARKET SCANNER</h2>
            <div className="text-[9px] text-cyan-400 tracking-[0.25em]">10 SYMBOLS · 1 LOCKED</div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 lg:grid-cols-10 gap-1.5">
            {COINS.map(coin => {
              const data = coinData[coin.symbol];
              const isUp = data && data.change >= 0;
              const isSelected = coin.symbol === selectedSymbol;
              return (
                <button key={coin.symbol} onClick={() => setSelectedSymbol(coin.symbol)}
                  className={`relative p-2 rounded-sm border text-left transition-all duration-150 ${
                    isSelected
                      ? 'border-cyan-400 bg-cyan-400/[0.06] shadow-[0_0_20px_rgba(34,211,238,0.4)]'
                      : 'border-gray-800 bg-gray-900/30 hover:border-gray-700 hover:bg-gray-900/60'
                  }`}>
                  {isSelected && (
                    <div className="absolute -top-1.5 left-1.5 px-1 py-px bg-cyan-400 rounded-sm text-[7px] font-bold text-black tracking-[0.2em] leading-none">◆ LOCKED</div>
                  )}
                  <div className="flex justify-between items-center mb-1">
                    <span className="text-[11px] font-bold tracking-wider">{coin.display}</span>
                    {data && (
                      <span className={`text-[8px] tabular-nums ${isUp ? 'text-green-400' : 'text-pink-400'}`}>
                        {isUp ? '+' : ''}{data.change.toFixed(2)}%
                      </span>
                    )}
                  </div>
                  <div className={`text-[11px] font-bold tabular-nums ${isUp ? 'text-green-300' : 'text-pink-300'}`}>
                    {data ? '$' + formatPrice(data.price) : '—'}
                  </div>
                  <div className="text-[8px] text-gray-600 tracking-wider mt-0.5">VOL ${data ? formatVol(data.volume) : '—'}</div>
                </button>
              );
            })}
          </div>
        </section>

        {/* ═══════ REACTOR CORE — HERO with TYPE HERO scale ═══════ */}
        <section className={`relative mb-4 rounded-lg border-2 ${theme.border} ${theme.glow} bg-gray-900/30 backdrop-blur overflow-hidden`}>
          <div className="grid grid-cols-1 lg:grid-cols-[1.4fr_auto_1fr] gap-5 p-5 md:p-6 items-stretch">
            {/* LEFT — TYPE HERO direction display */}
            <div className="flex flex-col justify-between min-h-[220px]">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-[9px] tracking-[0.3em] text-gray-500">▸ REACTOR CORE</div>
                  <div className="text-cyan-400 text-[12px] font-bold tracking-widest mt-0.5">{selectedSymbol}</div>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <StatusBadge tone="gray">SIGNAL ONLY · NO EXEC</StatusBadge>
                  <StatusBadge tone="yellow">⚠ NOT FINANCIAL ADVICE</StatusBadge>
                </div>
              </div>
              <div>
                {/* TYPE HERO — text-9xl scale (~128px), drop-shadow bleed */}
                <div
                  className={`font-black tracking-[-0.02em] leading-[0.9] ${theme.text}`}
                  style={{
                    fontSize: 'clamp(72px, 11vw, 128px)',
                    filter: `drop-shadow(0 0 24px ${theme.hex})`,
                  }}
                >
                  {signal.direction}
                </div>
                <div className="text-[12px] text-cyan-400 tracking-widest mt-3">▸ {signal.rationale}</div>
                {signal.flags.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {signal.flags.map(f => <StatusBadge key={f} tone="yellow">⚠ {f}</StatusBadge>)}
                  </div>
                )}
              </div>
            </div>

            {/* CENTER — Confidence ring */}
            <div className="flex items-center justify-center">
              <div className={`relative w-44 h-44 rounded-full border-2 flex flex-col items-center justify-center backdrop-blur ${theme.border} ${theme.bg}`}
                style={{ boxShadow: `0 0 40px ${theme.hex}33, inset 0 0 20px ${theme.hex}11` }}>
                <div className="text-[8px] text-gray-500 tracking-[0.3em]">CONFIDENCE</div>
                <div className={`text-6xl font-black ${theme.text} tabular-nums leading-none mt-1`}
                  style={{ filter: `drop-shadow(0 0 12px ${theme.hex})` }}>
                  {signal.confidence}
                </div>
                <div className="text-[9px] text-gray-500 tracking-widest mt-1">PERCENT</div>
                <div className="text-[9px] text-cyan-400 tracking-[0.2em] mt-1">{signal.agreement}/3 AGREE</div>
              </div>
            </div>

            {/* RIGHT — Risk panel */}
            {signal.risk && signal.direction !== 'NEUTRAL' ? (
              <div className="border border-gray-800 rounded-sm bg-black/40 p-3.5 flex flex-col justify-between">
                <div className="text-[9px] tracking-[0.3em] text-gray-500 mb-2">▸ RISK ZONES</div>
                <div className="space-y-2.5 text-[12px]">
                  <div className="flex justify-between items-baseline">
                    <span className="text-gray-500 tracking-wider">ENTRY</span>
                    <span className="text-white font-bold tabular-nums">{formatPrice(depth?.mid || 0)}</span>
                  </div>
                  <div className="flex justify-between items-baseline">
                    <span className="text-gray-500 tracking-wider">STOP</span>
                    <span className="text-pink-400 font-bold tabular-nums">{formatPrice(signal.risk.stopLoss)} <span className="text-[9px] opacity-70">−{signal.risk.riskPct.toFixed(2)}%</span></span>
                  </div>
                  <div className="flex justify-between items-baseline">
                    <span className="text-gray-500 tracking-wider">TARGET</span>
                    <span className="text-green-400 font-bold tabular-nums">{formatPrice(signal.risk.takeProfit)} <span className="text-[9px] opacity-70">+{signal.risk.rewardPct.toFixed(2)}%</span></span>
                  </div>
                  <div className="flex justify-between items-baseline pt-2 border-t border-gray-800">
                    <span className="text-gray-500 tracking-wider">R:R</span>
                    <span className={`font-bold tabular-nums text-lg ${signal.risk.rr >= MIN_RR_RATIO ? 'text-yellow-400' : 'text-red-400'}`}
                      style={{ filter: signal.risk.rr >= MIN_RR_RATIO ? 'drop-shadow(0 0 6px #FACC15)' : 'drop-shadow(0 0 6px #EF4444)' }}>
                      {signal.risk.rr.toFixed(2)}<span className="text-[9px] text-gray-600 ml-1">MIN {MIN_RR_RATIO}</span>
                    </span>
                  </div>
                </div>
              </div>
            ) : (
              <div className="border border-gray-800 border-dashed rounded-sm bg-black/20 p-3 flex items-center justify-center text-center">
                <div>
                  <div className="text-[9px] tracking-[0.3em] text-gray-600 mb-1">▸ RISK ZONES</div>
                  <div className="text-[10px] text-gray-600">Awaiting directional signal</div>
                </div>
              </div>
            )}
          </div>

          {/* Factor strip */}
          <div className="border-t border-gray-800 grid grid-cols-5 divide-x divide-gray-800">
            {(['obi','pressure','delta','spread','vol'] as const).map(k => {
              const v = signal.factors[k];
              const w = FACTOR_WEIGHTS[k] * 100;
              const isDirectional = k === 'obi' || k === 'pressure' || k === 'delta';
              const barColor = isDirectional
                ? (v > 25 ? 'bg-green-400' : v < -25 ? 'bg-pink-400' : 'bg-yellow-400')
                : 'bg-cyan-400';
              const valColor = isDirectional
                ? (v > 25 ? 'text-green-400' : v < -25 ? 'text-pink-400' : 'text-yellow-400')
                : 'text-cyan-400';
              return (
                <div key={k} className="p-2.5">
                  <div className="flex justify-between items-baseline mb-1">
                    <span className="text-[9px] text-gray-400 tracking-[0.2em] uppercase">{k}</span>
                    <span className="text-[8px] text-gray-600">{w.toFixed(0)}%</span>
                  </div>
                  <div className="h-1 bg-gray-900 rounded-sm overflow-hidden mb-1">
                    <div className={`h-full transition-all duration-500 ${barColor}`} style={{ width: `${Math.min(100, Math.abs(v))}%` }} />
                  </div>
                  <div className={`text-sm font-bold tabular-nums ${valColor}`}>{v > 0 ? '+' : ''}{v.toFixed(0)}</div>
                </div>
              );
            })}
          </div>
        </section>

        {/* ═══════ FUNDING GAUGE + RATIONALE FEED ═══════ */}
        <section className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-3 mb-4">
          <FundingBiasGauge value={signal.factors.obi} label="OBI · ORDER-BOOK BIAS" />

          {/* RATIONALE FEED — terminal-style scrolling log */}
          <div className="border border-gray-800 rounded bg-gray-900/30 flex flex-col">
            <div className="flex justify-between items-center px-3 py-2 border-b border-gray-800">
              <span className="text-[9px] font-bold tracking-[0.3em] text-gray-500">▸ RATIONALE FEED · TERMINAL LOG</span>
              <span className="text-[9px] text-cyan-400 tracking-[0.25em]">{rationaleFeed.length}/{MAX_RATIONALE_FEED}</span>
            </div>
            <div className="flex-1 overflow-y-auto max-h-[260px] text-[11px] tabular-nums">
              {rationaleFeed.length === 0 ? (
                <div className="text-center text-gray-600 py-8 text-[10px] tracking-[0.25em]">▸ AWAITING EVENTS…</div>
              ) : (
                <div className="px-3 py-2 space-y-0.5">
                  {rationaleFeed.map(e => {
                    const tone = e.level === 'FLIP' ? 'text-cyan-300'
                      : e.level === 'WHALE' ? 'text-yellow-300'
                      : e.level === 'WARN' ? 'text-pink-300'
                      : e.level === 'SIGNAL' ? 'text-green-300'
                      : 'text-gray-400';
                    const symbol = e.level === 'FLIP' ? '⟳'
                      : e.level === 'WHALE' ? '🐋'
                      : e.level === 'WARN' ? '⚠'
                      : e.level === 'SIGNAL' ? '◆'
                      : '·';
                    return (
                      <div key={e.id} className="grid grid-cols-[auto_auto_1fr] gap-2 leading-tight">
                        <span className="text-gray-600">{formatTime(e.ts)}</span>
                        <span className={tone}>{symbol}</span>
                        <span className={tone}>{e.msg}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            <div className="border-t border-gray-800 px-3 py-1.5 flex items-center gap-3 text-[8px] tracking-[0.25em] text-gray-600">
              <span><span className="text-cyan-300">⟳</span> FLIP</span>
              <span><span className="text-yellow-300">🐋</span> WHALE</span>
              <span><span className="text-green-300">◆</span> SIGNAL</span>
              <span><span className="text-pink-300">⚠</span> WARN</span>
              <span><span className="text-gray-400">·</span> INFO</span>
            </div>
          </div>
        </section>

        {/* ═══════ DEPTH + LIQUIDITY ═══════ */}
        <section className="grid grid-cols-1 lg:grid-cols-2 gap-3 mb-4">
          {/* DEPTH */}
          <div className="border border-gray-800 rounded-sm bg-gray-900/30">
            <div className="flex justify-between items-center px-3 py-2 border-b border-gray-800">
              <span className="text-[9px] font-bold tracking-[0.3em] text-gray-500">▸ DEPTH PRESSURE MAP</span>
              <span className="text-[9px] text-cyan-400 tracking-[0.25em]">TOP 20 · 100ms</span>
            </div>
            {depth ? (
              <div className="p-3">
                <div className="grid grid-cols-3 mb-3 pb-2 border-b border-gray-800 text-[10px] tabular-nums">
                  <div><div className="text-[8px] text-gray-600 tracking-[0.25em]">BID</div><div className="text-green-400 font-bold">{formatPrice(depth.bestBid)}</div></div>
                  <div className="text-center"><div className="text-[8px] text-gray-600 tracking-[0.25em]">MID</div><div className="text-yellow-400 font-bold" style={{ filter: 'drop-shadow(0 0 6px rgba(250,204,21,0.6))' }}>{formatPrice(depth.mid)}</div></div>
                  <div className="text-right"><div className="text-[8px] text-gray-600 tracking-[0.25em]">ASK</div><div className="text-pink-400 font-bold">{formatPrice(depth.bestAsk)}</div></div>
                </div>
                <div className="space-y-0.5">
                  {Array.from({ length: Math.min(15, TOP_OB_LEVELS) }).map((_, i) => {
                    const bid = depth.bids[i];
                    const ask = depth.asks[i];
                    const bw = bid ? (bid.qty / maxQty) * 100 : 0;
                    const aw = ask ? (ask.qty / maxQty) * 100 : 0;
                    return (
                      <div key={i} className="grid grid-cols-[1fr_auto_auto_1fr] gap-1.5 items-center text-[10px] tabular-nums">
                        <div className="h-3.5 bg-gray-950 relative overflow-hidden rounded-sm">
                          {bid && (
                            <div className={`absolute right-0 top-0 h-full ${
                              bid.isWhale
                                ? 'bg-gradient-to-l from-yellow-400/50 to-transparent border-r border-yellow-400'
                                : 'bg-gradient-to-l from-green-500/35 to-transparent border-r border-green-400'
                            } text-right pr-1.5 leading-[14px] text-[9px] ${bid.isWhale ? 'text-yellow-300' : 'text-green-400'}`}
                              style={{ width: `${bw}%` }}>
                              {bid.qty.toFixed(3)}{bid.isWhale && ' 🐋'}
                            </div>
                          )}
                        </div>
                        <div className="text-green-400 w-16 text-right">{bid ? formatPrice(bid.price) : ''}</div>
                        <div className="text-pink-400 w-16">{ask ? formatPrice(ask.price) : ''}</div>
                        <div className="h-3.5 bg-gray-950 relative overflow-hidden rounded-sm">
                          {ask && (
                            <div className={`absolute left-0 top-0 h-full ${
                              ask.isWhale
                                ? 'bg-gradient-to-r from-yellow-400/50 to-transparent border-l border-yellow-400'
                                : 'bg-gradient-to-r from-pink-500/35 to-transparent border-l border-pink-400'
                            } pl-1.5 leading-[14px] text-[9px] ${ask.isWhale ? 'text-yellow-300' : 'text-pink-400'}`}
                              style={{ width: `${aw}%` }}>
                              {ask.isWhale && '🐋 '}{ask.qty.toFixed(3)}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="grid grid-cols-3 gap-2 mt-3 pt-2 border-t border-gray-800 text-[10px] tabular-nums">
                  <div><div className="text-[8px] text-gray-600 tracking-[0.25em]">BID NOTIONAL</div><div className="text-green-400 font-bold">${formatVol(depth.bidNotional)}</div></div>
                  <div className="text-center"><div className="text-[8px] text-gray-600 tracking-[0.25em]">SPREAD</div><div className="text-cyan-400 font-bold">{depth.spreadBps.toFixed(2)} bps</div></div>
                  <div className="text-right"><div className="text-[8px] text-gray-600 tracking-[0.25em]">ASK NOTIONAL</div><div className="text-pink-400 font-bold">${formatVol(depth.askNotional)}</div></div>
                </div>
              </div>
            ) : (
              <div className="text-center text-gray-600 py-10 text-[10px] tracking-[0.25em]">▸ INITIALIZING DEPTH…</div>
            )}
          </div>

          {/* LIQUIDITY HEATMAP */}
          <div className="border border-gray-800 rounded-sm bg-gray-900/30">
            <div className="flex justify-between items-center px-3 py-2 border-b border-gray-800">
              <span className="text-[9px] font-bold tracking-[0.3em] text-gray-500">▸ LIQUIDITY HEATMAP</span>
              <span className="text-[9px] text-cyan-400 tracking-[0.25em]">±53 BPS · WALLS</span>
            </div>
            {depth ? (
              <div className="p-3">
                <div className="relative h-16 bg-gray-950 rounded-sm overflow-hidden mb-2">
                  <div className="absolute inset-0 flex">
                    <div className="flex-1 flex flex-row-reverse">
                      {depth.bids.slice().reverse().map((b, i) => {
                        const intensity = Math.min(100, (b.notional / WHALE_NOTIONAL_USD) * 100);
                        const bg = b.isWhale
                          ? `rgba(250, 204, 21, ${0.3 + intensity / 200})`
                          : `rgba(74, 222, 128, ${0.15 + intensity / 200})`;
                        return (
                          <div key={`b-${i}`} className="flex-1 relative" style={{ background: bg }}
                            title={`${formatPrice(b.price)} · $${formatVol(b.notional)}${b.isWhale ? ' 🐋' : ''}`}>
                            {b.isWhale && <div className="absolute inset-0 flex items-center justify-center text-[9px]">🐋</div>}
                          </div>
                        );
                      })}
                    </div>
                    <div className="w-px bg-yellow-400 z-10 shadow-[0_0_10px_rgba(250,204,21,0.8)]" />
                    <div className="flex-1 flex flex-row">
                      {depth.asks.map((a, i) => {
                        const intensity = Math.min(100, (a.notional / WHALE_NOTIONAL_USD) * 100);
                        const bg = a.isWhale
                          ? `rgba(250, 204, 21, ${0.3 + intensity / 200})`
                          : `rgba(244, 114, 182, ${0.15 + intensity / 200})`;
                        return (
                          <div key={`a-${i}`} className="flex-1 relative" style={{ background: bg }}
                            title={`${formatPrice(a.price)} · $${formatVol(a.notional)}${a.isWhale ? ' 🐋' : ''}`}>
                            {a.isWhale && <div className="absolute inset-0 flex items-center justify-center text-[9px]">🐋</div>}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
                <div className="flex justify-between text-[8px] text-gray-600 tracking-wider mb-2 tabular-nums">
                  <span>← {depth.bids[depth.bids.length-1] ? formatPrice(depth.bids[depth.bids.length-1].price) : ''}</span>
                  <span className="text-yellow-400">MID {formatPrice(depth.mid)}</span>
                  <span>{depth.asks[depth.asks.length-1] ? formatPrice(depth.asks[depth.asks.length-1].price) : ''} →</span>
                </div>
                <div className="grid grid-cols-2 gap-2 mt-2">
                  <div>
                    <div className="text-[9px] text-green-400 tracking-[0.2em] mb-1">▸ FRESH LONG · SUPPORT</div>
                    {liquidityZones.longZones.slice(0, 3).map((z, i) => (
                      <div key={i} className={`flex items-center justify-between text-[10px] px-1.5 py-1 mb-1 rounded-sm ${
                        z.strength === 'WHALE' ? 'bg-yellow-400/10 border border-yellow-400/30 shadow-[0_0_8px_rgba(250,204,21,0.2)]'
                        : z.strength === 'STRONG' ? 'bg-green-400/[0.07]' : 'bg-green-400/[0.04]'
                      }`}>
                        <span className={`px-1 rounded-sm text-[7px] tracking-[0.2em] font-bold ${
                          z.strength === 'WHALE' ? 'bg-yellow-400 text-black'
                          : z.strength === 'STRONG' ? 'bg-green-500 text-black' : 'bg-green-700 text-white'
                        }`}>{z.strength}</span>
                        <span className="text-green-400 font-bold tabular-nums">{formatPrice(z.price)}</span>
                        <span className="text-cyan-400 tabular-nums">${formatVol(z.notional)}</span>
                      </div>
                    ))}
                    {liquidityZones.longZones.length === 0 && <div className="text-[9px] text-gray-600 px-1.5 py-1">No strong supports</div>}
                  </div>
                  <div>
                    <div className="text-[9px] text-pink-400 tracking-[0.2em] mb-1">▸ FRESH SHORT · RESISTANCE</div>
                    {liquidityZones.shortZones.slice(0, 3).map((z, i) => (
                      <div key={i} className={`flex items-center justify-between text-[10px] px-1.5 py-1 mb-1 rounded-sm ${
                        z.strength === 'WHALE' ? 'bg-yellow-400/10 border border-yellow-400/30 shadow-[0_0_8px_rgba(250,204,21,0.2)]'
                        : z.strength === 'STRONG' ? 'bg-pink-400/[0.07]' : 'bg-pink-400/[0.04]'
                      }`}>
                        <span className={`px-1 rounded-sm text-[7px] tracking-[0.2em] font-bold ${
                          z.strength === 'WHALE' ? 'bg-yellow-400 text-black'
                          : z.strength === 'STRONG' ? 'bg-pink-500 text-black' : 'bg-pink-700 text-white'
                        }`}>{z.strength}</span>
                        <span className="text-pink-400 font-bold tabular-nums">{formatPrice(z.price)}</span>
                        <span className="text-cyan-400 tabular-nums">${formatVol(z.notional)}</span>
                      </div>
                    ))}
                    {liquidityZones.shortZones.length === 0 && <div className="text-[9px] text-gray-600 px-1.5 py-1">No strong resistances</div>}
                  </div>
                </div>
              </div>
            ) : (
              <div className="text-center text-gray-600 py-10 text-[10px] tracking-[0.25em]">▸ INITIALIZING HEATMAP…</div>
            )}
          </div>
        </section>

        {/* ═══════ BUY/SELL PRESSURE ═══════ */}
        <section className="border border-gray-800 rounded-sm bg-gray-900/30 p-3 mb-4">
          <div className="flex justify-between items-center mb-2">
            <span className="text-[9px] font-bold tracking-[0.3em] text-gray-500">▸ BUY/SELL PRESSURE · {selectedSymbol}</span>
            <span className={`text-[9px] font-bold tracking-[0.25em] ${pressureColor}`}>{pressureLabel}</span>
          </div>
          <div className="relative h-7 bg-gray-950 rounded-sm overflow-hidden flex">
            <div className="bg-gradient-to-r from-green-600 to-green-400 flex items-center justify-end pr-2 transition-all duration-500 ease-out" style={{ width: `${bidPct}%` }}>
              {bidPct > 15 && <span className="text-[9px] font-bold text-black tracking-[0.2em] tabular-nums">BIDS {bidPct.toFixed(0)}%</span>}
            </div>
            <div className="bg-gradient-to-l from-pink-600 to-pink-400 flex items-center justify-start pl-2 transition-all duration-500 ease-out" style={{ width: `${askPct}%` }}>
              {askPct > 15 && <span className="text-[9px] font-bold text-black tracking-[0.2em] tabular-nums">ASKS {askPct.toFixed(0)}%</span>}
            </div>
          </div>
          <div className="flex justify-between mt-1.5 text-[9px] text-gray-600 tracking-widest tabular-nums">
            <span>BID ${depth ? formatVol(depth.bidNotional) : '—'}</span>
            <span>ASK ${depth ? formatVol(depth.askNotional) : '—'}</span>
          </div>
        </section>

        {/* ═══════ SIGNAL HISTORY ═══════ */}
        <section className="border border-gray-800 rounded-sm bg-gray-900/30 mb-4">
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center px-3 py-2 border-b border-gray-800 gap-2">
            <span className="text-[9px] font-bold tracking-[0.3em] text-gray-500">▸ SIGNAL HISTORY · LIVE TRACKING</span>
            <div className="flex gap-3 text-[10px] flex-wrap tabular-nums">
              <div><span className="text-gray-600 tracking-widest">TOTAL </span><span className="text-white font-bold">{signalLog.length}</span></div>
              <div><span className="text-gray-600 tracking-widest">W/L </span><span className="text-green-400 font-bold">{wins}</span><span className="text-gray-600">/</span><span className="text-pink-400 font-bold">{losses}</span></div>
              <div><span className="text-gray-600 tracking-widest">WIN RATE </span><span className={`font-bold ${winRate >= 50 ? 'text-green-400' : 'text-pink-400'}`}>{resolvedSignals.length > 0 ? winRate.toFixed(1) + '%' : '—'}</span></div>
              <div><span className="text-gray-600 tracking-widest">AVG PnL </span><span className={`font-bold ${avgPnl >= 0 ? 'text-green-400' : 'text-pink-400'}`}>{resolvedSignals.length > 0 ? (avgPnl >= 0 ? '+' : '') + avgPnl.toFixed(3) + '%' : '—'}</span></div>
            </div>
          </div>
          {signalLog.length > 0 ? (
            <div className="text-[10px] tabular-nums max-h-80 overflow-y-auto">
              <div className="grid grid-cols-7 gap-2 text-[8px] text-gray-600 tracking-[0.25em] border-b border-gray-800 px-3 py-1.5 bg-black/30 sticky top-0">
                <span>TIME</span><span>COIN</span><span>SIGNAL</span><span>CONF</span><span>ENTRY</span><span>RR</span><span className="text-right">OUTCOME</span>
              </div>
              {signalLog.map(s => {
                const timeStr = new Date(s.timestamp).toLocaleTimeString().slice(0, 8);
                const isWin = s.outcome === 'win';
                const isLoss = s.outcome === 'loss';
                const isPending = s.outcome === 'pending';
                return (
                  <div key={s.id} className={`grid grid-cols-7 gap-2 px-3 py-1 items-center text-[10px] border-b border-gray-900/60 ${
                    isWin ? 'bg-green-500/[0.05]' : isLoss ? 'bg-pink-500/[0.05]' : ''
                  }`}>
                    <span className="text-gray-400">{timeStr}</span>
                    <span className="font-bold text-white">{s.symbol.replace('USDT','')}</span>
                    <span className={`font-bold ${s.direction === 'LONG' ? 'text-green-400' : 'text-pink-400'}`}>{s.direction}</span>
                    <span className="text-cyan-400">{s.confidence}%</span>
                    <span className="text-gray-300">{formatPrice(s.entryPrice)}</span>
                    <span className="text-yellow-400">{s.rr.toFixed(1)}</span>
                    <span className="text-right">
                      {isPending ? (
                        <span className="text-yellow-400">PENDING</span>
                      ) : (
                        <span className={`font-bold ${isWin ? 'text-green-400' : 'text-pink-400'}`}>
                          {isWin ? '✓ ' : '✗ '}{(s.pnlPct! >= 0 ? '+' : '') + s.pnlPct!.toFixed(3) + '%'}
                        </span>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="text-center text-gray-600 py-8 text-[10px] tracking-[0.25em]">
              ▸ WAITING FOR HIGH-CONVICTION SIGNALS · 70%+ CONF · RR ≥ 1.5 · 5MIN COOLDOWN
            </div>
          )}
        </section>

        {/* ═══════ FOOTER ═══════ */}
        <footer className="pt-3 border-t border-gray-800 text-center">
          <div className="text-[8px] text-gray-700 tracking-[0.4em] mb-1">RAUF · SIGNALS · BUILT BY ABDUL RAUF · KARACHI · v2.3 TERMINAL</div>
          <div className="text-[8px] text-yellow-400/50 tracking-widest">⚠ PERSONAL USE · NOT FINANCIAL ADVICE · BACKTEST PENDING</div>
        </footer>
      </div>
    </main>
  );
}