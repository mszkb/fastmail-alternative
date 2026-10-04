import { startApi, stopApi } from './server'

async function main(): Promise<void> {
  const app = await startApi()

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      app.log.info({ signal }, 'shutting down')
      void stopApi(app).finally(() => process.exit(0))
    })
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
