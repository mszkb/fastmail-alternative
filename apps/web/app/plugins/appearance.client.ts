// Applies the stored theme and density (#112) and an installed theme
// (#126) before the app renders. After `?theme=default` the parameter is
// removed from the address, so a later reload keeps a newly chosen theme.
import { applyAppearance } from '~/utils/appearance'
import { initUserTheme } from '~/utils/user-theme'

export default defineNuxtPlugin((nuxtApp) => {
  applyAppearance()
  if (initUserTheme()) {
    nuxtApp.hook('app:mounted', () => {
      const router = useRouter()
      const query = { ...router.currentRoute.value.query }
      delete query.theme
      void router.replace({ query, hash: router.currentRoute.value.hash })
    })
  }
})
