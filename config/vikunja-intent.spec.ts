import { describe, expect, it } from 'vitest'
import { parseVikunjaIntent, VikunjaIntentError } from './vikunja-intent.ts'

function errorCode(task: () => unknown): string {
  try {
    task()
  } catch (error) {
    if (error instanceof VikunjaIntentError) return error.code
    throw error
  }
  throw new Error('expected VikunjaIntentError')
}

function errorMessage(task: () => unknown): string {
  try {
    task()
  } catch (error) {
    if (error instanceof VikunjaIntentError) return error.message
    throw error
  }
  throw new Error('expected VikunjaIntentError')
}

describe('vikunja intent', () => {
  it('compiles a full section into a frozen intent', () => {
    const intent = parseVikunjaIntent({
      baseUrl: 'https://vikunja.example.test/teams',
      tokenRef: 'env:VIKUNJA_TOKEN',
      projectId: '7',
      webhookSecretRef: 'file:./secrets/vikunja-webhook',
    })

    expect(intent).toEqual({
      baseUrl: 'https://vikunja.example.test/teams',
      tokenRef: 'env:VIKUNJA_TOKEN',
      projectId: '7',
      webhookSecretRef: 'file:./secrets/vikunja-webhook',
    })
    expect(Object.isFrozen(intent)).toBe(true)
  })

  it('keeps optional fields absent without inventing defaults', () => {
    const intent = parseVikunjaIntent({ baseUrl: 'http://127.0.0.1:3456', tokenRef: 'file:./token' })
    expect(intent).toEqual({ baseUrl: 'http://127.0.0.1:3456', tokenRef: 'file:./token' })
    expect(intent !== undefined && 'projectId' in intent).toBe(false)
    expect(intent !== undefined && 'webhookSecretRef' in intent).toBe(false)
  })

  it('returns undefined for an absent section without touching other config', () => {
    expect(parseVikunjaIntent(undefined)).toBeUndefined()
  })

  it('rejects unknown keys in the section', () => {
    expect(errorCode(() => parseVikunjaIntent({
      baseUrl: 'https://vikunja.example.test',
      tokenRef: 'env:VIKUNJA_TOKEN',
      token: 'inline-secret',
    }))).toBe('INVALID_INPUT')
    expect(errorMessage(() => parseVikunjaIntent({
      baseUrl: 'https://vikunja.example.test',
      tokenRef: 'env:VIKUNJA_TOKEN',
      endpoint: 'https://other.example.test',
    }))).toContain('unsupported fields: endpoint')
  })

  it('rejects an inline plaintext token and every non-reference secret', () => {
    expect(errorCode(() => parseVikunjaIntent({
      baseUrl: 'https://vikunja.example.test',
      tokenRef: 'tk_plaintext_value',
    }))).toBe('INVALID_INPUT')
    expect(errorCode(() => parseVikunjaIntent({
      baseUrl: 'https://vikunja.example.test',
      tokenRef: 'env:not a name',
    }))).toBe('INVALID_INPUT')
    expect(errorCode(() => parseVikunjaIntent({
      baseUrl: 'https://vikunja.example.test',
      tokenRef: 'file:',
    }))).toBe('INVALID_INPUT')
    expect(errorCode(() => parseVikunjaIntent({
      baseUrl: 'https://vikunja.example.test',
      tokenRef: 'env:VIKUNJA_TOKEN',
      webhookSecretRef: 'webhook-plaintext',
    }))).toBe('INVALID_INPUT')
  })

  it('rejects non-http, malformed, credential-bearing, or fragmented base URLs', () => {
    expect(errorCode(() => parseVikunjaIntent({
      baseUrl: 'ftp://vikunja.example.test',
      tokenRef: 'env:VIKUNJA_TOKEN',
    }))).toBe('INVALID_INPUT')
    expect(errorCode(() => parseVikunjaIntent({
      baseUrl: 'not a url',
      tokenRef: 'env:VIKUNJA_TOKEN',
    }))).toBe('INVALID_INPUT')
    expect(errorCode(() => parseVikunjaIntent({
      baseUrl: 'https://user:secret@vikunja.example.test',
      tokenRef: 'env:VIKUNJA_TOKEN',
    }))).toBe('INVALID_INPUT')
    expect(errorCode(() => parseVikunjaIntent({
      baseUrl: 'https://user@vikunja.example.test',
      tokenRef: 'env:VIKUNJA_TOKEN',
    }))).toBe('INVALID_INPUT')
    expect(errorCode(() => parseVikunjaIntent({
      baseUrl: 'https://vikunja.example.test/#teams',
      tokenRef: 'env:VIKUNJA_TOKEN',
    }))).toBe('INVALID_INPUT')
    expect(errorCode(() => parseVikunjaIntent({
      baseUrl: 'https://vikunja.example.test/?project=7',
      tokenRef: 'env:VIKUNJA_TOKEN',
    }))).toBe('INVALID_INPUT')
  })

  it('rejects a section that is not a table and empty required values', () => {
    expect(errorCode(() => parseVikunjaIntent('vikunja'))).toBe('INVALID_INPUT')
    expect(errorCode(() => parseVikunjaIntent([]))).toBe('INVALID_INPUT')
    expect(errorCode(() => parseVikunjaIntent(null))).toBe('INVALID_INPUT')
    expect(errorCode(() => parseVikunjaIntent({ tokenRef: 'env:VIKUNJA_TOKEN' }))).toBe('INVALID_INPUT')
    expect(errorCode(() => parseVikunjaIntent({ baseUrl: 'https://vikunja.example.test' }))).toBe('INVALID_INPUT')
    expect(errorCode(() => parseVikunjaIntent({
      baseUrl: 'https://vikunja.example.test',
      tokenRef: 'env:VIKUNJA_TOKEN',
      projectId: '',
    }))).toBe('INVALID_INPUT')
  })
})
