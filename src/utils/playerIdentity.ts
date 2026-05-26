const PLAYER_NAME_STORAGE_KEY = 'heist.player-name'

export const SELF_PLAYER_COLOR = '#ff4757'

export function loadPlayerName() {
  if (typeof window === 'undefined') return ''
  return window.localStorage.getItem(PLAYER_NAME_STORAGE_KEY)?.trim() ?? ''
}

export function savePlayerName(name: string) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(PLAYER_NAME_STORAGE_KEY, name.trim().slice(0, 20))
}

export function hasSavedPlayerName() {
  return loadPlayerName().length >= 2
}
