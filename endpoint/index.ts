export { compileLegacyAgentCapabilities } from './compile.ts'
export { fail, isEndpointError, type EndpointError, type EndpointErrorCode } from './errors.ts'
export {
  createEndpointRegistry,
  disableEndpoint,
  listEndpoints,
  registerEndpoint,
  requireCapability,
  requireResource,
  reviseEndpoint,
  useEndpoint,
} from './registry.ts'
export type {
  CapabilityDescriptor,
  CompileLegacyAgentCapabilitiesInput,
  EndpointDescriptor,
  EndpointKind,
  EndpointLifecycle,
  EndpointRegistry,
  LegacyAgentCapabilityInput,
  OperationDescriptor,
  ResourceDescriptor,
} from './types.ts'
export { validateEndpointDescriptor } from './validate.ts'
