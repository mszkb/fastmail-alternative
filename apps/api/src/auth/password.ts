/**
 * Password hashing with Argon2id (ADR-0004) via hash-wasm: pure WebAssembly,
 * so the single-file api bundle needs no native addons (important for the
 * lean arm64 deployment image).
 *
 * Parameters follow the OWASP password storage recommendation
 * (m=19 MiB, t=2, p=1). Login is rare, so the cost is acceptable and it
 * slows brute force attempts down.
 */
import { randomBytes } from 'node:crypto'
import { argon2id, argon2Verify } from 'hash-wasm'

const ARGON2_PARAMS = {
  parallelism: 1,
  iterations: 2,
  memorySize: 19456, // KiB
  hashLength: 32,
} as const

export async function hashPassword(password: string): Promise<string> {
  return argon2id({
    password,
    salt: randomBytes(16),
    ...ARGON2_PARAMS,
    outputType: 'encoded',
  })
}

/** Constant-ish verification; returns false for malformed hashes. */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  try {
    return await argon2Verify({ password, hash })
  } catch {
    return false
  }
}

/**
 * A throwaway hash used to equalize timing when the email does not match,
 * so attackers cannot distinguish "unknown email" from "wrong password"
 * by response time. Generated lazily on first use.
 */
let dummyHash: string | null = null
export async function dummyVerify(password: string): Promise<void> {
  dummyHash ??= await hashPassword(randomBytes(18).toString('base64'))
  await verifyPassword(password, dummyHash)
}
