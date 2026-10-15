import type { AcpHost, AcpPendingPermission } from '../agent-host/acp-host.ts'
import type { ConfigErrorCode } from '../config/runtime-config.ts'
import {
  readSessionObservationRecord,
  writeSessionObservationRecord,
  type SessionObservationSnapshot,
} from '../config/session-observation-store.ts'

/**
 * Publish this daemon's own Session and permission observation.
 *
 * The agent daemon owns every Session and permission fact here: the Sessions its engine
 * really holds on an open channel, and the permission callbacks its engine is really
 * awaiting. The control daemon has no channel to ask for them, so this publisher writes
 * them to the one durable observation record the control daemon reads
 * (`config/session-observation-store.ts`). The direction mirrors the pending-Session-write
 * record: there the control daemon writes and this daemon reads; here this daemon publishes
 * and the control daemon reads. Neither adds a control-to-agent channel, and the Console
 * stays out of the data path.
 *
 * The record is a whole snapshot, so a Session whose channel closed and a permission the
 * engine no longer awaits disappear from the next revision. A pass that observes no change
 * writes nothing: the record's revision is a real event count, not a heartbeat.
 */
export interface SessionObservationPublisherInput {
  readonly host: Pick<AcpHost, 'openedSessions' | 'pendingPermissions'>
  /** The one record path for this daemon. `config/session-observation-store.ts` owns it. */
  readonly recordPath: string
  /** This daemon's own accepted identity. A record that names another agent is refused. */
  readonly agentId: string
}

/**
 * One typed refusal to publish, with the agent it belongs to. `code` is the store's own
 * configuration code, plus the `FORBIDDEN` this publisher raises when the record at its own
 * path names another agent. Nothing is flattened into a generic failure.
 */
export interface SessionObservationFailure {
  readonly agentId: string
  readonly code: ConfigErrorCode | 'FORBIDDEN'
  readonly message: string
}

export interface SessionObservationPublisher {
  /** One pass: publish the current observation when it differs from the published one. */
  publish(): Promise<void>
  readonly recordPath: string
  /** Every typed refusal this publisher recorded in its lifetime. */
  failures(): readonly SessionObservationFailure[]
}

/**
 * The projection row's own id for one pending permission. The permission id is the engine
 * callback id the controller received, so the row is stable while that callback is open and
 * disappears with it; the prefix keeps the row namespace the record's own.
 */
export function sessionObservationNotificationId(permissionId: string): string {
  return `permission:${permissionId}`
}

/** The whole observation this pass observes, in one canonical order. */
function observe(input: SessionObservationPublisherInput): SessionObservationSnapshot {
  const sessions = [...new Set(input.host.openedSessions())].sort()
  const byNotification = new Map<string, { readonly notificationId: string; readonly sessionId: string; readonly permissionId: string }>()
  for (const pending of input.host.pendingPermissions() as readonly AcpPendingPermission[]) {
    const notificationId = sessionObservationNotificationId(pending.permissionId)
    // A permission whose Session the host no longer reports would cross the record's own
    // rule, and the store refuses it. Drop it here for the same reason: a row the reader
    // cannot name its Session for is not an observation this daemon may publish.
    if (!sessions.includes(pending.sessionId)) continue
    byNotification.set(notificationId, { notificationId, sessionId: pending.sessionId, permissionId: pending.permissionId })
  }
  return {
    agentId: input.agentId,
    sessions: sessions.map(sessionId => ({ sessionId })),
    permissions: [...byNotification.values()].sort((left, right) => left.notificationId.localeCompare(right.notificationId)),
  }
}

function same(left: SessionObservationSnapshot | undefined, right: SessionObservationSnapshot): boolean {
  return left !== undefined && JSON.stringify(left) === JSON.stringify(right)
}

export function createSessionObservationPublisher(input: SessionObservationPublisherInput): SessionObservationPublisher {
  const failures: SessionObservationFailure[] = []
  const recorded = new Set<string>()
  // A poll repeats the same refusal every tick, so the list keeps each distinct refusal once.
  const refuse = (code: ConfigErrorCode | 'FORBIDDEN', message: string): void => {
    const key = `${code}\u0000${message}`
    if (recorded.has(key)) return
    recorded.add(key)
    failures.push({ agentId: input.agentId, code, message })
  }

  /** What this publisher last observed and the revision the record carried for it. */
  let published: SessionObservationSnapshot | undefined
  let revision = 0
  let seeded = false
  /**
   * The pass that is running, if any. The poll tick and the stop-time publish share this one
   * publisher, and clearing the interval does not cancel a pass that already started. Two
   * passes would read the same revision, so one of them would fail a CAS conflict it did not
   * cause, and a stop pass that lost that race would leave the last non-empty observation on
   * disk while the daemon holds nothing. Chaining also makes a stop-time publish run after the
   * pass in flight, which is the order the stop path needs.
   */
  let inFlight: Promise<void> | undefined

  const seed = async (): Promise<void> => {
    const record = await readSessionObservationRecord(input.recordPath)
    if (record !== undefined && record.agentId !== input.agentId) {
      // The record path is derived from the target agent, so a record naming another agent
      // was written where it does not belong. Refuse it instead of replacing another's bytes.
      throw Object.assign(new Error(`session observation record names agent ${record.agentId}, but this daemon is ${input.agentId}`), { code: 'FORBIDDEN' })
    }
    published = record === undefined
      ? undefined
      : { agentId: record.agentId, sessions: record.sessions, permissions: record.permissions }
    revision = record?.revision ?? 0
    seeded = true
  }

  /**
   * One pass. It never rejects: every refusal, including a read or a host read that throws, is
   * recorded as a typed refusal instead of escaping an interval callback, where an unhandled
   * rejection could take the daemon down.
   */
  const runPass = async (): Promise<void> => {
    try {
      if (!seeded) await seed()
      const snapshot = observe(input)
      // Nothing changed: the revision stays, so the control daemon's polling readback reports
      // no new event and the Console receives no frame for a heartbeat.
      if (same(published, snapshot)) return
      const result = await writeSessionObservationRecord(input.recordPath, revision, snapshot)
      if (result.status === 'applied') {
        published = snapshot
        revision = result.effectiveRevision
        return
      }
      // A refused write is not an observation the reader may treat as published. A revision
      // conflict means someone else wrote this record; re-seed so the next pass rebases onto
      // the durable revision instead of retrying a base that is already gone.
      refuse(result.error.code, result.error.message)
      if (result.error.code === 'REVISION_CONFLICT') seeded = false
    } catch (error) {
      refuse((error as { readonly code?: ConfigErrorCode | 'FORBIDDEN' }).code ?? 'UNAVAILABLE', error instanceof Error ? error.message : String(error))
    }
  }

  const publish = async (): Promise<void> => {
    const pass = (inFlight ?? Promise.resolve()).then(runPass)
    inFlight = pass
    await pass
  }

  return { publish, recordPath: input.recordPath, failures: () => [...failures] }
}
