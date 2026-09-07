export const ENDPOINT_KINDS = ['browser', 'shell', 'filesystem', 'llm', 'device', 'service'] as const
export type EndpointKind = (typeof ENDPOINT_KINDS)[number]

export const ENDPOINT_LIFECYCLES = ['active', 'draining', 'disabled'] as const
export type EndpointLifecycle = (typeof ENDPOINT_LIFECYCLES)[number]

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue }

export interface OperationDescriptor {
  readonly operation: string
  readonly inputSchema: Readonly<Record<string, JsonValue>>
  readonly outputSchema: Readonly<Record<string, JsonValue>>
  readonly cancellation: 'unsupported' | 'cooperative'
}

export interface CapabilityDescriptor {
  readonly capabilityId: string
  readonly version: string
  readonly operations: readonly OperationDescriptor[]
}

export interface ResourceDescriptor {
  readonly resourceId: string
  readonly capacity: number
  readonly unit: 'slot' | 'context'
  readonly sharing: 'exclusive' | 'shared'
  readonly allocationScope: 'request' | 'work'
}

export interface EndpointDescriptor {
  readonly endpointId: string
  readonly ownerAgentId: string
  readonly kind: EndpointKind
  readonly label: string
  readonly revision: number
  readonly lifecycle: EndpointLifecycle
  readonly capabilities: readonly CapabilityDescriptor[]
  readonly resources: readonly ResourceDescriptor[]
}

/** Structural old Agent capability input. Compile is the only conversion entry. */
export interface LegacyAgentCapabilityInput {
  readonly capabilityId: string
  readonly version: string
  readonly operations: readonly OperationDescriptor[]
  readonly resources: readonly ResourceDescriptor[]
}

export interface CompileLegacyAgentCapabilitiesInput {
  readonly ownerAgentId: string
  readonly endpointId: string
  readonly kind: EndpointKind
  readonly label: string
  readonly capabilities: readonly LegacyAgentCapabilityInput[]
}

export interface EndpointRegistry {
  readonly endpoints: Map<string, EndpointDescriptor>
}
