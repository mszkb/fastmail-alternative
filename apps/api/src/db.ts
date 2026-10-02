import { createPool } from '@fma/db'

/** Shared pg pool for the api process. */
export const pool = createPool()
