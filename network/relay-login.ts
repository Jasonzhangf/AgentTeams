import type { AgentDeclaration } from '../control-protocol/agent-services.ts'
import { assertJsonValue } from '../control-protocol/json-value.ts'
import { parseRelayAdmission, RelayProtocolError } from '../control-protocol/relay-admission.ts'
import { connectWss, type WssConnection, type WssConnectionOptions } from './wss-connection.ts'

export interface RelayLoginOptions {
  readonly transport: WssConnectionOptions
  readonly declaration: AgentDeclaration
  readonly admissionTimeoutMs: number
}
export interface RelayLogin {
  /** Historical admission receipt; readiness also requires a live transport. */
  readonly receipt: { readonly connectionId: string; readonly generation: number }
  readonly transport: WssConnection
}

export async function loginRelay(options: RelayLoginOptions): Promise<RelayLogin> {
  if (!Number.isSafeInteger(options.admissionTimeoutMs) || options.admissionTimeoutMs < 1 || options.admissionTimeoutMs > 2_147_483_647) {
    throw new RelayProtocolError('INVALID_INPUT', 'relay: admission timeout must be a valid positive timer duration')
  }
  const request = { kind: 'relay.login', protocolVersion: 2, declaration: options.declaration }
  assertJsonValue(request, 'relay login')
  // Snapshot the configured declaration before network awaits; no business fields are inferred.
  const bytes = Buffer.from(JSON.stringify(request))
  const transport = await connectWss(options.transport)
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new RelayProtocolError('UNAVAILABLE', 'relay: admission timed out')), options.admissionTimeoutMs)
  })
  try {
    return await Promise.race([
      deadline,
      (async () => {
        await transport.send({ bytes, binary: false })
        const frame = await transport.read()
        if (frame.binary) throw new RelayProtocolError('INVALID_INPUT', 'relay: admission requires a text control frame')
        const response = parseRelayAdmission(frame.bytes.toString('utf8'))
        if (response.kind === 'relay.error') throw new RelayProtocolError(response.error.code, response.error.message)
        return { receipt: { connectionId: response.connectionId, generation: response.generation }, transport }
      })(),
    ])
  } catch (error) {
    await transport.close()
    throw error
  } finally {
    clearTimeout(timer)
  }
}
