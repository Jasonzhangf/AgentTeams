import { randomUUID } from 'node:crypto'
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { ConfigApplyResult, ManagedConfigUncertainty } from './runtime-config.ts'

/**
 * The one durable record write every record store in `config/` uses.
 *
 * `config/session-intent-store.ts` (the control daemon writing pending Session writes),
 * `config/session-observation-store.ts` (the agent daemon publishing its own Session and
 * permission observations) and `config/relations-intent-store.ts` (the control daemon writing
 * desired peer relations) carry three different facts with three different owners, but the
 * durability discipline is one decision: a mode-`0o600` temporary file in the target
 * directory followed by an atomic rename, so a reader never observes a half-written record.
 *
 * The three outcomes are the store owner's honest boundary:
 *  - the temporary write failed: the target is untouched and the result is `failed`
 *    `UNAVAILABLE`;
 *  - the rename failed: never `applied`, because the target may already carry the new bytes,
 *    so the result is `uncertain` with the real substrate fence;
 *  - the rename succeeded: `applied` with the revision that is now durable.
 *
 * `label` is only the human-readable subject inside the two messages. No caller-specific
 * behavior lives here, so a second durable store cannot grow its own copy of this rule.
 */
export interface DurableRecordWrite {
  readonly path: string
  /** The record's own name, used verbatim in the `failed` and `uncertain` messages. */
  readonly label: string
  readonly record: unknown
  readonly acceptedRevision: number
  readonly effectiveRevision: number
}

/**
 * The fence records the real substrate facts of an ambiguous write: the durable target (the
 * record path, which is the only identity this store owns), the revision the caller
 * accepted, and the revision the write intended to publish.
 */
export function recordWriteUncertainty(
  path: string,
  label: string,
  acceptedRevision: number,
  effectiveRevision: number,
  cause: unknown,
): ManagedConfigUncertainty {
  const target = resolve(path)
  return {
    target: {
      agentId: target,
      targetGeneration: 1,
      acceptedRevision,
      acceptedSourceRevision: 0,
      acceptedSourceHash: '',
      endpointFingerprint: target,
    },
    operation: { operationId: `apply:${target}:${Date.now()}:${randomUUID()}`, kind: 'apply' },
    error: {
      code: 'RESULT_UNKNOWN',
      message: `${label} outcome is unknown: ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
    },
    substrate: {
      effectiveRevision,
      effectiveHandleFingerprint: `${target}\u0000${effectiveRevision}`,
    },
  }
}

/** Best-effort removal of the temporary file; the first write error is what matters. */
async function discard(temporary: string): Promise<void> {
  try {
    await unlink(temporary)
  } catch { /* keep the first failure */ }
}

export async function writeRecordAtomically(input: DurableRecordWrite): Promise<ConfigApplyResult> {
  const temporary = `${input.path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await mkdir(dirname(input.path), { recursive: true })
    await writeFile(temporary, `${JSON.stringify(input.record)}\n`, { encoding: 'utf8', mode: 0o600 })
  } catch {
    await discard(temporary)
    return { status: 'failed', error: { code: 'UNAVAILABLE', message: `${input.label} could not be saved: ${input.path}` } }
  }
  try {
    await rename(temporary, input.path)
  } catch (cause) {
    await discard(temporary)
    const fence = recordWriteUncertainty(input.path, input.label, input.acceptedRevision, input.effectiveRevision, cause)
    return { status: 'uncertain', error: fence.error, fence }
  }
  return { status: 'applied', effectiveRevision: input.effectiveRevision }
}
