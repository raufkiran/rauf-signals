'use client';

import { useEffect, useState, useRef } from 'react';

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

interface CoinData { price: number; change: number; volume: number; }
interface DepthLevel { price: number; qty: number; }
interface DepthData {
  bids: DepthLevel[]; asks: DepthLevel[];
  bestBid: number; bestAsk: number; mid: number;
  spread: number; bidNotional: number; askNotional: number;
}
interface Signal { direction: 'LONG' | 'SHORT' | 'NEUTRAL'; confidence: number; obi: number; rationale: string; }
interface SignalLog {
  id: number;
  symbol: string;
  direction: 'LONG' | 'SHORT' | 'NEUTRAL';
  confidence: number;
  entryPrice: number;
  timestamp: number;
  resolvedPrice?: number;
  pnlPct?: number;
  outcome?: 'win' | 'loss' | 'pending';
}

export default function Home() {
  const [coinData, setCoinData] = useState<Record<string, CoinData>>({});
  const [selectedSymbol, setSelectedSymbol] = useState('BTCUSDT');
  const [depth, setDepth] = useState<DepthData | null>(null);
  const [signal, setSignal] = useState<Signal>({
    direction: 'NEUTRAL', confidence: 50, obi: 0, rationale: 'Initializing...'
  });
  const [time, setTime] = useState('');
  const [signalLog, setSignalLog] = useState<SignalLog[]>([]);
  const depthWsRef = useRef<WebSocket | null>(null);
  const signalIdRef = useRef(0);
  const lastSignalRef = useRef<{ symbol: string; direction: string; ts: number } | null>(null);

  // Ticker stream
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

    return () => {
      ws.close();
      clearInterval(timer);
    };
  }, []);

  // Depth stream + Signal logging
  useEffect(() => {
    if (depthWsRef.current) depthWsRef.current.close();

    const ws = new WebSocket(
      `wss://stream.binance.com:9443/ws/${selectedSymbol.toLowerCase()}@depth20@100ms`
    );

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      const bids: DepthLevel[] = data.bids.slice(0, 10).map((b: string[]) => ({
        price: parseFloat(b[0]), qty: parseFloat(b[1]),
      }));
      const asks: DepthLevel[] = data.asks.slice(0, 10).map((a: string[]) => ({
        price: parseFloat(a[0]), qty: parseFloat(a[1]),
      }));
      if (bids.length === 0 || asks.length === 0) return;

      const bestBid = bids[0].price;
      const bestAsk = asks[0].price;
      const mid = (bestBid + bestAsk) / 2;
      const spread = ((bestAsk - bestBid) / mid) * 10000;
      const bidNotional = bids.reduce((s, b) => s + b.price * b.qty, 0);
      const askNotional = asks.reduce((s, a) => s + a.price * a.qty, 0);
      setDepth({ bids, asks, bestBid, bestAsk, mid, spread, bidNotional, askNotional });

      const bidVol5 = bids.slice(0, 5).reduce((s, b) => s + b.qty, 0);
      const askVol5 = asks.slice(0, 5).reduce((s, a) => s + a.qty, 0);
      const obi = ((bidVol5 - askVol5) / (bidVol5 + askVol5)) * 100;
      const notionalRatio = bidNotional / (bidNotional + askNotional);

      let direction: Signal['direction'] = 'NEUTRAL';
      let confidence = 50;
      let rationale = 'BALANCED ORDER BOOK';

      if (obi > 25 && notionalRatio > 0.6) {
        direction = 'LONG';
        confidence = Math.min(85, 50 + Math.abs(obi));
        rationale = `BID PRESSURE · OBI +${obi.toFixed(1)}%`;
      } else if (obi < -25 && notionalRatio < 0.4) {
        direction = 'SHORT';
        confidence = Math.min(85, 50 + Math.abs(obi));
        rationale = `ASK PRESSURE · OBI ${obi.toFixed(1)}%`;
      } else {
        confidence = Math.min(60, 50 + Math.abs(obi) / 2);
        rationale = `LOW SPREAD · OBI ${obi.toFixed(1)}%`;
      }

      const finalSignal: Signal = { direction, confidence: Math.round(confidence), obi: parseFloat(obi.toFixed(1)), rationale };
      setSignal(finalSignal);

      // Log signal change (only LONG/SHORT, not NEUTRAL, not duplicates within 30s)
      const now = Date.now();
      if (direction !== 'NEUTRAL' && confidence >= 65) {
        const last = lastSignalRef.current;
        const isNew = !last || last.symbol !== selectedSymbol || last.direction !== direction || (now - last.ts) > 30000;
        if (isNew) {
          lastSignalRef.current = { symbol: selectedSymbol, direction, ts: now };
          const newLog: SignalLog = {
            id: signalIdRef.current++,
            symbol: selectedSymbol,
            direction,
            confidence: Math.round(confidence),
            entryPrice: mid,
            timestamp: now,
            outcome: 'pending',
          };
          setSignalLog(prev => [newLog, ...prev].slice(0, 20));
        }
      }
    };

    depthWsRef.current = ws;
    return () => { ws.close(); };
  }, [selectedSymbol]);

  // Resolve pending signals (5 min after entry)
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      setSignalLog(prev => prev.map(log => {
        if (log.outcome !== 'pending') return log;
        if (now - log.timestamp < 5 * 60 * 1000) return log; // 5 min not passed
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
    }, 5000);
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

  const maxQty = depth ? Math.max(...depth.bids.map(b => b.qty), ...depth.asks.map(a => a.qty)) : 1;

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

  // Pressure Bar calculation
  const totalNotional = depth ? depth.bidNotional + depth.askNotional : 0;
  const bidPct = depth && totalNotional > 0 ? (depth.bidNotional / totalNotional) * 100 : 50;
  const askPct = 100 - bidPct;
  const pressureLabel = bidPct > 65 ? 'BULLISH PRESSURE' : bidPct < 35 ? 'BEARISH PRESSURE' : 'NEUTRAL';
  const pressureColor = bidPct > 65 ? 'text-green-400' : bidPct < 35 ? 'text-pink-400' : 'text-yellow-400';

  // Top Movers
  const sortedCoins = COINS
    .map(c => ({ ...c, data: coinData[c.symbol] }))
    .filter(c => c.data);
  const topGainers = [...sortedCoins].sort((a, b) => b.data!.change - a.data!.change).slice(0, 3);
  const topLosers = [...sortedCoins].sort((a, b) => a.data!.change - b.data!.change).slice(0, 3);
  const hotSignals = signalLog.filter(s => s.outcome === 'pending').slice(0, 3);

  // Signal stats
  const resolvedSignals = signalLog.filter(s => s.outcome === 'win' || s.outcome === 'loss');
  const wins = resolvedSignals.filter(s => s.outcome === 'win').length;
  const losses = resolvedSignals.filter(s => s.outcome === 'loss').length;
  const winRate = resolvedSignals.length > 0 ? (wins / resolvedSignals.length) * 100 : 0;
  const avgPnl = resolvedSignals.length > 0
    ? resolvedSignals.reduce((s, x) => s + (x.pnlPct || 0), 0) / resolvedSignals.length
    : 0;

  return (
    <main className="min-h-screen bg-black text-white p-6 font-mono">
      {/* Header */}
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

      {/* Coin Grid */}
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

      {/* Depth + Reactor (V2 untouched) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        {/* Depth Pressure Map */}
        <div className="border border-gray-800 rounded p-4 bg-gray-900/30">
          <div className="flex justify-between items-center mb-4 pb-2 border-b border-gray-800">
            <h2 className="text-sm font-bold tracking-widest text-gray-400">
              DEPTH PRESSURE MAP · {selectedSymbol}
            </h2>
            <span className="text-xs text-cyan-400">TOP 10</span>
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

              <div className="space-y-1">
                {Array.from({ length: 10 }).map((_, i) => {
                  const bid = depth.bids[i];
                  const ask = depth.asks[i];
                  const bidWidth = bid ? (bid.qty / maxQty) * 100 : 0;
                  const askWidth = ask ? (ask.qty / maxQty) * 100 : 0;
                  return (
                    <div key={i} className="grid grid-cols-4 gap-2 items-center text-xs">
                      <div className="h-5 bg-gray-900 rounded relative">
                        {bid && (
                          <div
                            className="absolute right-0 h-full bg-gradient-to-l from-green-500/40 to-transparent border-r-2 border-green-400 rounded text-right pr-2 text-green-400 leading-5"
                            style={{ width: `${bidWidth}%` }}
                          >
                            {bid.qty.toFixed(3)}
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
                            className="absolute left-0 h-full bg-gradient-to-r from-pink-500/40 to-transparent border-l-2 border-pink-400 rounded pl-2 text-pink-400 leading-5"
                            style={{ width: `${askWidth}%` }}
                          >
                            {ask.qty.toFixed(3)}
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
                  <div className="text-cyan-400 font-bold">{depth.spread.toFixed(2)} bps</div>
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

        {/* Reactor Core */}
        <div className="border border-gray-800 rounded p-4 bg-gray-900/30">
          <div className="flex justify-between items-center mb-4 pb-2 border-b border-gray-800">
            <h2 className="text-sm font-bold tracking-widest text-gray-400">
              REACTOR CORE · {selectedSymbol}
            </h2>
            <span className="text-xs text-yellow-400">SIGNAL ONLY · NO EXEC</span>
          </div>

          <div className="flex flex-col items-center justify-center py-8">
            <div className={`w-48 h-48 rounded-full border-4 flex flex-col items-center justify-center ${signalGlow} ${
              signal.direction === 'LONG' ? 'border-green-400' :
              signal.direction === 'SHORT' ? 'border-pink-400' : 'border-yellow-400'
            }`}>
              <div className={`text-3xl font-bold tracking-widest ${signalColor}`}>
                {signal.direction}
              </div>
              <div className="text-xs text-gray-500 mt-2 tracking-wider">CONFIDENCE</div>
              <div className="text-2xl font-bold text-white">{signal.confidence}%</div>
            </div>

            <div className="mt-6 text-center text-cyan-400 text-xs tracking-wider">
              ▸ {signal.rationale}
            </div>

            <div className="grid grid-cols-3 gap-4 mt-6 w-full text-xs">
              <div className="text-center p-3 border border-gray-800 rounded">
                <div className="text-gray-500 mb-1">ENTRY</div>
                <div className="text-white font-bold">
                  {depth ? formatPrice(depth.mid) : '—'}
                </div>
              </div>
              <div className="text-center p-3 border border-gray-800 rounded">
                <div className="text-gray-500 mb-1">OBI %</div>
                <div className={signalColor + ' font-bold'}>{signal.obi}%</div>
              </div>
              <div className="text-center p-3 border border-gray-800 rounded">
                <div className="text-gray-500 mb-1">SPREAD</div>
                <div className="text-cyan-400 font-bold">
                  {depth ? depth.spread.toFixed(2) : '—'}
                </div>
              </div>
            </div>

            <div className="mt-6 text-[10px] text-yellow-400/70 text-center tracking-wider border border-yellow-400/30 rounded p-2 w-full">
              ⚠ PERSONAL USE · NOT FINANCIAL ADVICE · BACKTEST PENDING
            </div>
          </div>
        </div>
      </div>

      {/* === NEW: Pressure Bar === */}
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

      {/* === NEW: Top Movers === */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        {/* Top Gainers */}
        <div className="border border-green-500/30 rounded p-4 bg-gray-900/30">
          <h3 className="text-xs font-bold tracking-widest text-green-400 mb-3 flex items-center gap-2">
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

        {/* Top Losers */}
        <div className="border border-pink-500/30 rounded p-4 bg-gray-900/30">
          <h3 className="text-xs font-bold tracking-widest text-pink-400 mb-3 flex items-center gap-2">
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

        {/* Hot Signals */}
        <div className="border border-cyan-500/30 rounded p-4 bg-gray-900/30">
          <h3 className="text-xs font-bold tracking-widest text-cyan-400 mb-3 flex items-center gap-2">
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
                </div>
              </div>
            )) : (
              <div className="text-gray-500 text-xs text-center py-2">Waiting for signals...</div>
            )}
          </div>
        </div>
      </div>

      {/* === NEW: Signal History === */}
      <div className="border border-gray-800 rounded p-4 bg-gray-900/30 mb-6">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-4 pb-2 border-b border-gray-800 gap-2">
          <h2 className="text-sm font-bold tracking-widest text-gray-400">
            📊 SIGNAL HISTORY · LIVE TRACKING
          </h2>
          <div className="flex gap-4 text-xs">
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
            <div className="grid grid-cols-6 gap-2 text-[10px] text-gray-500 border-b border-gray-800 pb-1 px-2">
              <span>TIME</span>
              <span>COIN</span>
              <span>SIGNAL</span>
              <span>CONF</span>
              <span>ENTRY</span>
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
                  className={`grid grid-cols-6 gap-2 px-2 py-1 rounded items-center ${
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
                  <span className="text-right">
                    {isPending ? (
                      <span className="text-yellow-400 text-[10px]">PENDING</span>
                    ) : (
                      <span className={`font-bold ${isWin ? 'text-green-400' : 'text-pink-400'}`}>
                        {isWin ? '✓ ' : '✗ '}
                        {(s.pnlPct! >= 0 ? '+' : '') + s.pnlPct!.toFixed(3)}%
                      </span>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="text-center text-gray-500 py-8 text-xs">
            Waiting for signals... (LONG/SHORT signals with 65%+ confidence will be tracked here)
          </div>
        )}
      </div>

      <footer className="mt-8 text-center text-xs text-gray-600 tracking-widest">
        RAUF SIGNALS · BUILT BY ABDUL RAUF · KARACHI
      </footer>
    </main>
  );
}