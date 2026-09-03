export type BootstrapAuthMode = 'none' | 'shared-api-key' | 'shared-token'

export interface BootstrapLinkConfig {
  readonly endpoint: string
  readonly authMode: BootstrapAuthMode
  readonly credentialRef?: string
}

export interface LinkState {
  readonly status: 'connected' | 'disconnected'
  readonly generation: number
  readonly endpoint: string
}

export function resolveBootstrapLinkConfig(config: BootstrapLinkConfig): BootstrapLinkConfig {
  if (!config.endpoint.startsWith('http://') && !config.endpoint.startsWith('https://')) {
    throw new Error('network: endpoint must use http:// or https://')
  }
  if (config.authMode !== 'none' && config.credentialRef === undefined) {
    throw new Error('network: credentialRef is required for authenticated links')
  }
  return config
}

export function connectLink(config: BootstrapLinkConfig, previous?: LinkState): LinkState {
  const resolved = resolveBootstrapLinkConfig(config)
  return { status: 'connected', generation: (previous?.generation ?? 0) + 1, endpoint: resolved.endpoint }
}

export function closeLink(link: LinkState): LinkState {
  return { ...link, status: 'disconnected' }
}
