import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createOpenAIModelCatalogClient,
  type OpenAIModelCatalogClientOptions,
} from './provider-model-client.ts'
import {
  RuntimeConfigError,
  type ProviderInstance,
  type ProviderProtocol,
} from './runtime-config.ts'

interface TestServer {
  readonly baseUrl: string
  readonly close: () => Promise<void>
}

const servers: TestServer[] = []

async function startServer(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<TestServer> {
  const server = createServer(handler)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { resolve() })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('test server did not expose an address')
  const testServer: TestServer = {
    baseUrl: `http://127.0.0.1:${(address as AddressInfo).port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close(error => error === undefined ? resolve() : reject(error))
      })
    },
  }
  servers.push(testServer)
  return testServer
}

afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close()
})
function provider(baseUrl: string, protocol: ProviderProtocol = 'openai-chat', bearer = true): ProviderInstance {
  return {
    id: 'provider-local',
    label: 'Local provider',
    protocol,
    apiBaseUrl: `${baseUrl}/v1`,
    enabled: true,
    auth: bearer ? { kind: 'bearer', credentialRef: 'opaque:local' } : { kind: 'none' },
  }
}

function credential() {
  return { kind: 'bearer' as const, value: 'local-secret' }
}

async function listModels(
  baseUrl: string,
  protocol: ProviderProtocol = 'openai-chat',
  options: OpenAIModelCatalogClientOptions = {},
  bearer = true,
) {
  const client = createOpenAIModelCatalogClient(options)
  return client.listModels({ provider: provider(baseUrl, protocol, bearer), ...(bearer ? { credential: credential() } : {}) })
}

describe('OpenAI model catalog client', () => {
  it.each(['openai-chat', 'openai-responses'] as const)('uses the API base /models path and Authorization header for %s', async protocol => {
    const requests: Array<{ method?: string; url?: string; authorization?: string }> = []
    const server = await startServer((request, response) => {
      requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization })
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({
        object: 'list',
        data: [{
          id: 'model-a',
          name: 'Model A',
          context_window: 128000,
          max_output_tokens: 4096,
          tools: true,
          streaming: true,
          reasoning: true,
          input_modalities: ['text', 'image'],
          output_modalities: ['text'],
          owned_by: 'ignored-evidence',
        }],
      }))
    })

    const result = await listModels(server.baseUrl, protocol)
    expect(result).toEqual([{
      modelId: 'model-a',
      metadata: {
        label: 'Model A',
        contextWindow: 128000,
        maxOutputTokens: 4096,
        tools: true,
        streaming: true,
        reasoning: true,
        inputModalities: ['text', 'image'],
        outputModalities: ['text'],
      },
    }])
    expect(requests).toEqual([{ method: 'GET', url: '/v1/models', authorization: 'Bearer local-secret' }])
  })

  it('returns a true empty catalog without inventing metadata', async () => {
    const server = await startServer((_request, response) => {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ data: [] }))
    })

    await expect(listModels(server.baseUrl, 'openai-chat')).resolves.toEqual([])
  })

  it('does not send Authorization for a provider without bearer auth', async () => {
    let authorization: string | undefined
    const server = await startServer((request, response) => {
      authorization = request.headers.authorization
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ data: [] }))
    })

    await expect(listModels(server.baseUrl, 'openai-chat', {}, false)).resolves.toEqual([])
    expect(authorization).toBeUndefined()
  })

  it('rejects a bearer provider without a resolved credential before network I/O', async () => {
    let requests = 0
    const server = await startServer((_request, response) => {
      requests += 1
      response.end(JSON.stringify({ data: [] }))
    })
    const client = createOpenAIModelCatalogClient()

    await expect(client.listModels({ provider: provider(server.baseUrl) })).rejects.toMatchObject({
      name: 'RuntimeConfigError',
      code: 'CREDENTIAL_UNAVAILABLE',
      providerInstanceId: 'provider-local',
    })
    expect(requests).toBe(0)
  })

  it.each([
    [300, 'UNAVAILABLE'],
    [401, 'UNAUTHENTICATED'],
    [403, 'FORBIDDEN'],
    [404, 'NOT_FOUND'],
    [500, 'UPSTREAM_ERROR'],
  ] as const)('rejects HTTP %s as an explicit RuntimeConfigError', async (status, code) => {
    const server = await startServer((_request, response) => {
      response.statusCode = status
      response.end('failure')
    })

    const result = listModels(server.baseUrl)
    await expect(result).rejects.toBeInstanceOf(RuntimeConfigError)
    await expect(result).rejects.toMatchObject({ code, status, providerInstanceId: 'provider-local' })
  })

  it.each([
    ['not-json', 'UPSTREAM_ERROR'],
    [JSON.stringify({ data: {} }), 'UPSTREAM_ERROR'],
    [JSON.stringify({ data: [{}] }), 'UPSTREAM_ERROR'],
    [JSON.stringify({ data: [{ id: 'duplicate' }, { id: 'duplicate' }] }), 'CONFLICT'],
  ] as const)('rejects invalid model data (%s)', async (body, code) => {
    const server = await startServer((_request, response) => {
      response.setHeader('content-type', 'application/json')
      response.end(body)
    })

    await expect(listModels(server.baseUrl)).rejects.toMatchObject({
      name: 'RuntimeConfigError',
      code,
      providerInstanceId: 'provider-local',
    })
  })

  it('rejects a redirect without following it or sending credentials cross-origin', async () => {
    let targetHit = false
    const target = await startServer((_request, response) => {
      targetHit = true
      response.end(JSON.stringify({ data: [] }))
    })
    const source = await startServer((_request, response) => {
      response.statusCode = 302
      response.setHeader('location', `${target.baseUrl}/v1/models`)
      response.end()
    })

    await expect(listModels(source.baseUrl)).rejects.toMatchObject({ code: 'UNAVAILABLE', status: 302 })
    expect(targetHit).toBe(false)
  })

  it('rejects an invalid JSON response explicitly', async () => {
    const server = await startServer((_request, response) => {
      response.setHeader('content-type', 'application/json')
      response.end('{')
    })

    await expect(listModels(server.baseUrl)).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' })
  })

  it('rejects a response over the configured byte limit', async () => {
    const body = JSON.stringify({ data: [{ id: 'model-a', name: 'x'.repeat(256) }] })
    const server = await startServer((_request, response) => {
      response.setHeader('content-type', 'application/json')
      response.setHeader('content-length', Buffer.byteLength(body).toString())
      response.end(body)
    })

    await expect(listModels(server.baseUrl, 'openai-chat', { maxResponseBytes: 32 })).rejects.toMatchObject({
      code: 'RESOURCE_EXHAUSTED',
      providerInstanceId: 'provider-local',
    })
  })

  it('rejects a request timeout explicitly', async () => {
    const server = await startServer((_request, response) => {
      setTimeout(() => { response.end(JSON.stringify({ data: [] })) }, 100)
    })

    await expect(listModels(server.baseUrl, 'openai-chat', { timeoutMs: 10 })).rejects.toMatchObject({
      code: 'UNAVAILABLE',
      providerInstanceId: 'provider-local',
    })
  })
})
