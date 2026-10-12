import type {
  ConsoleCapabilityDetail as CanonicalCapabilityDetail,
  ConsoleClientV1 as CanonicalClient,
  ConsoleCommandResultV1 as CanonicalCommandResult,
  ConsoleCommandV1 as CanonicalCommand,
  ConsoleProjectionV1 as CanonicalProjection,
  ConsoleProviderView as CanonicalProvider,
} from '../../../control-protocol/console-api.ts'
import type {
  ConsoleProjectionSink,
  ConsoleProjectionUnsubscribe,
  HistoryPage,
  HistoryQuery,
} from '../../../control-protocol/teams-state.ts'
import type {
  ConsoleCapabilityDetail as UiCapabilityDetail,
  ConsoleClientV1 as UiClient,
  ConsoleCommandResultV1 as UiCommandResult,
  ConsoleCommandV1 as UiCommand,
  ConsoleProjectionV1 as UiProjection,
  ConsoleProviderView as UiProvider,
  TeamsConsoleClientV1 as UiTeamsClient,
} from '../src/client/protocol.ts'
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

type Assert<T extends true> = T
type Compatible<Left, Right> = [Left] extends [Right] ? ([Right] extends [Left] ? true : false) : false
type AdditiveTeamsClient = CanonicalClient & {
  readonly readHistory: (query: HistoryQuery) => Promise<HistoryPage>
  readonly subscribeProjection: (sink: ConsoleProjectionSink) => ConsoleProjectionUnsubscribe
}
/**
 * These `Assert<Compatible<...>>` bindings are compile-time checks, not runtime checks: the D07
 * vitest gate transpiles without type-checking, so the two `it` blocks below cannot catch a
 * signature drift such as `TeamsConsoleClientV1.readHistory` returning `Promise<string>`.
 * `pnpm typecheck` and `pnpm --dir ui/teams-console typecheck` enforce them at this exact line
 * (a drifted signature makes the `_teamsClient` binding fail with TS2322). They are kept because
 * that declared gate does run, and a runtime assertion cannot bind the same failure mode.
 */
const _provider: Assert<Compatible<UiProvider, CanonicalProvider>> = true
const _detail: Assert<Compatible<UiCapabilityDetail, CanonicalCapabilityDetail>> = true
const _projection: Assert<Compatible<UiProjection, CanonicalProjection>> = true
const _command: Assert<Compatible<UiCommand, CanonicalCommand>> = true
const _result: Assert<Compatible<UiCommandResult, CanonicalCommandResult>> = true
const _client: Assert<Compatible<UiClient, CanonicalClient>> = true
const _teamsClient: Assert<Compatible<UiTeamsClient, AdditiveTeamsClient>> = true
const _projectionKeys: Assert<Compatible<keyof UiProjection, keyof CanonicalProjection>> = true

describe('contract compatibility', () => {
  it('keeps the UI adapter assignable to the frozen ConsoleClientV1 contract', () => {
    expect([_provider, _detail, _projection, _command, _result, _client, _projectionKeys]).toEqual([true, true, true, true, true, true, true])
  })

  it('keeps the additive D07 live client assignable to the canonical teams client', () => {
    expect(_teamsClient).toBe(true)
  })

  it('re-exports the canonical projection instead of declaring a UI fork', () => {
    const source = readFileSync(join(import.meta.dirname, '../src/client/protocol.ts'), 'utf8')
    expect(source).toContain("from '../../../../control-protocol/console-api.ts'")
    expect(source).not.toContain('interface ConsoleProjectionV1')
  })
})
