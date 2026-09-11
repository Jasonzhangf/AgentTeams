import { describe, expect, it } from 'vitest'
import {
  assembleDirectWssTargetOptions,
  assembleRelayPeerRoute,
  assertPeerRouteBinding,
  PeerRouteError,
} from './peer-route.ts'

const snapshot = {
  accountId: 'account-a',
  generation: 7,
  confirmedGeneration: 7,
  peerStates: [{
    hostId: 'peer-host',
    agentId: 'peer-agent',
    scopeId: 'scope',
    generation: 12,
    presence: 'online' as const,
  }],
  hosts: [{
    hostId: 'peer-host',
    machineId: 'peer-machine',
    agentId: 'peer-agent',
    agentKind: 'custom' as const,
    accountId: 'account-a',
    capabilitiesRevision: 'cap-9',
    health: 'ready' as const,
    routeCandidates: [
      {
        candidateId: 'direct-1',
        kind: 'ipv4' as const,
        endpoint: 'wss://peer.example.test:8443',
        port: 8443,
        authRequired: true,
        lastSeenAt: '2026-09-09T00:00:00.000Z',
      },
      {
        candidateId: 'relay-1',
        kind: 'relay-ws' as const,
        endpoint: 'https://relay.example.test',
        authRequired: true,
        lastSeenAt: '2026-09-09T00:00:00.000Z',
      },
    ],
    updatedAt: '2026-09-09T00:00:00.000Z',
    lastSeenAt: '2026-09-09T00:00:00.000Z',
  }],
} as const

const transport = {
  credential: 'Bearer peer',
  ca: 'peer-ca',
  connectTimeoutMs: 1_000,
  maxMessageBytes: 4_096,
  maxBufferedBytes: 8_192,
  maxPendingFrames: 4,
}

const binding = {
  connectionId: 'peer-connection-1',
  connectionGeneration: 3,
}

const bindingContext = {
  ...binding,
  directoryGeneration: 7,
  targetGeneration: 12,
}

const common = {
  directory: snapshot,
  hostId: 'peer-host',
  targetGeneration: 12,
  protocolVersion: 1,
  source: { accountId: 'account', scopeId: 'scope', agentId: 'consumer-a' },
  admissionRef: 'direct:consumer-a',
  binding,
}

describe('network peer route contract', () => {
  it('keeps direct WSS route assembly typed and bound to one connection generation', () => {
    const options = assembleDirectWssTargetOptions({
      ...common,
      targetCandidateId: 'direct-1',
      transport,
      helloTimeoutMs: 900,
    })

    expect(options.transport.endpoint).toBe('wss://peer.example.test:8443')
    expect(options.kind).toBe('direct-wss')
    expect(options.peerRoute).toEqual({
      kind: 'direct-wss',
      ...binding,
      directoryGeneration: 7,
      targetGeneration: 12,
      candidateId: 'direct-1',
    })
    expect(() => assertPeerRouteBinding(options.peerRoute, bindingContext)).not.toThrow()
  })

  it('keeps relay selection separate from direct WSS transport', () => {
    const route = assembleRelayPeerRoute({
      ...common,
      targetCandidateId: 'relay-1',
    })

    expect(route).toEqual({
      kind: 'relay',
      peerRoute: {
        kind: 'relay-ws',
        ...binding,
        directoryGeneration: 7,
        targetGeneration: 12,
        candidateId: 'relay-1',
      },
      target: {
        hostId: 'peer-host',
        agentId: 'peer-agent',
        capabilitiesRevision: 'cap-9',
        targetGeneration: 12,
      },
    })
    expect(() => assembleDirectWssTargetOptions({
      ...common,
      targetCandidateId: 'relay-1',
      transport,
      helloTimeoutMs: 900,
    })).toThrow(/relay candidate/)
  })

  it('binds relay target generation to the confirmed directory peer state', () => {
    expect(() => assembleRelayPeerRoute({
      ...common,
      targetCandidateId: 'relay-1',
      targetGeneration: 13,
    })).toThrow(PeerRouteError)
    expect(() => assembleRelayPeerRoute({
      ...common,
      targetCandidateId: 'relay-1',
      targetGeneration: 13,
    })).toThrowError(new PeerRouteError('STALE_GENERATION', 'peer-route: target generation is stale for host peer-host'))
  })

  it('rejects a relay route that cannot bind its target generation', () => {
    expect(() => assembleRelayPeerRoute({
      ...common,
      directory: {
        ...snapshot,
        peerStates: [],
      },
      targetCandidateId: 'relay-1',
    })).toThrowError(new PeerRouteError('STALE_GENERATION', 'peer-route: confirmed directory peer generation is missing for host peer-host'))
  })

  it('rejects stale direct target generation when the directory carries peer generations', () => {
    expect(() => assembleDirectWssTargetOptions({
      ...common,
      targetCandidateId: 'direct-1',
      targetGeneration: 13,
      transport,
      helloTimeoutMs: 900,
    })).toThrowError(new PeerRouteError('STALE_GENERATION', 'peer-route: target generation is stale for host peer-host'))
  })

  it('rejects a direct route that cannot bind its target generation', () => {
    expect(() => assembleDirectWssTargetOptions({
      ...common,
      directory: {
        ...snapshot,
        peerStates: undefined,
      },
      targetCandidateId: 'direct-1',
      targetGeneration: 12,
      transport,
      helloTimeoutMs: 900,
    })).toThrowError(new PeerRouteError('STALE_GENERATION', 'peer-route: confirmed directory peer generation is missing for host peer-host'))
  })

  it('rejects a direct candidate in the relay route and stale or foreign bindings', () => {
    expect(() => assembleRelayPeerRoute({ ...common, targetCandidateId: 'direct-1' })).toThrow(/direct candidate/)

    expect(() => assertPeerRouteBinding({
      kind: 'direct-wss',
      ...binding,
      directoryGeneration: 7,
      targetGeneration: 12,
      candidateId: 'direct-1',
    }, { ...bindingContext, connectionId: 'other' })).toThrow(PeerRouteError)
    expect(() => assertPeerRouteBinding({
      kind: 'direct-wss',
      ...binding,
      directoryGeneration: 7,
      targetGeneration: 12,
      candidateId: 'direct-1',
    }, { ...bindingContext, connectionGeneration: 4 })).toThrow(PeerRouteError)
    expect(() => assertPeerRouteBinding({
      kind: 'direct-wss',
      ...binding,
      directoryGeneration: 7,
      targetGeneration: 12,
      candidateId: 'direct-1',
    }, { ...bindingContext, connectionGeneration: 4 })).toThrowError(new PeerRouteError('STALE_GENERATION', 'peer-route: connection generation is stale'))
    expect(() => assertPeerRouteBinding({
      kind: 'direct-wss',
      ...binding,
      directoryGeneration: 7,
      targetGeneration: 12,
      candidateId: 'direct-1',
    }, { ...bindingContext, directoryGeneration: 8 })).toThrow(/directory generation/)
    expect(() => assertPeerRouteBinding({
      kind: 'direct-wss',
      ...binding,
      directoryGeneration: 7,
      targetGeneration: 12,
      candidateId: 'direct-1',
    }, { ...bindingContext, targetGeneration: 13 })).toThrow(/target generation/)
    expect(() => assembleDirectWssTargetOptions({
      ...common,
      hostId: 'missing-peer',
      targetCandidateId: 'direct-1',
      transport,
      helloTimeoutMs: 900,
    })).toThrow(PeerRouteError)

    expect(() => assembleDirectWssTargetOptions({
      ...common,
      directory: {
        ...snapshot,
        hosts: [{
          ...snapshot.hosts[0],
          routeCandidates: [{ ...snapshot.hosts[0].routeCandidates[0], endpoint: 'https://peer.example.test:8443' }],
        }],
      },
      targetCandidateId: 'direct-1',
      transport,
      helloTimeoutMs: 900,
    })).toThrow(PeerRouteError)
  })
})
