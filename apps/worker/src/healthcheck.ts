/**
 * Docker healthcheck for the worker (docker-compose.yml): exits 0 if the
 * heartbeat file (./heartbeat) is fresh, 1 otherwise. No output, no
 * dependencies besides node itself.
 */
import { HEARTBEAT_MAX_AGE_MS, heartbeatFile, isHeartbeatFresh } from './heartbeat'

process.exit(isHeartbeatFresh(heartbeatFile(), HEARTBEAT_MAX_AGE_MS) ? 0 : 1)
