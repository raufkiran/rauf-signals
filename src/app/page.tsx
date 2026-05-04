'use client';

import { useEffect, useState, useRef, useMemo } from 'react';

// ============================================================
// RAUF SIGNALS V2.1 - PERFORMANCE OPTIMIZED
// V2.0 unified engine + throttling + memoization
// Fixes: aggTrade flood, double-render, DOM bloat
// ============================================================

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
const SIGNAL_LOG_MIN_CONFIDENCE = 70;
const SIGNAL_COOLDOWN_MS = 5 * 60 * 1000;
const WHALE_NOTIONAL_USD = 500_000;
const TOP_OB_LEVELS = 20;

// V2.1 Performance Tuning
const SIGNAL_RECOMPUTE_MS = 500;
const MAX_RECENT_TRADES = 500;
const MAX_PRICE_HISTORY = 100;

interface CoinData { price: number; change: number; volume: number; }

interface DepthLevel {
  price: number;
  qty: number;
  notional: number;
  isWhale: boolean;
}

interface DepthData {
  bids: DepthLevel[];
  asks: DepthLevel[];
  bestBid: number;
  bestAsk: number;
  mid: number;
  spreadBps: number;
  bidNotional: number;
  askNotional: number;
  whaleZones: { side: 'bid' | 'ask'; price: number; notional: number }[];
}

interface FactorScores {
  obi: number;
  pressure: number;
  delta: number;
  spread: number;
  vol: number;
}

interface RiskZones {
  stopLoss: number;
  takeProfit: number;
  riskPct: number;
  rewardPct: number;
  rr: number;
}

interface Signal {
  direction: 'LONG' | 'SHORT' | 'NEUTRAL';
  confidence: number;
  finalScore: number;
  factors: FactorScores;
  agreement: number;
  rationale: string;
  risk: RiskZones | null;
  flags: string[];
}

interface SignalLog {
  id: number;
  symbol: string;
  direction: 'LONG' | 'SHORT' | 'NEUTRAL';
  confidence: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  rr: number;
  timestamp: number;
  resolvedPrice?: number;
  pnlPct?: number;
  outcome?: 'win' | 'loss' | 'pending';
}

interface TradeData {
  buyVol: number;
  sellVol: number;
  recentTrades: { ts: number; price: number; qty: number; isBuyer: boolean }[];
  lastPrice: number;
  priceHistory: { ts: number; price: number }[];
}

function calcOBI(bids: DepthLevel[], asks: DepthLevel[]): number {
  const bidNot = bids.reduce((s, b) => s + b.notional, 0);
  const askNot = asks.reduce((s, a) => s + a.notional, 0);
  const total = bidNot + askNot;
  if (total === 0) return 0;
  return ((bidNot - askNot) / total) * 100;
}

function calcPressure(bids: DepthLevel[], asks: DepthLevel[]): number {
  const bidWeight = bids.reduce((s, b, i) => s + b.qty * (TOP_OB_LEVELS - i), 0);
  const askWeight = asks.reduce((s, a, i) => s + a.qty * (TOP_OB_LEVELS - i), 0);
  const total = bidWeight + askWeight;
  if (total === 0) return 0;
  return ((bidWeight - askWeight) / total) * 100;
}

function calcDelta(trade: TradeData): number {
  const total = trade.buyVol + trade.sellVol;
  if (total === 0) return 0;
  return ((trade.buyVol - trade.sellVol) / total) * 100;
}

function calcSpreadScore(spreadBps: number): number {
  if (spreadBps < 0.5) return 100;
  if (spreadBps < 1) return 80;
  if (spreadBps < 2) return 60;
  if (spreadBps < 5) return 40;
  if (spreadBps < 10) return 20;
  return 0;
}

function calcVolScore(priceHistory: { ts: number; price: number }[]): { score: number; volPct: number } {
  if (priceHistory.length < 5) return { score: 50, volPct: 0 };
  const now = Date.now();
  const recent = priceHistory.filter(p => now - p.ts < 60_000);
  if (recent.length < 3) return { score: 50, volPct: 0 };
  const prices = recent.map(p => p.price);
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

function findRiskZones(
  direction: 'LONG' | 'SHORT',
  entry: number,
  bids: DepthLevel[],
  asks: DepthLevel[]
): RiskZones | null {
  if (bids.length === 0 || asks.length === 0) return null;
  const bidAvg = bids.reduce((s, b) => s + b.qty, 0) / bids.length;
  const askAvg = asks.reduce((s, a) => s + a.qty, 0) / asks.length;

  if (direction === 'LONG') {
    const supportWall = bids.find(b => b.qty > bidAvg * 3);
    const stopLoss = supportWall ? supportWall.price - (entry * 0.0001) : entry * 0.997;
    let tpPrice = asks[asks.length - 1].price;
    for (let i = 1; i < asks.length - 1; i++) {
      if (asks[i].qty < askAvg * 0.5 && asks[i + 1].qty < askAvg * 0.5) {
        tpPrice = asks[i + 1].price;
        break;
      }
    }
    if (tpPrice === asks[asks.length - 1].price) {
      tpPrice = entry + (entry - stopLoss) * 2;
    }
    const riskPct = ((entry - stopLoss) / entry) * 100;
    const rewardPct = ((tpPrice - entry) / entry) * 100;
    const rr = rewardPct / riskPct;
    return { stopLoss, takeProfit: tpPrice, riskPct, rewardPct, rr };
  } else {
    const resistanceWall = asks.find(a => a.qty > askAvg * 3);
    const stopLoss = resistanceWall ? resistanceWall.price + (entry * 0.0001) : entry * 1.003;
    let tpPrice = bids[bids.length - 1].price;
    for (let i = 1; i < bids.length - 1; i++) {
      if (bids[i].qty < bidAvg * 0.5 && bids[i + 1].qty < bidAvg * 0.5) {
        tpPrice = bids[i + 1].price;
        break;
      }
    }
    if (tpPrice === bids[bids.length - 1].price) {
      tpPrice = entry - (stopLoss - entry) * 2;
    }
    const riskPct = ((stopLoss - entry) / entry) * 100;
    const rewardPct = ((entry - tpPrice) / entry) * 100;
    const rr = rewardPct / riskPct;
    return { stopLoss, takeProfit: tpPrice, riskPct, rewardPct, rr };
  }
}

function detectSweep(priceHistory: { ts: number; price: number }[]): boolean {
  if (priceHistory.length < 5) return false;
  const now = Date.now();
  const recent = priceHistory.filter(p => now - p.ts < 10_000);
  if (recent.length < 3) return false;
  const high = Math.max(...recent.map(p => p.price));
  const low = Math.min(...recent.map(p => p.price));
  const lastPrice = recent[recent.length - 1].price;
  const range = ((high - low) / lastPrice) * 100;
  if (range > 0.3) {
    const midRange = (high + low) / 2;
    if (Math.abs(lastPrice - midRange) / lastPrice < 0.001) return true;
  }
  return false;
}

function computeUnifiedSignal(
  depth: DepthData,
  trade: TradeData,
  flags: string[]
): Signal {
  const obi = calcOBI(depth.bids, depth.asks);
  const pressure = calcPressure(depth.bids, depth.asks);
  const delta = calcDelta(trade);
  const spread = calcSpreadScore(depth.spreadBps);
  const { score: vol } = calcVolScore(trade.priceHistory);

  const obiSign = Math.sign(obi);
  const pressureSign = Math.sign(pressure);
  const deltaSign = Math.sign(delta);

  let agreeingFactors = 0;
  let dominantSign = 0;

  const longCount = [obiSign, pressureSign, deltaSign].filter(s => s > 0).length;
  const shortCount = [obiSign, pressureSign, deltaSign].filter(s => s < 0).length;

  if (longCount >= MIN_FACTOR_AGREEMENT) {
    dominantSign = 1;
    agreeingFactors = longCount;
  } else if (shortCount >= MIN_FACTOR_AGREEMENT) {
    dominantSign = -1;
    agreeingFactors = shortCount;
  }

  const directionalRaw = (obi * FACTOR_WEIGHTS.obi) +
                         (pressure * FACTOR_WEIGHTS.pressure) +
                         (delta * FACTOR_WEIGHTS.delta);

  const qualityMultiplier = ((spread * FACTOR_WEIGHTS.spread) + (vol * FACTOR_WEIGHTS.vol)) / 25;
  const finalScore = directionalRaw * Math.max(0.3, qualityMultiplier);

  let direction: 'LONG' | 'SHORT' | 'NEUTRAL' = 'NEUTRAL';
  let rationale = '';

  if (dominantSign === 0) {
    rationale = `MIXED FACTORS · ${longCount}L/${shortCount}S/${3 - longCount - shortCount}N`;
  } else if (Math.abs(finalScore) < DIRECTION_THRESHOLD) {
    rationale = `WEAK SCORE · ${finalScore.toFixed(1)} below ±${DIRECTION_THRESHOLD}`;
  } else if (dominantSign > 0 && finalScore > DIRECTION_THRESHOLD) {
    direction = 'LONG';
    rationale = `BULLISH ALIGNMENT · ${agreeingFactors}/3 factors`;
  } else if (dominantSign < 0 && finalScore < -DIRECTION_THRESHOLD) {
    direction = 'SHORT';
    rationale = `BEARISH ALIGNMENT · ${agreeingFactors}/3 factors`;
  } else {
    rationale = `SCORE/SIGN MISMATCH · ${finalScore.toFixed(1)}`;
  }

  let confidence = 60;
  if (direction !== 'NEUTRAL') {
    const scoreBonus = Math.min(20, (Math.abs(finalScore) / 50) * 20);
    const agreementBonus = (agreeingFactors - 1) * 6;
    const qualityBonus = qualityMultiplier * 4;
    confidence = Math.min(92, 60 + scoreBonus + agreementBonus + qualityBonus);
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
    agreement: agreeingFactors,
    rationale,
    risk,
    flags,
  };
}

export default function Home() {
  const [coinData, setCoinData] = useState<Record<string, CoinData>>({});
  const [selectedSymbol, setSelectedSymbol] = useState('BTCUSDT');
  const [depth, setDepth] = useState<DepthData | null>(null);
  const [signal, setSignal] = useState<Signal>({
    direction: 'NEUTRAL', confidence: 50, finalScore: 0,
    factors: { obi: 0, pressure: 0, delta: 0, spread: 0, vol: 0 },
    agreement: 0, rationale: 'Initializing V2.1 engine...', risk: null, flags: [],
  });
  const [time, setTime] = useState('');
  const [signalLog, setSignalLog] = useState<SignalLog[]>([]);

  // V2.1: Refs hold latest data; state updates throttled
  const depthRef = useRef<DepthData | null>(null);
  const tradeDataRef = useRef<TradeData>({
    buyVol: 0, sellVol: 0, recentTrades: [], lastPrice: 0, priceHistory: [],
  });

  const depthWsRef = useRef<WebSocket | null>(null);
  const tradeWsRef = useRef<WebSocket | null>(null);
  const signalIdRef = useRef(0);
  const lastSignalRef = useRef<{ symbol: string; direction: string; ts: number } | null>(null);

  // Tickers WebSocket
  useEffect(() => {
    const streams = COINS.map(c => `${c.symbol.toLowerCase()}@ticker`).join('/');
    const ws = new WebSocket(`wss://stream.binance.com:9443/stream?streams=${streams}`);

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      const data = msg.data;
      if (!data) return;
      setCoinData(prev => ({
        ...prev,
        [data.s]: {
          price: parseFloat(data.c),
          change: parseFloat(data.P),
          volume: parseFloat(data.q),
        }
      }));
    };

    const timer = setInterval(() => setTime(new Date().toLocaleTimeString()), 1000);
    return () => { ws.close(); clearInterval(timer); };
  }, []);

  // Depth + Trade WebSockets - data goes to REFS, not state
  useEffect(() => {
    if (depthWsRef.current) depthWsRef.current.close();
    if (tradeWsRef.current) tradeWsRef.current.close();

    tradeDataRef.current = {
      buyVol: 0, sellVol: 0, recentTrades: [], lastPrice: 0, priceHistory: [],
    };
    depthRef.current = null;

    const depthWs = new WebSocket(
      `wss://stream.binance.com:9443/ws/${selectedSymbol.toLowerCase()}@depth20@100ms`
    );

    depthWs.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (!data.bids || !data.asks) return;

      const bids: DepthLevel[] = data.bids.slice(0, TOP_OB_LEVELS).map((b: string[]) => {
        const price = parseFloat(b[0]);
        const qty = parseFloat(b[1]);
        const notional = price * qty;
        return { price, qty, notional, isWhale: notional > WHALE_NOTIONAL_USD };
      });
      const asks: DepthLevel[] = data.asks.slice(0, TOP_OB_LEVELS).map((a: string[]) => {
        const price = parseFloat(a[0]);
        const qty = parseFloat(a[1]);
        const notional = price * qty;
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

      depthRef.current = {
        bids, asks, bestBid, bestAsk, mid, spreadBps, bidNotional, askNotional, whaleZones,
      };

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

      // Hard cap on buffer size
      if (trade.recentTrades.length > MAX_RECENT_TRADES) {
        const cutoff = Date.now() - 60_000;
        trade.recentTrades = trade.recentTrades.filter(tr => tr.ts > cutoff);
      }

      // Recompute volumes
      let buyVol = 0;
      let sellVol = 0;
      for (const tr of trade.recentTrades) {
        if (tr.isBuyer) buyVol += tr.qty;
        else sellVol += tr.qty;
      }
      trade.buyVol = buyVol;
      trade.sellVol = sellVol;
    };
    tradeWsRef.current = tradeWs;

    return () => {
      depthWs.close();
      tradeWs.close();
    };
  }, [selectedSymbol]);

  // V2.1: Throttled signal computation - 500ms instead of 100ms
  useEffect(() => {
    const interval = setInterval(() => {
      const currentDepth = depthRef.current;
      if (!currentDepth) return;
      const trade = tradeDataRef.current;

      const cutoff = Date.now() - 60_000;
      trade.recentTrades = trade.recentTrades.filter(tr => tr.ts > cutoff);

      const flags: string[] = [];
      if (currentDepth.whaleZones.some(w => w.side === 'bid')) flags.push('WHALE_BID');
      if (currentDepth.whaleZones.some(w => w.side === 'ask')) flags.push('WHALE_ASK');
      if (detectSweep(trade.priceHistory)) flags.push('SWEEP');

      const newSignal = computeUnifiedSignal(currentDepth, trade, flags);

      setDepth(currentDepth);
      setSignal(newSignal);

      const now = Date.now();
      if (newSignal.direction !== 'NEUTRAL' &&
          newSignal.confidence >= SIGNAL_LOG_MIN_CONFIDENCE &&
          newSignal.risk) {
        const last = lastSignalRef.current;
        const cooldownElapsed = !last || last.symbol !== selectedSymbol || (now - last.ts) > SIGNAL_COOLDOWN_MS;

        if (cooldownElapsed) {
          lastSignalRef.current = { symbol: selectedSymbol, direction: newSignal.direction, ts: now };
          const newLog: SignalLog = {
            id: signalIdRef.current++,
            symbol: selectedSymbol,
            direction: newSignal.direction,
            confidence: newSignal.confidence,
            entryPrice: currentDepth.mid,
            stopLoss: newSignal.risk.stopLoss,
            takeProfit: newSignal.risk.takeProfit,
            rr: newSignal.risk.rr,
            timestamp: now,
            outcome: 'pending',
          };
          setSignalLog(prev => [newLog, ...prev].slice(0, 30));
        }
      }
    }, SIGNAL_RECOMPUTE_MS);

    return () => clearInterval(interval);
  }, [selectedSymbol]);

  // W/L Resolution
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      setSignalLog(prev => prev.map(log => {
        if (log.outcome !== 'pending') return log;
        if (now - log.timestamp < 5 * 60 * 1000) return log;
        const currentPrice = coinData[log.symbol]?.price;
        if (!currentPrice) return log;
        const pnlPct = ((currentPrice - log.entryPrice) / log.entryPrice) * 100;
        const directionMultiplier = log.direction === 'LONG' ? 1 : -1;
        const adjustedPnl = pnlPct * directionMultiplier;
        return {
          ...log,
          resolvedPrice: currentPrice,
          pnlPct: parseFloat(adjustedPnl.toFixed(3)),
          outcome: adjustedPnl > 0 ? 'win' : 'loss',
        };
      }));
    }, 10_000);
    return () => clearInterval(interval);
  }, [coinData]);

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

  const maxQty = useMemo(() =>
    depth ? Math.max(...depth.bids.map(b => b.qty), ...depth.asks.map(a => a.qty)) : 1,
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
    const resolved = signalLog.filter(s => s.outcome === 'win' || s.outcome === 'loss');
    const w = resolved.filter(s => s.outcome === 'win').length;
    const l = resolved.filter(s => s.outcome === 'loss').length;
    return {
      resolvedSignals: resolved,
      wins: w,
      losses: l,
      winRate: resolved.length > 0 ? (w / resolved.length) * 100 : 0,
      avgPnl: resolved.length > 0 ? resolved.reduce((s, x) => s + (x.pnlPct || 0), 0) / resolved.length : 0,
    };
  }, [signalLog]);

  const signalColor = {
    LONG: 'text-green-400',
    SHORT: 'text-pink-400',
    NEUTRAL: 'text-yellow-400',
  }[signal.direction];

  const signalGlow = {
    LONG: 'shadow-[0_0_30px_rgba(74,222,128,0.5)]',
    SHORT: 'shadow-[0_0_30px_rgba(244,114,182,0.5)]',
    NEUTRAL: 'shadow-[0_0_30px_rgba(250,204,21,0.5)]',
  }[signal.direction];

  const totalNotional = depth ? depth.bidNotional + depth.askNotional : 0;
  const bidPct = depth && totalNotional > 0 ? (depth.bidNotional / totalNotional) * 100 : 50;
  const askPct = 100 - bidPct;
  const pressureLabel = bidPct > 65 ? 'BULLISH PRESSURE' : bidPct < 35 ? 'BEARISH PRESSURE' : 'NEUTRAL';
  const pressureColor = bidPct > 65 ? 'text-green-400' : bidPct < 35 ? 'text-pink-400' : 'text-yellow-400';

  const hotSignals = signalLog.filter(s => s.outcome === 'pending').slice(0, 3);

  return (
    <main className="min-h-screen bg-black text-white p-6 font-mono">
      <header className="flex justify-between items-center mb-6 pb-4 border-b border-cyan-500/30">
        <h1 className="text-3xl font-bold tracking-widest">
          <span className="bg-gradient-to-r from-cyan-400 to-pink-500 bg-clip-text text-transparent">
            RAUF // SIGNALS
          </span>
        </h1>
        <div className="text-cyan-400 text-sm">
          <span className="inline-block w-2 h-2 bg-green-400 rounded-full mr-2 animate-pulse"></span>
          LIVE · {time}
        </div>
      </header>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3 mb-6">
        {COINS.map(coin => {
          const data = coinData[coin.symbol];
          const isUp = data && data.change >= 0;
          const isSelected = coin.symbol === selectedSymbol;
          return (
            <div
              key={coin.symbol}
              onClick={() => setSelectedSymbol(coin.symbol)}
              className={`p-3 rounded border bg-gray-900/50 backdrop-blur cursor-pointer transition-all hover:scale-105 ${
                isSelected
                  ? 'border-cyan-400 shadow-[0_0_20px_rgba(34,211,238,0.4)]'
                  : isUp ? 'border-green-500/30' : 'border-pink-500/30'
              }`}
            >
              <div className="flex justify-between items-center mb-2">
                <span className="text-sm font-bold tracking-wider">{coin.display}</span>
                {data && (
                  <span className={`text-xs px-2 py-0.5 rounded ${
                    isUp ? 'bg-green-500/20 text-green-400' : 'bg-pink-500/20 text-pink-400'
                  }`}>
                    {isUp ? '+' : ''}{data.change.toFixed(2)}%
                  </span>
                )}
              </div>
              <div className={`text-lg font-bold mb-1 ${isUp ? 'text-green-400' : 'text-pink-400'}`}>
                {data ? '$' + formatPrice(data.price) : '...'}
              </div>
              <div className="text-[10px] text-gray-500">
                VOL: {data ? '$' + formatVol(data.volume) : '—'}
              </div>
            </div>
          );
        })}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        <div className="border border-gray-800 rounded p-4 bg-gray-900/30">
          <div className="flex justify-between items-center mb-4 pb-2 border-b border-gray-800">
            <h2 className="text-sm font-bold tracking-widest text-gray-400">
              DEPTH PRESSURE MAP · {selectedSymbol}
            </h2>
            <span className="text-xs text-cyan-400">TOP 20</span>
          </div>

          {depth ? (
            <>
              <div className="flex justify-around mb-4 pb-3 border-b border-gray-800">
                <div className="text-center">
                  <div className="text-xs text-gray-500 mb-1">BEST BID</div>
                  <div className="text-green-400 font-bold">{formatPrice(depth.bestBid)}</div>
                </div>
                <div className="text-center">
                  <div className="text-xs text-gray-500 mb-1">MID</div>
                  <div className="text-yellow-400 font-bold">{formatPrice(depth.mid)}</div>
                </div>
                <div className="text-center">
                  <div className="text-xs text-gray-500 mb-1">BEST ASK</div>
                  <div className="text-pink-400 font-bold">{formatPrice(depth.bestAsk)}</div>
                </div>
              </div>

              <div className="space-y-1 max-h-96 overflow-y-auto">
                {Array.from({ length: TOP_OB_LEVELS }).map((_, i) => {
                  const bid = depth.bids[i];
                  const ask = depth.asks[i];
                  const bidWidth = bid ? (bid.qty / maxQty) * 100 : 0;
                  const askWidth = ask ? (ask.qty / maxQty) * 100 : 0;
                  return (
                    <div key={i} className="grid grid-cols-4 gap-2 items-center text-xs">
                      <div className="h-5 bg-gray-900 rounded relative">
                        {bid && (
                          <div
                            className={`absolute right-0 h-full ${
                              bid.isWhale
                                ? 'bg-gradient-to-l from-yellow-400/60 to-transparent border-r-2 border-yellow-400'
                                : 'bg-gradient-to-l from-green-500/40 to-transparent border-r-2 border-green-400'
                            } rounded text-right pr-2 ${bid.isWhale ? 'text-yellow-300' : 'text-green-400'} leading-5`}
                            style={{ width: `${bidWidth}%` }}
                          >
                            {bid.qty.toFixed(3)}{bid.isWhale && ' 🐋'}
                          </div>
                        )}
                      </div>
                      <div className="text-green-400 text-center text-[10px]">
                        {bid ? formatPrice(bid.price) : ''}
                      </div>
                      <div className="text-pink-400 text-center text-[10px]">
                        {ask ? formatPrice(ask.price) : ''}
                      </div>
                      <div className="h-5 bg-gray-900 rounded relative">
                        {ask && (
                          <div
                            className={`absolute left-0 h-full ${
                              ask.isWhale
                                ? 'bg-gradient-to-r from-yellow-400/60 to-transparent border-l-2 border-yellow-400'
                                : 'bg-gradient-to-r from-pink-500/40 to-transparent border-l-2 border-pink-400'
                            } rounded pl-2 ${ask.isWhale ? 'text-yellow-300' : 'text-pink-400'} leading-5`}
                            style={{ width: `${askWidth}%` }}
                          >
                            {ask.isWhale && '🐋 '}{ask.qty.toFixed(3)}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="grid grid-cols-3 gap-2 mt-4 pt-3 border-t border-gray-800 text-xs">
                <div className="text-center">
                  <div className="text-gray-500 mb-1">BID NOTIONAL</div>
                  <div className="text-green-400 font-bold">${formatVol(depth.bidNotional)}</div>
                </div>
                <div className="text-center">
                  <div className="text-gray-500 mb-1">SPREAD</div>
                  <div className="text-cyan-400 font-bold">{depth.spreadBps.toFixed(2)} bps</div>
                </div>
                <div className="text-center">
                  <div className="text-gray-500 mb-1">ASK NOTIONAL</div>
                  <div className="text-pink-400 font-bold">${formatVol(depth.askNotional)}</div>
                </div>
              </div>
            </>
          ) : (
            <div className="text-center text-gray-500 py-8">Loading depth...</div>
          )}
        </div>

        <div className="border border-gray-800 rounded p-4 bg-gray-900/30">
          <div className="flex justify-between items-center mb-4 pb-2 border-b border-gray-800">
            <h2 className="text-sm font-bold tracking-widest text-gray-400">
              REACTOR CORE V2 · {selectedSymbol}
            </h2>
            <span className="text-xs text-yellow-400">SIGNAL ONLY · NO EXEC</span>
          </div>

          <div className="flex flex-col items-center justify-center py-4">
            <div className={`w-44 h-44 rounded-full border-4 flex flex-col items-center justify-center ${signalGlow} ${
              signal.direction === 'LONG' ? 'border-green-400' :
              signal.direction === 'SHORT' ? 'border-pink-400' : 'border-yellow-400'
            }`}>
              <div className={`text-3xl font-bold tracking-widest ${signalColor}`}>
                {signal.direction}
              </div>
              <div className="text-xs text-gray-500 mt-2 tracking-wider">CONFIDENCE</div>
              <div className="text-2xl font-bold text-white">{signal.confidence}%</div>
              <div className="text-[10px] text-gray-500 mt-1">{signal.agreement}/3 AGREE</div>
            </div>

            <div className="mt-4 text-center text-cyan-400 text-xs tracking-wider">
              ▸ {signal.rationale}
            </div>

            {signal.flags.length > 0 && (
              <div className="mt-2 flex gap-1 flex-wrap justify-center">
                {signal.flags.map(f => (
                  <span key={f} className="text-[9px] px-2 py-0.5 rounded border border-yellow-500/40 bg-yellow-500/10 text-yellow-300">
                    {f}
                  </span>
                ))}
              </div>
            )}

            <div className="grid grid-cols-5 gap-2 mt-4 w-full text-[10px]">
              {(['obi', 'pressure', 'delta', 'spread', 'vol'] as const).map(key => {
                const val = signal.factors[key];
                const isDirectional = key === 'obi' || key === 'pressure' || key === 'delta';
                const absVal = Math.abs(val);
                const color = isDirectional
                  ? val > 0 ? 'bg-green-400' : val < 0 ? 'bg-pink-400' : 'bg-gray-600'
                  : val > 60 ? 'bg-cyan-400' : 'bg-gray-600';
                const weight = (FACTOR_WEIGHTS as Record<string, number>)[key];
                return (
                  <div key={key} className="text-center">
                    <div className="text-gray-500 uppercase mb-1">{key}</div>
                    <div className="h-12 bg-gray-900 rounded relative flex items-end overflow-hidden">
                      <div
                        className={`w-full ${color} transition-all`}
                        style={{ height: `${Math.min(100, absVal)}%` }}
                      ></div>
                    </div>
                    <div className={`mt-1 font-bold ${
                      isDirectional ? (val > 0 ? 'text-green-400' : val < 0 ? 'text-pink-400' : 'text-gray-500') : 'text-cyan-400'
                    }`}>
                      {isDirectional ? (val > 0 ? '+' : '') + val.toFixed(0) : val.toFixed(0)}
                    </div>
                    <div className="text-gray-600 text-[9px]">{(weight * 100).toFixed(0)}%</div>
                  </div>
                );
              })}
            </div>

            {signal.risk ? (
              <div className="grid grid-cols-4 gap-2 mt-4 w-full text-xs">
                <div className="text-center p-2 border border-gray-800 rounded">
                  <div className="text-gray-500 text-[9px] mb-1">ENTRY</div>
                  <div className="text-white font-bold">{depth ? formatPrice(depth.mid) : '—'}</div>
                </div>
                <div className="text-center p-2 border border-pink-500/30 rounded">
                  <div className="text-gray-500 text-[9px] mb-1">SL</div>
                  <div className="text-pink-400 font-bold">{formatPrice(signal.risk.stopLoss)}</div>
                  <div className="text-pink-400/60 text-[9px]">{signal.risk.riskPct.toFixed(2)}%</div>
                </div>
                <div className="text-center p-2 border border-green-500/30 rounded">
                  <div className="text-gray-500 text-[9px] mb-1">TP</div>
                  <div className="text-green-400 font-bold">{formatPrice(signal.risk.takeProfit)}</div>
                  <div className="text-green-400/60 text-[9px]">{signal.risk.rewardPct.toFixed(2)}%</div>
                </div>
                <div className="text-center p-2 border border-cyan-500/30 rounded">
                  <div className="text-gray-500 text-[9px] mb-1">RR</div>
                  <div className="text-cyan-400 font-bold">{signal.risk.rr.toFixed(2)}</div>
                  <div className="text-cyan-400/60 text-[9px]">RATIO</div>
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-3 gap-2 mt-4 w-full text-xs">
                <div className="text-center p-3 border border-gray-800 rounded">
                  <div className="text-gray-500 mb-1">ENTRY</div>
                  <div className="text-white font-bold">{depth ? formatPrice(depth.mid) : '—'}</div>
                </div>
                <div className="text-center p-3 border border-gray-800 rounded">
                  <div className="text-gray-500 mb-1">SCORE</div>
                  <div className={signalColor + ' font-bold'}>{signal.finalScore}</div>
                </div>
                <div className="text-center p-3 border border-gray-800 rounded">
                  <div className="text-gray-500 mb-1">SPREAD</div>
                  <div className="text-cyan-400 font-bold">{depth ? depth.spreadBps.toFixed(2) : '—'}</div>
                </div>
              </div>
            )}

            <div className="mt-4 text-[10px] text-yellow-400/70 text-center tracking-wider border border-yellow-400/30 rounded p-2 w-full">
              ⚠ PERSONAL USE · NOT FINANCIAL ADVICE · BACKTEST PENDING
            </div>
          </div>
        </div>
      </div>

      <div className="border border-gray-800 rounded p-4 bg-gray-900/30 mb-6">
        <div className="flex justify-between items-center mb-3">
          <h3 className="text-xs font-bold tracking-widest text-gray-400">
            BUY/SELL PRESSURE · {selectedSymbol}
          </h3>
          <span className={`text-xs font-bold tracking-wider ${pressureColor}`}>
            {pressureLabel}
          </span>
        </div>
        <div className="relative h-12 bg-gray-900 rounded overflow-hidden flex">
          <div
            className="bg-gradient-to-r from-green-500 to-green-400 flex items-center justify-end pr-3 transition-all duration-300"
            style={{ width: `${bidPct}%` }}
          >
            {bidPct > 15 && (
              <span className="text-xs font-bold text-black">BIDS {bidPct.toFixed(0)}%</span>
            )}
          </div>
          <div
            className="bg-gradient-to-l from-pink-500 to-pink-400 flex items-center justify-start pl-3 transition-all duration-300"
            style={{ width: `${askPct}%` }}
          >
            {askPct > 15 && (
              <span className="text-xs font-bold text-black">ASKS {askPct.toFixed(0)}%</span>
            )}
          </div>
        </div>
        <div className="flex justify-between mt-2 text-[10px] text-gray-500">
          <span>BID: ${depth ? formatVol(depth.bidNotional) : '—'}</span>
          <span>ASK: ${depth ? formatVol(depth.askNotional) : '—'}</span>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <div className="border border-green-500/30 rounded p-4 bg-gray-900/30">
          <h3 className="text-xs font-bold tracking-widest text-green-400 mb-3">
            🚀 TOP GAINERS
          </h3>
          <div className="space-y-2">
            {topGainers.map(c => (
              <div
                key={c.symbol}
                onClick={() => setSelectedSymbol(c.symbol)}
                className="flex justify-between items-center p-2 rounded hover:bg-green-500/10 cursor-pointer transition"
              >
                <span className="font-bold text-sm">{c.display}</span>
                <span className="text-green-400 text-xs font-bold">
                  +{c.data!.change.toFixed(2)}%
                </span>
              </div>
            ))}
            {topGainers.length === 0 && <div className="text-gray-500 text-xs text-center py-2">Loading...</div>}
          </div>
        </div>

        <div className="border border-pink-500/30 rounded p-4 bg-gray-900/30">
          <h3 className="text-xs font-bold tracking-widest text-pink-400 mb-3">
            📉 TOP LOSERS
          </h3>
          <div className="space-y-2">
            {topLosers.map(c => (
              <div
                key={c.symbol}
                onClick={() => setSelectedSymbol(c.symbol)}
                className="flex justify-between items-center p-2 rounded hover:bg-pink-500/10 cursor-pointer transition"
              >
                <span className="font-bold text-sm">{c.display}</span>
                <span className="text-pink-400 text-xs font-bold">
                  {c.data!.change.toFixed(2)}%
                </span>
              </div>
            ))}
            {topLosers.length === 0 && <div className="text-gray-500 text-xs text-center py-2">Loading...</div>}
          </div>
        </div>

        <div className="border border-cyan-500/30 rounded p-4 bg-gray-900/30">
          <h3 className="text-xs font-bold tracking-widest text-cyan-400 mb-3">
            ⚡ HOT SIGNALS
          </h3>
          <div className="space-y-2">
            {hotSignals.length > 0 ? hotSignals.map(s => (
              <div key={s.id} className="flex justify-between items-center p-2 rounded bg-gray-900/50">
                <span className="font-bold text-sm">{s.symbol.replace('USDT', '')}</span>
                <div className="flex items-center gap-2">
                  <span className={`text-xs font-bold ${
                    s.direction === 'LONG' ? 'text-green-400' : 'text-pink-400'
                  }`}>
                    {s.direction}
                  </span>
                  <span className="text-cyan-400 text-xs">{s.confidence}%</span>
                  <span className="text-gray-500 text-[10px]">RR {s.rr.toFixed(1)}</span>
                </div>
              </div>
            )) : (
              <div className="text-gray-500 text-xs text-center py-2">No active signals</div>
            )}
          </div>
        </div>
      </div>

      <div className="border border-gray-800 rounded p-4 bg-gray-900/30 mb-6">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-4 pb-2 border-b border-gray-800 gap-2">
          <h2 className="text-sm font-bold tracking-widest text-gray-400">
            📊 SIGNAL HISTORY · LIVE TRACKING
          </h2>
          <div className="flex gap-4 text-xs flex-wrap">
            <div>
              <span className="text-gray-500">TOTAL: </span>
              <span className="text-white font-bold">{signalLog.length}</span>
            </div>
            <div>
              <span className="text-gray-500">W/L: </span>
              <span className="text-green-400 font-bold">{wins}</span>
              <span className="text-gray-500">/</span>
              <span className="text-pink-400 font-bold">{losses}</span>
            </div>
            <div>
              <span className="text-gray-500">WIN RATE: </span>
              <span className={`font-bold ${winRate >= 50 ? 'text-green-400' : 'text-pink-400'}`}>
                {resolvedSignals.length > 0 ? winRate.toFixed(1) + '%' : '—'}
              </span>
            </div>
            <div>
              <span className="text-gray-500">AVG PnL: </span>
              <span className={`font-bold ${avgPnl >= 0 ? 'text-green-400' : 'text-pink-400'}`}>
                {resolvedSignals.length > 0 ? (avgPnl >= 0 ? '+' : '') + avgPnl.toFixed(3) + '%' : '—'}
              </span>
            </div>
          </div>
        </div>

        {signalLog.length > 0 ? (
          <div className="space-y-1 text-xs max-h-80 overflow-y-auto">
            <div className="grid grid-cols-7 gap-2 text-[10px] text-gray-500 border-b border-gray-800 pb-1 px-2">
              <span>TIME</span>
              <span>COIN</span>
              <span>SIGNAL</span>
              <span>CONF</span>
              <span>ENTRY</span>
              <span>RR</span>
              <span className="text-right">OUTCOME</span>
            </div>
            {signalLog.map(s => {
              const timeStr = new Date(s.timestamp).toLocaleTimeString().slice(0, 8);
              const isWin = s.outcome === 'win';
              const isLoss = s.outcome === 'loss';
              const isPending = s.outcome === 'pending';
              return (
                <div
                  key={s.id}
                  className={`grid grid-cols-7 gap-2 px-2 py-1 rounded items-center ${
                    isWin ? 'bg-green-500/10' :
                    isLoss ? 'bg-pink-500/10' :
                    'bg-gray-900/50'
                  }`}
                >
                  <span className="text-gray-400">{timeStr}</span>
                  <span className="font-bold">{s.symbol.replace('USDT', '')}</span>
                  <span className={`font-bold ${
                    s.direction === 'LONG' ? 'text-green-400' : 'text-pink-400'
                  }`}>
                    {s.direction}
                  </span>
                  <span className="text-cyan-400">{s.confidence}%</span>
                  <span className="text-gray-300">{formatPrice(s.entryPrice)}</span>
                  <span className="text-yellow-400">{s.rr.toFixed(1)}</span>
                  <span className="text-right">
                    {isPending ? (
                      <span className="text-yellow-400 text-[10px]">PENDING</span>
                    ) : (
                      <span className={`font-bold ${isWin ? 'text-green-400' : 'text-pink-400'}`}>
                        {isWin ? '✓ ' : '✗ '}
                        {(s.pnlPct! >= 0 ? '+' : '') + s.pnlPct!.toFixed(3) + '%'}
                      </span>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="text-center text-gray-500 py-8 text-xs">
            Waiting for high-conviction signals... (70%+ conf, RR ≥ 1.5, 5min cooldown)
          </div>
        )}
      </div>

      <footer className="mt-8 text-center text-xs text-gray-600 tracking-widest">
        RAUF SIGNALS · BUILT BY ABDUL RAUF · KARACHI · v2.1 OPTIMIZED
      </footer>
    </main>
  );
}
