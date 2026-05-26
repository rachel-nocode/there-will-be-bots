import { useState, type FormEvent } from 'react'
import {
  loadPlayerName,
  savePlayerName,
} from '../utils/playerIdentity'

type NameGateProps = {
  onComplete: (name: string) => void
}

export default function NameGate({ onComplete }: NameGateProps) {
  const [name, setName] = useState(() => loadPlayerName())
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault()
    const trimmed = name.trim().slice(0, 20)
    if (trimmed.length < 2) {
      setError('Pick a name with at least 2 characters.')
      return
    }
    savePlayerName(trimmed)
    onComplete(trimmed)
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-end justify-center bg-black/70 px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-[max(1rem,env(safe-area-inset-top))] backdrop-blur-sm sm:items-center">
      <div className="w-full max-w-md rounded-2xl border border-red-500/30 bg-[#0a0b12]/95 p-5 shadow-[0_0_40px_rgba(255,71,87,0.15)] backdrop-blur-md sm:p-6">
        <p className="text-center text-4xl">🦖</p>
        <h2 className="mt-3 text-center text-xl font-semibold text-white">
          Who&apos;s running?
        </h2>
        <p className="mt-1 text-center text-sm text-white/65">
          Pick a name before Slopzilla wakes up. You&apos;ll show up as{' '}
          <span className="font-semibold text-red-400">red</span> with a big YOU
          tag.
        </p>

        <form className="mt-5 space-y-3" onSubmit={handleSubmit}>
          <label className="block">
            <span className="text-[10px] uppercase tracking-[0.22em] text-white/45">
              Runner name
            </span>
            <input
              autoFocus
              value={name}
              onChange={(event) => {
                setName(event.target.value)
                setError(null)
              }}
              maxLength={20}
              placeholder="e.g. Token Bandit"
              className="mt-1.5 w-full rounded-xl border border-white/15 bg-black/50 px-4 py-3 text-base text-white outline-none ring-red-400/40 placeholder:text-white/30 focus:border-red-400/50 focus:ring-2"
            />
          </label>

          {error ? (
            <p className="text-sm text-red-300">{error}</p>
          ) : null}

          <button
            type="submit"
            className="w-full rounded-xl bg-red-500 px-4 py-3 text-sm font-bold uppercase tracking-[0.18em] text-white shadow-[0_0_24px_rgba(255,71,87,0.35)] transition active:scale-[0.99]"
          >
            Join city
          </button>
        </form>
      </div>
    </div>
  )
}
