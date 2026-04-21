import { useState } from 'react'
import { useGameStore } from '../store'

export default function HumanLeaderboard() {
  const [open, setOpen] = useState(false)
  const leaderboard = useGameStore((s) => s.humanLeaderboard)
  const spectatorId = useGameStore((s) => s.spectatorId)
  const userRank = useGameStore((s) => s.userRank)

  if (leaderboard.length === 0) return null

  return (
    <div className="pointer-events-auto absolute bottom-16 right-4 z-30 w-[260px]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="panel flex w-full items-center justify-between rounded-md px-3 py-1.5 text-[11px] transition hover:bg-white/[0.06]"
      >
        <div className="flex items-center gap-2">
          <span className="text-[9px] font-bold uppercase tracking-[0.18em] text-[var(--color-text-secondary)]">
            Traders
          </span>
          <span className="font-mono text-[10px] tabular-nums text-[var(--color-text-tertiary)]">
            {leaderboard.length}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {userRank && (
            <span className="font-mono text-[10px] tabular-nums text-[var(--color-market-you)]">
              you #{userRank}
            </span>
          )}
          <span className="text-[var(--color-text-tertiary)]">
            {open ? '▾' : '▸'}
          </span>
        </div>
      </button>

      {open && (
        <div className="panel mt-1.5 max-h-72 overflow-y-auto rounded-md p-1.5">
          {leaderboard.slice(0, 20).map((entry, index) => {
            const rank = index + 1
            const isMe = entry.userId === spectatorId
            return (
              <div
                key={entry.userId}
                className={`flex items-center justify-between rounded-sm px-2 py-1 text-[11px] ${
                  isMe
                    ? 'bg-[var(--color-market-you)]/10 text-[var(--color-market-you)]'
                    : 'text-[var(--color-text-secondary)]'
                }`}
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span className="w-5 text-right font-mono text-[10px] tabular-nums text-[var(--color-text-tertiary)]">
                    {rank}
                  </span>
                  <span className="truncate">{entry.displayName}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[10px] tabular-nums text-[var(--color-market-up)]">
                    ${Math.round(entry.bankroll).toLocaleString('en-US')}
                  </span>
                  <span className="font-mono text-[11px] font-bold tabular-nums text-white">
                    {entry.totalPoints.toFixed(1)}
                  </span>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
