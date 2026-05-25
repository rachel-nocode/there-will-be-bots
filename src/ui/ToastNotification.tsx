import { useEffect } from 'react'
import { HEIST_CONFIG } from '../heist/config'
import { useIsTouchDevice } from '../hooks/useIsTouchDevice'
import { useGameStore } from '../store'

export default function ToastNotification() {
  const isTouch = useIsTouchDevice()
  const toasts = useGameStore((s) => s.toasts)
  const removeToast = useGameStore((s) => s.removeToast)

  useEffect(() => {
    const timers = toasts.map((toast) =>
      setTimeout(() => removeToast(toast.id), HEIST_CONFIG.TOAST_DURATION_MS),
    )
    return () => timers.forEach(clearTimeout)
  }, [toasts, removeToast])

  if (toasts.length === 0) return null

  const typeStyles = {
    info: 'border-blue-400/50 bg-blue-900/40',
    warning: 'border-yellow-400/50 bg-yellow-900/40',
    success: 'border-neon-green/50 bg-green-900/40',
    chaos: 'border-neon-magenta/50 bg-purple-900/40',
  }

  return (
    <div
      className={`fixed z-[60] flex flex-col gap-2 ${
        isTouch
          ? 'inset-x-3 top-[max(8.75rem,calc(env(safe-area-inset-top)+7.75rem))] max-w-none'
          : 'bottom-10 right-4 max-w-sm'
      }`}
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`toast-enter rounded-xl border px-3 py-2.5 text-xs leading-snug text-gray-100 backdrop-blur-md ${typeStyles[toast.type]}`}
        >
          {toast.message}
        </div>
      ))}
    </div>
  )
}
