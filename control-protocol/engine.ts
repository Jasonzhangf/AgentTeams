import type { AcpDuplex } from '../acp-adapter/stdio.ts'
import type { AcpPolicyIntent } from '../config/acp-policy.ts'
import type { ConfigTargetIdentity, ModelRef, VersionedRuntimeConfig } from '../config/runtime-config.ts'
import type { AcpFault, AcpFrame } from './acp.ts'

export interface EngineLaunchInput {
  readonly kind: 'opencode' | 'dsh'
  /** The resolved absolute installed executable path. */
  readonly executable: string
  readonly workspace: string
  /** Private derived directory owned by the current daemon generation. */
  readonly ownedDirectory: string
  readonly target: ConfigTargetIdentity
  readonly accepted: VersionedRuntimeConfig
  readonly policy: AcpPolicyIntent
}

export interface EngineLaunchSpec {
  readonly executable: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  readonly credentialEnvRefs: Readonly<Record<string, string>>
  readonly files: readonly {
    readonly path: string
    readonly content: string
    readonly mode: 0o600
  }[]
  readonly supportedPolicies: readonly string[]
}

export interface EngineAdapter {
  readonly kind: 'opencode' | 'dsh'
  compileLaunch(input: EngineLaunchInput): Promise<EngineLaunchSpec>
  /**
   * Prove the accepted config is effective for this engine instance.
   *
   * `sessionConfigResult` is the real `session/new` result (with its
   * `configOptions`/current values) captured by the runtime bootstrap as the
   * sole reader before ownership transfer. The adapter must not read the
   * transport itself or concurrently. `initializeResult` alone does not prove a
   * configured model/binding is effective.
   */
  verifyEffective(input: {
    readonly handle: EngineHandle
    readonly launch: EngineLaunchInput
    readonly initializeResult: AcpFrame
    readonly sessionConfigResult?: AcpFrame
  }): Promise<{
    readonly effectiveRevision: number
    readonly modelTarget: ModelRef | null
    readonly evidence: import('./agent-services.ts').JsonValue
  }>
}

export type EngineStopResult =
  | { readonly kind: 'exited'; readonly code: number | null; readonly signal: string | null }
  | { readonly kind: 'retained'; readonly pid: number; readonly error: AcpFault }

export interface EngineHandle {
  readonly engineInstanceId: string
  readonly pid: number
  readonly targetGeneration: number
  readonly acp: AcpDuplex
  readonly exited: Promise<{ readonly code: number | null; readonly signal: string | null }>
  stop(): Promise<EngineStopResult>
}
