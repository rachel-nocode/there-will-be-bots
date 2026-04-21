import { useState } from 'react'
import { useGameStore } from '../store'
import type { PredictionMarket, UserPrediction } from '../types/game'
import {
  DEFAULT_WAGER,
  MIN_WAGER,
  STARTING_BANKROLL,
} from '../types/game'

function formatCloseTime(ms: number): string {
  const diff = ms - Date.now()
  if (diff <= 0) return 'closed'
  const hours = Math.floor(diff / (60 * 60 * 1000))
  const mins = Math.floor((diff % (60 * 60 * 1000)) / (60 * 1000))
  const days = Math.floor(hours / 24)
  if (days >= 1) return `${days}d ${hours % 24}h`
  if (hours > 0) return `${hours}h ${mins}m`
  return `${mins}m`
}

function formatCash(n: number): string {
  return `$${Math.round(n).toLocaleString('en-US')}`
}

// Parimutuel odds: each option's probability is its share of the total pool.
// Falls back to equal weights while the pool is empty.
function computePoolOdds(market: PredictionMarket): Map<string, number> {
  const odds = new Map<string, number>()
  const total = market.pool.totalStake
  if (total <= 0) {
    const even = 1 / Math.max(1, market.options.length)
    for (const o of market.options) odds.set(o.id, even)
    return odds
  }
  for (const o of market.options) {
    odds.set(o.id, (market.pool.stakeByOption[o.id] ?? 0) / total)
  }
  return odds
}

function formatPct(p: number): string {
  return `${Math.round(p * 100)}%`
}

function MarketCard({
  market,
  myPick,
  bankrollBalance,
}: {
  market: PredictionMarket
  myPick: UserPrediction | undefined
  bankrollBalance: number
}) {
  const predict = useGameStore((s) => s.predict)
  const players = useGameStore((s) => s.players)
  const [wagerText, setWagerText] = useState<string>(String(DEFAULT_WAGER))
  const [selectedOption, setSelectedOption] = useState<string | null>(null)

  const locked = market.status === 'locked'
  const open = market.status === 'open'
  const odds = computePoolOdds(market)
  const parsedWager = Math.max(0, Math.floor(Number(wagerText) || 0))
  const cappedWager = Math.min(parsedWager, bankrollBalance)
  const wagerValid =
    cappedWager >= MIN_WAGER && cappedWager <= bankrollBalance
  const showPicker = open && !myPick

  return (
    <div className="panel rounded-lg p-3">
      <div className="mb-2 flex items-start justify-between gap-2">
        <p className="text-[11px] font-semibold leading-snug text-white">
          {market.question}
        </p>
        <span
          className={`shrink-0 font-mono text-[10px] tabular-nums ${
            locked
              ? 'text-[var(--color-market-warn)]'
              : 'text-[var(--color-text-secondary)]'
          }`}
        >
          {locked ? 'locked' : formatCloseTime(market.closesAt)}
        </span>
      </div>

      <div className="mb-2 flex items-center justify-between text-[9px] uppercase tracking-[0.18em] text-[var(--color-text-tertiary)]">
        <span>pool {formatCash(market.pool.totalStake)}</span>
        {myPick && <span>staked {formatCash(myPick.wager)}</span>}
      </div>

      <div className="flex flex-col gap-1">
        {market.options.map((option) => {
          const isMine = myPick?.optionId === option.id
          const isSelected = selectedOption === option.id
          const lab = option.labId
            ? players.find((p) => p.id === option.labId)
            : null
          const pct = odds.get(option.id) ?? 0
          const disabled = !open || !!myPick

          return (
            <button
              key={option.id}
              type="button"
              disabled={disabled}
              onClick={() => setSelectedOption(option.id)}
              className={`group relative flex items-center justify-between overflow-hidden rounded-md px-2.5 py-1.5 text-left transition ${
                isMine
                  ? 'bg-[var(--color-market-you)]/10 ring-1 ring-[var(--color-market-you)]/50'
                  : isSelected
                    ? 'bg-white/[0.08] ring-1 ring-white/30'
                    : disabled
                      ? 'cursor-not-allowed bg-white/[0.02] opacity-60'
                      : 'bg-white/[0.03] hover:bg-white/[0.06]'
              }`}
            >
              {/* pool-share fill bar behind label */}
              <div
                className="absolute inset-y-0 left-0 transition-all duration-700"
                style={{
                  width: `${pct * 100}%`,
                  backgroundColor: lab?.color ?? '#888',
                  opacity: isMine || isSelected ? 0.22 : 0.1,
                }}
              />
              <div className="relative flex items-center gap-1.5">
                {lab && (
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: lab.color }}
                  />
                )}
                <span
                  className={`text-[11px] font-medium ${
                    isMine ? 'text-[var(--color-market-you)]' : 'text-white'
                  }`}
                >
                  {option.label}
                </span>
              </div>
              <span
                className={`relative font-mono text-[11px] font-bold tabular-nums ${
                  isMine
                    ? 'text-[var(--color-market-you)]'
                    : 'text-[var(--color-text-secondary)]'
                }`}
              >
                {formatPct(pct)}
              </span>
            </button>
          )
        })}
      </div>

      {showPicker && (
        <div className="mt-2 flex items-center gap-2">
          <div className="flex flex-1 items-center gap-1 rounded-md bg-white/[0.04] px-2 py-1.5">
            <span className="font-mono text-[10px] text-[var(--color-text-tertiary)]">
              $
            </span>
            <input
              type="number"
              inputMode="numeric"
              min={MIN_WAGER}
              max={bankrollBalance}
              step={10}
              value={wagerText}
              onChange={(e) => setWagerText(e.target.value)}
              className="w-full bg-transparent font-mono text-[11px] tabular-nums text-white outline-none"
            />
          </div>
          <button
            type="button"
            disabled={!selectedOption || !wagerValid}
            onClick={() => {
              if (!selectedOption || !wagerValid) return
              predict(market.id, selectedOption, cappedWager)
              setSelectedOption(null)
            }}
            className="rounded-md bg-[var(--color-market-you)]/90 px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-wider text-black transition hover:bg-[var(--color-market-you)] disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-white/40"
          >
            Bet
          </button>
        </div>
      )}
      {showPicker && !wagerValid && parsedWager > 0 && (
        <p className="mt-1 font-mono text-[9px] text-[var(--color-market-warn)]">
          {parsedWager > bankrollBalance
            ? 'exceeds bankroll'
            : `min wager ${formatCash(MIN_WAGER)}`}
        </p>
      )}
      {myPick && (
        <p className="mt-2 font-mono text-[9px] uppercase tracking-wider text-[var(--color-text-tertiary)]">
          Locked in on {market.options.find((o) => o.id === myPick.optionId)?.label ?? myPick.optionId}
        </p>
      )}
    </div>
  )
}

function ResolvedCard({
  market,
  myPick,
}: {
  market: PredictionMarket
  myPick: UserPrediction | undefined
}) {
  const winningLabel =
    market.options.find((o) => o.id === market.resolvedOptionId)?.label ??
    'void'
  const won =
    myPick && myPick.payout !== null && myPick.payout > (myPick.wager ?? 0)
  const lost =
    myPick && myPick.payout !== null && myPick.payout < (myPick.wager ?? 0)
  const netDelta = myPick?.payout != null ? myPick.payout - myPick.wager : 0

  return (
    <div className="panel-hairline rounded-lg bg-white/[0.02] p-2.5 text-[10px]">
      <p className="font-medium text-[var(--color-text-secondary)]">
        {market.question}
      </p>
      <div className="mt-1 flex items-center justify-between">
        <span className="font-mono text-[10px] text-white">
          {winningLabel}
        </span>
        {myPick && (
          <span
            className={`font-mono text-[10px] font-bold tabular-nums ${
              won
                ? 'text-[var(--color-market-up)]'
                : lost
                  ? 'text-[var(--color-market-down)]'
                  : 'text-[var(--color-text-secondary)]'
            }`}
          >
            {myPick.payout === null
              ? 'pending'
              : `${netDelta >= 0 ? '+' : ''}${formatCash(netDelta)}`}
          </span>
        )}
      </div>
    </div>
  )
}

export default function MarketsPanel() {
  const openMarkets = useGameStore((s) => s.openMarkets)
  const resolvedMarkets = useGameStore((s) => s.resolvedMarkets)
  const userPredictions = useGameStore((s) => s.userPredictions)
  const userBankroll = useGameStore((s) => s.userBankroll)

  if (openMarkets.length === 0 && resolvedMarkets.length === 0) return null

  const balance = userBankroll?.balance ?? STARTING_BANKROLL

  return (
    <div className="pointer-events-auto absolute right-4 top-[124px] z-30 flex w-[300px] flex-col gap-2">
      <div className="panel flex items-center justify-between rounded-lg px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="text-[9px] font-bold uppercase tracking-[0.2em] text-[var(--color-text-secondary)]">
            Sim Cash
          </span>
        </div>
        <span className="font-mono text-[13px] font-bold tabular-nums text-[var(--color-market-up)]">
          {formatCash(balance)}
        </span>
      </div>
      <div className="flex items-center justify-between px-1">
        <div className="flex items-center gap-2">
          <span className="text-[9px] font-bold uppercase tracking-[0.2em] text-[var(--color-text-secondary)]">
            Markets
          </span>
          <span className="font-mono text-[10px] tabular-nums text-[var(--color-text-tertiary)]">
            {openMarkets.length} open
          </span>
        </div>
      </div>
      {openMarkets.map((market) => (
        <MarketCard
          key={market.id}
          market={market}
          myPick={userPredictions.find((p) => p.marketId === market.id)}
          bankrollBalance={balance}
        />
      ))}
      {resolvedMarkets.slice(0, 2).map((market) => (
        <ResolvedCard
          key={market.id}
          market={market}
          myPick={userPredictions.find((p) => p.marketId === market.id)}
        />
      ))}
    </div>
  )
}
