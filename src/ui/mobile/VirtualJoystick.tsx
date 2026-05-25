import { useCallback, useRef, type PointerEvent } from 'react'
import { useSteeringStore } from '../../store/steering'

const BASE_SIZE = 112
const KNOB_SIZE = 48
const MAX_RADIUS = (BASE_SIZE - KNOB_SIZE) / 2 - 4

type VirtualJoystickProps = {
  disabled?: boolean
}

export default function VirtualJoystick({ disabled = false }: VirtualJoystickProps) {
  const baseRef = useRef<HTMLDivElement>(null)
  const pointerId = useRef<number | null>(null)
  const setSteering = useSteeringStore((state) => state.setSteering)
  const reset = useSteeringStore((state) => state.reset)
  const knobX = useSteeringStore((state) => (state.active ? state.x * MAX_RADIUS : 0))
  const knobY = useSteeringStore((state) => (state.active ? state.y * MAX_RADIUS : 0))

  const updateFromPointer = useCallback(
    (clientX: number, clientY: number) => {
      const base = baseRef.current
      if (!base) return

      const rect = base.getBoundingClientRect()
      const centerX = rect.left + rect.width / 2
      const centerY = rect.top + rect.height / 2
      const offsetX = clientX - centerX
      const offsetY = clientY - centerY
      const distance = Math.hypot(offsetX, offsetY)
      const clampedDistance = Math.min(distance, MAX_RADIUS)
      const angle = Math.atan2(offsetY, offsetX)
      const clampedX = Math.cos(angle) * clampedDistance
      const clampedY = Math.sin(angle) * clampedDistance
      const normalizedX = clampedX / MAX_RADIUS
      const normalizedY = clampedY / MAX_RADIUS

      setSteering(normalizedX, normalizedY, true)
    },
    [setSteering],
  )

  const handlePointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (disabled) return
      event.preventDefault()
      event.stopPropagation()
      pointerId.current = event.pointerId
      event.currentTarget.setPointerCapture(event.pointerId)
      updateFromPointer(event.clientX, event.clientY)
    },
    [disabled, updateFromPointer],
  )

  const handlePointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (disabled || pointerId.current !== event.pointerId) return
      event.preventDefault()
      updateFromPointer(event.clientX, event.clientY)
    },
    [disabled, updateFromPointer],
  )

  const handlePointerEnd = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (pointerId.current !== event.pointerId) return
      pointerId.current = null
      reset()
    },
    [reset],
  )

  return (
    <div
      ref={baseRef}
      aria-label="Move joystick"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
      className={`relative touch-manipulation select-none rounded-full border-2 border-white/15 bg-black/25 shadow-[inset_0_0_24px_rgba(255,255,255,0.04)] backdrop-blur-sm ${
        disabled ? 'opacity-35' : 'opacity-90'
      }`}
      style={{
        width: BASE_SIZE,
        height: BASE_SIZE,
        WebkitTapHighlightColor: 'transparent',
      }}
    >
      <span className="pointer-events-none absolute inset-3 rounded-full border border-dashed border-white/10" />
      <span
        className="pointer-events-none absolute rounded-full border-2 border-cyan-200/50 bg-cyan-400/25 shadow-[0_0_18px_rgba(34,211,238,0.35)]"
        style={{
          width: KNOB_SIZE,
          height: KNOB_SIZE,
          left: '50%',
          top: '50%',
          transform: `translate(calc(-50% + ${knobX}px), calc(-50% + ${knobY}px))`,
        }}
      />
    </div>
  )
}
