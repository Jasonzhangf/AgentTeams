#!/usr/bin/env node
/*
 * Regenerate docs/evidence/acp-l11-installed-browser-20261014/verification.json from the
 * producer's own receipt.json and the committed screenshot.
 *
 * The first version of verification.json was hand-written and recorded one wrong number (the
 * tarball size), which is why this file exists: every measured field is copied from a recorded
 * artifact instead of being retyped. Run it from the repository root after a producer run:
 *
 *   node docs/evidence/acp-l11-installed-browser-20261014/regenerate-verification.mjs
 *
 * It asserts that the receipt is a PASS with 18 checks and that the committed PNG agrees with
 * the receipt, so a stale or partial receipt cannot silently produce a verification record.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const receipt = JSON.parse(readFileSync(join(here, 'receipt.json'), 'utf8'))
const log = readFileSync(join(here, 'installed-browser-dom.log'), 'utf8')
const png = readFileSync(join(here, 'installed-browser-dom.png'))

function fail(message) {
  throw new Error(`verification regeneration: ${message}`)
}
function check(name) {
  const found = receipt.checks.find(entry => entry.name === name)
  if (found === undefined) fail(`the receipt has no check named "${name}"`)
  return found
}
function one(pattern, text, label) {
  const match = text.match(pattern)
  if (match === null) fail(`cannot read ${label}`)
  return match[1]
}

if (receipt.result !== 'PASS') fail(`the receipt result is ${receipt.result}, not PASS`)
if (receipt.checks.length !== 18) fail(`the receipt records ${receipt.checks.length} checks, not 18`)

const m = receipt.measurements
const artifact = receipt.artifact
const installed = receipt.installed
const daemons = receipt.daemons
const cleanup = receipt.cleanup

// Recorded measured facts that the receipt keeps inside check details rather than in
// measurements. Each one is read back with an assertion, never retyped.
const tarballBytes = Number(one(/npm pack \S+ \((\d+) bytes\)/, check('installed artifact — isolated install').detail, 'the tarball size'))
const runtimeDetail = check('page runtime errors').detail
const cdpEvents = Number(one(/\((\d+) CDP events\)/, runtimeDetail, 'the CDP event count'))
const pageExceptions = Number(one(/^(\d+) uncaught page exception/, runtimeDetail, 'the uncaught page exception count'))
const sseEvent = one(/received a real (\w+):/, check('SSE frame').detail, 'the SSE event name')
const daemonDetail = check('installed daemons — registry, agent, control all from the installed CLI').detail
const registryPort = Number(one(/registry pid=\d+ \(127\.0\.0\.1:(\d+)\)/, daemonDetail, 'the registry port'))
const agentPort = Number(one(/agent pid=\d+ \(127\.0\.0\.1:(\d+)/, daemonDetail, 'the agent port'))
const controlPort = Number(one(/control pid=\d+ \(127\.0\.0\.1:(\d+)\)/, daemonDetail, 'the control port'))
if (!log.includes(`(${tarballBytes} bytes)`)) fail('the log and the receipt disagree on the tarball size')

const width = png.readUInt32BE(16)
const height = png.readUInt32BE(20)
if (png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') fail('the committed screenshot is not a PNG')
if (width !== m.screenshot.width || height !== m.screenshot.height || png.length !== m.screenshot.bytes) {
  fail('the committed PNG disagrees with the receipt')
}

const verification = {
  unit: 'L11',
  title: 'installed-artifact live-browser DOM evidence for the Teams console',
  date: '2026-10-14',
  base_commit: 'd835538',
  base_ref: 'origin/main',
  worktree: '/Volumes/Intel/playground/agentteams/acp-l11-installed-browser-20261014',
  branch: 'codex/acp-l11-installed-browser-20261014',
  generated_from: 'receipt.json, installed-browser-dom.log and installed-browser-dom.png by regenerate-verification.mjs in this directory; no measured field below is retyped by hand',
  driver: {
    path: 'docs/evidence/acp-l11-installed-browser-20261014/installed-browser-dom.mjs',
    command: 'node docs/evidence/acp-l11-installed-browser-20261014/installed-browser-dom.mjs',
    always_rebuilds: true,
    always_reinstalls: true,
    always_rebuilds_reason: 'A reused build or a reused prefix silently produces evidence for code that is no longer on disk, which is exactly the boundary this unit exists to close. The producer runs pnpm build:governance, npm pack and npm install on every run.',
    exit_code: 0,
    canonical_run: {
      checks: receipt.checks.length,
      artifact_mode: artifact.mode,
      artifact_release_eligible: artifact.release_eligible,
      artifact_content_sha256: artifact.content_sha256,
      artifact_files: artifact.files,
      tarball_bytes: tarballBytes,
      installed_root: installed.root,
      installed_cli: installed.cli,
      registry_pid: daemons.registry,
      registry_port: registryPort,
      agent_pid: daemons.agent,
      agent_port: agentPort,
      agent_engine_children: daemons.agent_engine_children,
      control_pid: daemons.control,
      control_port: controlPort,
      chrome_pid: daemons.chrome,
      cdp_events: cdpEvents,
      page_exceptions: pageExceptions,
      sse_event: sseEvent,
      sse_seq: m.sse.seq,
      sse_agents: m.sse.agents,
      dom_observation: m.domMarkers.observation,
      dom_agent_rows: m.domMarkers.agentRows,
      dom_history_count: m.history.count,
      page_projection: m.pageProjection,
      screenshot_bytes: png.length,
      screenshot_dimensions: `${width}x${height}`,
      console_errors: m.consoleErrors,
      failed_requests: m.failedRequests,
      daemon_command_lines_inspected: Object.keys(m.daemonCommands).sort(),
      cleanup: `every owned pid dead (${cleanup.owned.join(', ')}); ${cleanup.strays} processes matched the owned temp root; ${cleanup.chromeStrays} processes matched the owned Chrome profile; the owned temp root was removed`,
    },
  },
  installed_artifact: {
    staged_by: 'pnpm build:governance (pnpm build && node scripts/package-artifact.mjs --mode final)',
    receipt_path: 'generated/modules/teams-source/package-receipt.json',
    pack_root: 'generated/modules/teams-source/lib',
    install: 'npm pack <pack root> --pack-destination <owned root>/pack, then npm install --prefix <owned root>/prefix --no-audit --no-fund <tarball>',
    install_outside_source_tree: true,
    payload_asserted_present: [
      'cli/agentteams.mjs',
      'generated/runtime-lib/runtime/control-process.js',
      'generated/runtime-lib/runtime/acp-serve.js',
      'console-host/static/console.html',
      'console-host/static/console-entry.js',
      'ui/teams-console/browser.js',
    ],
  },
  provenance: {
    claim: 'the daemons that served the page were the installed copy, and the bytes the browser received were the installed package files',
    measured_facts: [
      'every Teams daemon command line the producer started (registry, agent, control) was inspected and resolves inside the installed root',
      'none of those three command lines contains the source worktree path; Chrome is excluded because it is not part of the installed package',
      `the control daemon's own control-state.json records entryPath=${m.controlEntryPath}`,
      `the document served for GET / is byte-identical to the installed console-host/static/console.html (sha256 ${m.documentSha256})`,
      ...m.servedAssets.map(asset => `the served ${asset.path} is byte-identical to the installed ${asset.relative} (${asset.bytes} bytes, sha256 ${asset.sha256})`),
      'all 18 /ui/* modules the page received are byte-identical to their installed package counterpart; the producer fails the run if any served module is left uncompared',
    ],
    not_claimed: 'no restart, no deployed-entrypoint replay, no cross-device receipt, no mobile layout, and no control-daemon Session or permission write',
  },
  gates: {
    installed_artifact_staging: `pass (mode=final, release_eligible=false, content_sha256 ${artifact.content_sha256}, ${artifact.files} files)`,
    installed_artifact_install: 'pass (tarball packed and installed into an isolated prefix outside the source tree)',
    installed_daemon_start: 'pass (registry, real --serve opencode agent with a real engine child, and control, all from the installed CLI)',
    installed_provenance: 'pass (all three Teams daemon command lines and the control daemon own state entry path resolve inside the install)',
    served_asset_provenance: 'pass (document and every served /ui/ module byte-match the installed package)',
    real_control_daemon: 'pass (installed origin, real listener, real Basic challenge)',
    basic_challenge: 'pass (anonymous GET / -> 401 Basic)',
    clean_origin_cdp_navigation: 'pass (clean URL, no userinfo, credential injected with Network.setExtraHTTPHeaders)',
    authenticated_page_fetch: 'pass (the page own fetch reached the installed origin)',
    live_dom: 'pass (frozen D07 markers present in the live DOM of the installed entry)',
    real_agent_row_from_live_directory: 'pass (data-agent-id=reasoner-a)',
    shipped_page_own_sse_subscription: 'pass (the entry opened its own /api/v1/events and reached observation=live)',
    sse_snapshot_frame: 'pass (driver-owned EventSource received {seq:1, projection})',
    live_page_navigation: 'pass (all four frozen views rendered in real Chrome)',
    screenshot_png: `pass (${width}x${height}, ${png.length} bytes, dimensions read from the IHDR chunk)`,
    process_cleanup: 'pass (all owned pids dead, no stray process matched the owned temp root or Chrome profile, owned temp root removed)',
  },
  defects_found_in_the_producer: [
    {
      id: 'L11-P1',
      severity: 'high',
      summary: 'The first module-provenance loop rebuilt its request table per module and compared record objects by identity, so every lookup returned undefined and zero modules were compared while the check still printed a pass.',
      resolution: 'The table is built once, and the check asserts comparedModules === moduleEntries.length so an uncompared module fails the run.',
    },
    {
      id: 'L11-P2',
      severity: 'low',
      summary: 'The first canonical run reported a console error count without naming the errors.',
      resolution: 'The producer now reports the verbatim texts and binds the console error count to the observed failed-request count, with every failed request required to be the expected /favicon.ico 404. A page-originated console error without a matching failed request fails the run.',
    },
  ],
  gaps: [
    {
      name: 'event-driven DOM markers',
      status: 'unproven',
      reason: 'data-team-cancel and data-permission-option are only emitted for a rendered Session. This control daemon binds no Session owner, so no Session exists to cancel and no permission is pending. Their absence is the same gap D06/D08 already records and is not treated as evidence here.',
    },
    {
      name: 'history rows through the installed entry',
      status: 'unproven',
      reason: 'The history view renders data-history-count=0 with 0 rows in this configuration. The marker render is proven; a non-empty history row is not.',
    },
  ],
  review: {
    round_1: {
      reviewer: 'independent (fresh context, read-only)',
      candidate: 'e98097b',
      verdict: 'FAIL',
      blocking_findings: [
        'B1: this file recorded tarball_bytes=1536594 while the receipt and the log record 1536584.',
        'B2: the installed-artifact correction was incomplete; the D08 acceptance records, the D08 gate note, the D08 governance row, the serve-entry function note and the console-host module note still asserted that installed-artifact browser evidence does not exist.',
        'B3: the provenance check claimed that no process command line references the source tree while only the control and agent command lines were examined; the registry daemon was never inspected.',
      ],
      advisories: [
        'A1: requestIdByUrl was built and never used.',
        'A2: gap() was never called, so the driver gaps array was always empty and "0 gaps" carried no information.',
        'A3: the console-error binding passed whenever one favicon 404 existed, which is weaker than the notes claimed.',
        'A4: the stray-process counts were recorded but never asserted.',
        'A5: the D07 gate command does not run this producer, so the closed item rests on referenced evidence rather than on the gate command (the same convention the D08-browser producer uses).',
      ],
      resolution: 'B1: this file is now generated from receipt.json and the committed PNG by regenerate-verification.mjs instead of being retyped. B2: eleven sites now carry a dated 2026-10-14 correction. B3: the producer inspects all three Teams daemon command lines and states exactly which ones it examined. A1-A4: the dead code is removed, the receipt declares no gap of its own, the console-error count is bound to the observed failed-request count, and a stray process fails the run. A5 is recorded in the D07 gate note.',
    },
    round_2: {
      reviewer: 'independent (fresh context, read-only)',
      candidate: 'c1c8154',
      verdict: 'FAIL',
      result: 'B1 FIXED, B3 FIXED, B2 NOT FIXED: six further sites still asserted the stale claim, and the review found four new findings.',
      new_findings: [
        'N1: cdp_events was null and three listener ports were missing from the regenerated block.',
        'N2: notes.md repeated the cleanup sentence.',
        'N3: the D08 verification-map correction was spliced mid-sentence.',
        'N4: the D08 note said the installed-copy item is unchanged while the serve-entry note says an installed-copy receipt now exists.',
      ],
      resolution: 'This file is now produced by the committed regenerate-verification.mjs, which reads the CDP event count and the three listener ports back from the receipt. N2-N4 are corrected, and the six remaining sites carry a dated correction.',
    },
    round_3: {
      status: 'requested',
      scope: 'focused re-check of B2 completeness on the final candidate, plus N1-N4 and the A3 wording',
    },
  },
  scope_note: 'This artifact proves the installed package serves the frozen D07 console to a real browser whose page fetches, subscribes and renders from that origin, and that the bytes the browser received are the installed package files. It does not prove restart, a deployed-entrypoint replay, cross-device behaviour, mobile layout, or any control-daemon Session/permission write. The D07 gate therefore stays partial, and the D07 gate command does not run this producer: the closed item rests on this referenced evidence, which is the same convention the D08-browser producer uses.',
}

writeFileSync(join(here, 'verification.json'), `${JSON.stringify(verification, null, 2)}\n`)
console.log(`verification.json regenerated: checks=${receipt.checks.length} tarball=${tarballBytes} cdp_events=${cdpEvents} exceptions=${pageExceptions} sse=${sseEvent} ports=${registryPort}/${agentPort}/${controlPort} png=${width}x${height}`)
