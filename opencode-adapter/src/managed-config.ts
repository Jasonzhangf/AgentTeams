import type { OpenCodeCompiledConfig } from './index.ts'

interface LaunchProvider {
  npm: '@ai-sdk/openai' | '@ai-sdk/openai-compatible'
  name: string
  env: string[]
  options: { baseURL: string; apiKey?: string }
  models: Record<string, { name: string }>
}

/** Derived substrate configuration; runtime resolves references into its private child environment. */
export function createOpenCodeLaunchConfig(compiled: OpenCodeCompiledConfig) {
  const provider: Record<string, LaunchProvider> = Object.create(null)
  const credentialReferences: Record<string, string> = Object.create(null)
  for (const target of [compiled.primary, ...(compiled.backup ? [compiled.backup] : [])]) {
    if (!Object.hasOwn(provider, target.provider)) {
      const environmentKey = `TEAMS_PROVIDER_${Object.keys(provider).length}`
      if (target.credentialRef !== undefined) credentialReferences[environmentKey] = target.credentialRef
      provider[target.provider] = {
        npm: target.protocol === 'openai-chat' ? '@ai-sdk/openai-compatible' : '@ai-sdk/openai',
        name: target.provider, env: [],
        options: { baseURL: target.baseUrl, ...(target.credentialRef === undefined ? {} : { apiKey: `{env:${environmentKey}}` }) },
        models: Object.create(null),
      }
    } else {
      const existing = provider[target.provider]
      const existingKey = existing.options.apiKey?.slice(5, -1)
      const existingReference = existingKey === undefined ? undefined : credentialReferences[existingKey]
      if (existing.options.baseURL !== target.baseUrl ||
        (existing.npm === '@ai-sdk/openai-compatible' ? 'openai-chat' : 'openai-responses') !== target.protocol ||
        (existingKey === undefined) !== (target.credentialRef === undefined) ||
        existingReference !== target.credentialRef) {
        throw new Error(`OpenCode provider targets disagree for ${target.provider}`)
      }
    }
    provider[target.provider].models[target.model] = { name: target.model }
  }
  return { config: { model: `${compiled.primary.provider}/${compiled.primary.model}`, enabled_providers: Object.keys(provider), provider }, credentialReferences }
}
