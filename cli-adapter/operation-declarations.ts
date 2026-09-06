import type { JsonValue, OperationDeclaration } from '../control-protocol/agent-services.ts'
import type { CliOperation } from './contracts.ts'

const text = { type: 'string' }
const identifier = { type: 'string', minLength: 1 }
const url = { type: 'string', minLength: 1, description: 'Absolute HTTP or HTTPS URL.' }
function object(properties: Record<string, JsonValue>, required = Object.keys(properties)): Record<string, JsonValue> {
  return { type: 'object', properties, required, additionalProperties: false }
}

/** Public argument/result schemas. Operation selection stays in Work control. */
export const cliOperationDeclarations: Readonly<Record<CliOperation, OperationDeclaration>> = {
  'context.create': {
    operation: 'context.create', cancellation: 'unsupported',
    inputSchema: object({ initialUrl: url }, []),
    outputSchema: object({ contextId: identifier, profile: identifier, sessionId: identifier, raw: {} }),
  },
  navigate: {
    operation: 'navigate', cancellation: 'unsupported',
    inputSchema: object({ contextId: identifier, url }),
    outputSchema: object({ contextId: identifier, url, navigated: { const: true }, raw: {} }),
  },
  snapshot: {
    operation: 'snapshot', cancellation: 'unsupported',
    inputSchema: object({ contextId: identifier }),
    outputSchema: object({ contextId: identifier, url: text, html: text, raw: {} }),
  },
  'context.destroy': {
    operation: 'context.destroy', cancellation: 'unsupported',
    inputSchema: object({ contextId: identifier }),
    outputSchema: object({ contextId: identifier, profile: identifier, state: { const: 'stopped' }, raw: {} }),
  },
  search: {
    operation: 'search', cancellation: 'unsupported',
    inputSchema: object({ query: { ...identifier, description: 'Literal text without NUL; fixed configured root only.' },
      maxResults: { type: 'integer', minimum: 1 } }, ['query']),
    outputSchema: object({ query: identifier, status: { enum: ['matched', 'no_match'] }, exitCode: { enum: [0, 1] },
      matches: { type: 'array', items: object({ path: identifier, line: { type: 'integer', minimum: 1 }, text, raw: {} }) },
      truncated: { type: 'boolean' }, stdout: text, stderr: text }),
  },
}
