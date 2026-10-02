import { buildApp } from './app'

const host = process.env.HOST ?? '0.0.0.0'
const port = Number.parseInt(process.env.PORT ?? '3001', 10)

const app = buildApp()

app.listen({ host, port }).catch((err) => {
  app.log.error(err)
  process.exit(1)
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    app.log.info({ signal }, 'shutting down')
    app.close().finally(() => process.exit(0))
  })
}
