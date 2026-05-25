import { useEffect, useState } from 'react'

export function useIsTouchDevice() {
  const [isTouch, setIsTouch] = useState(false)

  useEffect(() => {
    const media = window.matchMedia('(pointer: coarse)')
    const update = () => {
      setIsTouch(media.matches || navigator.maxTouchPoints > 0)
    }
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  return isTouch
}
