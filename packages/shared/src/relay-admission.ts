import type { RelayServerControl } from './agent-services.ts'
import { parseRelayServerControl, RelayProtocolError } from './relay-codec.ts'

export { RelayProtocolError } from './relay-codec.ts'

type Admission = Extract<RelayServerControl, { kind: 'relay.admitted' | 'relay.error' }>

/** First server frame only. A directory or arbitrary object cannot imply admission. */
export function parseRelayAdmission(text: string): Admission {
  try {
    const input = parseRelayServerControl(text)
    if (input.kind === 'relay.admitted' || input.kind === 'relay.error') return input
    throw new Error('unexpected admission frame')
  } catch {
    throw new RelayProtocolError('INVALID_INPUT', 'relay: invalid admission response')
  }
}
