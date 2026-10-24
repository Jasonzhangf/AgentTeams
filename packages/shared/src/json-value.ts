import type { JsonValue } from './agent-services.ts'

/** Validate without serializing: JSON.stringify would silently strip or coerce values. */
export function assertJsonValue(value: unknown, path: string, ancestors = new Set<object>()): asserts value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number' && Number.isFinite(value)) return
  if (typeof value !== 'object' || value === null) throw new Error(`${path} must contain only JSON values`)
  if (ancestors.has(value)) throw new Error(`${path} contains a JSON cycle`)
  const array = Array.isArray(value)
  const prototype = Object.getPrototypeOf(value)
  if (!array && prototype !== Object.prototype && prototype !== null) throw new Error(`${path} must be a plain JSON object`)
  ancestors.add(value)
  try {
    const keys = Reflect.ownKeys(value).filter(key => !(array && key === 'length'))
    if (array && keys.length !== value.length) throw new Error(`${path} must be a dense JSON array`)
    for (const key of keys) {
      if (typeof key !== 'string') throw new Error(`${path} has a non-JSON key`)
      if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)) throw new Error(`${path} has a non-JSON array property`)
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!
      if (!descriptor.enumerable || !('value' in descriptor)) throw new Error(`${path}.${key} must be a JSON data property`)
      assertJsonValue(descriptor.value, `${path}.${key}`, ancestors)
    }
  } finally {
    ancestors.delete(value)
  }
}

export function assertEnvelopeKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${path} has unsupported field ${key}`)
  }
}
