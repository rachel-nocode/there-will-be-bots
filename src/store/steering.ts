import { create } from 'zustand'

interface SteeringStore {
  x: number
  y: number
  active: boolean
  setSteering: (x: number, y: number, active: boolean) => void
  reset: () => void
}

export const useSteeringStore = create<SteeringStore>((set) => ({
  x: 0,
  y: 0,
  active: false,
  setSteering: (x, y, active) => set({ x, y, active }),
  reset: () => set({ x: 0, y: 0, active: false }),
}))
