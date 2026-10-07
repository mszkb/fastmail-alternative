// Applies the stored theme and density (#112) before the app renders.
import { applyAppearance } from '~/utils/appearance'

export default defineNuxtPlugin(() => {
  applyAppearance()
})
