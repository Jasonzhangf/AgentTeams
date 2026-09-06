import type {
  ConsoleClientV1 as CanonicalClient,
  ConsoleCommandResultV1 as CanonicalCommandResult,
  ConsoleCommandV1 as CanonicalCommand,
  ConsoleProjectionV1 as CanonicalProjection,
  ConsoleProviderView as CanonicalProvider,
} from '../../../control-protocol/console-api.ts'
import type {
  ConsoleClientV1 as UiClient,
  ConsoleCommandResultV1 as UiCommandResult,
  ConsoleCommandV1 as UiCommand,
  ConsoleProjectionV1 as UiProjection,
  ConsoleProviderView as UiProvider,
} from '../src/client/protocol.ts'
import { describe, expect, it } from 'vitest'

type Assert<T extends true> = T
type Compatible<Left, Right> = [Left] extends [Right] ? ([Right] extends [Left] ? true : false) : false

const _provider: Assert<Compatible<UiProvider, CanonicalProvider>> = true
const _projection: Assert<Compatible<UiProjection, CanonicalProjection>> = true
const _command: Assert<Compatible<UiCommand, CanonicalCommand>> = true
const _result: Assert<Compatible<UiCommandResult, CanonicalCommandResult>> = true
const _client: Assert<Compatible<UiClient, CanonicalClient>> = true

describe('contract compatibility', () => {
  it('keeps the UI adapter assignable to the frozen ConsoleClientV1 contract', () => {
    expect([_provider, _projection, _command, _result, _client]).toEqual([true, true, true, true, true])
  })
})
