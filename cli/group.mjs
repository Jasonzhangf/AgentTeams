#!/usr/bin/env node
import { connect } from 'node:net'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const usage = `usage: agentteams group <subcommand> [args] --socket <path>
  group create <name>
  group invite <groupId> <agentId> <role:master|peer>
  group accept <groupId>
  group decline <groupId>
  group leave <groupId>
  group list
  issue create <groupId> <projectId> <title> [body]
  issue reference <groupId> <issueId>
  issue query <sessionId>
  issue close <sessionId> <reason> <conclusion>
  issue reopen <sessionId> <reason>
  action create <sessionId> <assignee> <kind> <reason> <expectedResult> [--reply]
  action submit <actionId> <resultBody>
  action report <actionId> blocked|failed <reason>
  action refuse <actionId> <reason>
  action list [sessionId]
  msg send <groupId> <body> [--action <actionId>] [--reply]
  msg inbox <groupId> [--cursor n]
  status
Mutating commands accept --commit <id>; without it a retry reuses the pending
commit until the daemon replies once.`

function fail(message) {
  process.stderr.write(`${message}\n${usage}\n`)
  process.exitCode = 1
  throw new Error(message)
}

function arg(argv, name, label) {
  const value = argv.shift()
  if (value === undefined || value === '') fail(`${label} is required for ${name}`)
  return value
}

/**
 * A CLI retry must reuse the same commit id. Each mutating frame gets a pending
 * intent file keyed by the command signature; a timeout or transport error keeps
 * it, a parsed reply clears it. `--commit <id>` forces one explicit id.
 */
const pendingRoot = join(homedir(), '.agentteams', 'cli-pending')
function intentSignature(socketPath, frame) {
  const stable = { socketPath, ...frame }
  delete stable.requestId
  delete stable.commitId
  delete stable.resultCommitId
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex')
}
function pendingFile(signature) {
  return join(pendingRoot, `${signature}.json`)
}
function reuseCommit(signature, key, explicit) {
  if (explicit !== undefined) return explicit
  try {
    const record = JSON.parse(readFileSync(pendingFile(signature), 'utf8'))
    const value = record[key]
    if (typeof value === 'string' && value.length > 0) return value
  } catch {
    return undefined
  }
  return undefined
}
function rememberCommit(signature, key, value) {
  try {
    mkdirSync(pendingRoot, { recursive: true })
    let record = {}
    try { record = JSON.parse(readFileSync(pendingFile(signature), 'utf8')) } catch {}
    record[key] = value
    writeFileSync(pendingFile(signature), `${JSON.stringify(record)}\n`)
  } catch {}
}
function clearCommit(signature) {
  try { rmSync(pendingFile(signature)) } catch {}
}
function commitFlag(argv, label) {
  const flag = argv.indexOf('--commit')
  if (flag < 0) return undefined
  const value = argv[flag + 1]
  if (value === undefined || value === '') fail(`${label}: --commit requires a value`)
  argv.splice(flag, 2)
  return value
}

function request(socketPath, frame, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath)
    let buffer = ''
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`no reply within ${timeoutMs}ms`))
    }, timeoutMs)
    socket.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    socket.on('data', (chunk) => {
      buffer += chunk.toString()
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      clearTimeout(timer)
      const line = buffer.slice(0, newline)
      socket.destroy()
      let parsed
      try {
        parsed = JSON.parse(line)
      } catch {
        reject(new Error('invalid reply from daemon'))
        return
      }
      resolve(parsed)
    })
    socket.on('connect', () => {
      socket.write(`${JSON.stringify(frame)}\n`)
    })
  })
}

let pendingSignature

function main(argv) {
  const socketIndex = argv.indexOf('--socket')
  if (socketIndex < 0 || socketIndex + 1 >= argv.length) fail('--socket <path> is required')
  const socketPath = argv[socketIndex + 1]
  argv = [...argv.slice(0, socketIndex), ...argv.slice(socketIndex + 2)]
  const domain = arg(argv, 'group', 'subcommand')
  const op = arg(argv, domain, `${domain} subcommand`)
  const id = () => randomUUID()
  const stableCommit = (frame, key = 'commitId') => {
    const signature = intentSignature(socketPath, frame)
    const reused = reuseCommit(signature, key, commitFlag(argv, `${domain} ${op}`))
    const commit = reused ?? id()
    rememberCommit(signature, key, commit)
    pendingSignature = signature
    return commit
  }

  const frames = {
    group: {
      create: () => ({ kind: 'group.create', requestId: id(), name: arg(argv, 'group create', 'name') }),
      invite: () => {
        const groupId = arg(argv, 'group invite', 'groupId')
        const agentId = arg(argv, 'group invite', 'agentId')
        const role = arg(argv, 'group invite', 'role')
        const flag = argv.indexOf('--masters')
        const masters = flag >= 0 ? argv[flag + 1].split(',').filter((value) => value.length > 0) : []
        return { kind: 'group.invite', requestId: id(), groupId, agentId, role, ...(masters.length === 0 ? {} : { mastersOf: masters }) }
      },
      accept: () => ({ kind: 'group.respond', requestId: id(), groupId: arg(argv, 'group accept', 'groupId'), accept: true }),
      decline: () => ({ kind: 'group.respond', requestId: id(), groupId: arg(argv, 'group decline', 'groupId'), accept: false }),
      leave: () => ({ kind: 'group.leave', requestId: id(), groupId: arg(argv, 'group leave', 'groupId') }),
      list: () => ({ kind: 'group.list', requestId: id() }),
    },
    issue: {
      create: () => {
        const groupId = arg(argv, 'issue create', 'groupId')
        const vikunjaProjectId = arg(argv, 'issue create', 'projectId')
        const title = arg(argv, 'issue create', 'title')
        const body = argv.join(' ')
        return { kind: 'issue.create', requestId: id(), commitId: stableCommit({ groupId, vikunjaProjectId, title, body }), groupId, vikunjaProjectId, title, body }
      },
      reference: () => {
        const groupId = arg(argv, 'issue reference', 'groupId')
        const vikunjaIssueId = arg(argv, 'issue reference', 'issueId')
        return { kind: 'issue.reference', requestId: id(), commitId: stableCommit({ groupId, vikunjaIssueId }), groupId, vikunjaIssueId }
      },
      query: () => ({ kind: 'issue.query', requestId: id(), sessionId: arg(argv, 'issue query', 'sessionId') }),
      close: () => {
        const sessionId = arg(argv, 'issue close', 'sessionId')
        const reason = arg(argv, 'issue close', 'reason')
        const conclusion = arg(argv, 'issue close', 'conclusion')
        return { kind: 'issue.close', requestId: id(), commitId: stableCommit({ sessionId, reason, conclusion }), sessionId, reason, conclusion }
      },
      reopen: () => {
        const sessionId = arg(argv, 'issue reopen', 'sessionId')
        const reason = arg(argv, 'issue reopen', 'reason')
        return { kind: 'issue.reopen', requestId: id(), commitId: stableCommit({ sessionId, reason }), sessionId, reason }
      },
    },
    action: {
      create: () => {
        const sessionId = arg(argv, 'action create', 'sessionId')
        const assigneeAgentId = arg(argv, 'action create', 'assignee')
        const kind = arg(argv, 'action create', 'kind')
        const reason = arg(argv, 'action create', 'reason')
        const expectedResult = arg(argv, 'action create', 'expectedResult')
        const reply = argv.includes('--reply')
        return { kind: 'action.create', requestId: id(), commitId: stableCommit({ sessionId, assigneeAgentId, actionKind: kind, reason, expectedResult, replyRequired: reply }), sessionId, assigneeAgentId, actionKind: kind, reason, expectedResult, replyRequired: reply }
      },
      submit: () => {
        const actionId = arg(argv, 'action submit', 'actionId')
        const resultBody = argv.join(' ')
        return { kind: 'action.submit', requestId: id(), resultCommitId: stableCommit({ actionId, resultBody }, 'resultCommitId'), actionId, resultBody }
      },
      report: () => ({ kind: 'action.report', requestId: id(), actionId: arg(argv, 'action report', 'actionId'), report: arg(argv, 'action report', 'blocked|failed'), reason: argv.join(' ') }),
      refuse: () => ({ kind: 'action.refuse', requestId: id(), actionId: arg(argv, 'action refuse', 'actionId'), reason: argv.join(' ') }),
      list: () => ({ kind: 'action.list', requestId: id(), ...(argv.length > 0 ? { sessionId: argv.shift() } : {}) }),
    },
    msg: {
      send: () => {
        const groupId = arg(argv, 'msg send', 'groupId')
        const body = arg(argv, 'msg send', 'body')
        const actionFlag = argv.indexOf('--action')
        const actionId = actionFlag >= 0 ? argv[actionFlag + 1] : undefined
        const reply = argv.includes('--reply')
        const commitId = stableCommit({ groupId, body, actionId: actionId ?? '', replyRequired: reply })
        return {
          kind: 'message.send', requestId: id(), commitId, groupId,
          ...(actionId === undefined ? {} : { actionId }),
          targetAgentIds: [], replyRequired: reply, body,
        }
      },
      inbox: () => {
        const groupId = arg(argv, 'msg inbox', 'groupId')
        const cursorFlag = argv.indexOf('--cursor')
        const cursor = cursorFlag >= 0 ? Number(argv[cursorFlag + 1]) : undefined
        return { kind: 'message.page', requestId: id(), groupId, ...(cursor === undefined ? {} : { cursor }) }
      },
    },
  }

  if (domain === 'status') return Promise.resolve({ kind: 'status', socketPath })
  const builder = frames[domain]?.[op]
  if (!builder) fail(`unknown ${domain} ${op}`)
  return request(socketPath, builder())
}

const argv = process.argv.slice(2)
main(argv)
  .then((reply) => {
    // A parsed reply means the daemon settled the intent; the next identical
    // command is a new intent. A timeout or transport failure keeps it.
    if (pendingSignature !== undefined) clearCommit(pendingSignature)
    if (reply.kind === 'relay.error') {
      process.stderr.write(`${reply.error?.code ?? 'ERROR'}: ${reply.error?.message ?? 'unknown'}\n`)
      process.exitCode = 1
      return
    }
    process.stdout.write(`${JSON.stringify(reply)}\n`)
  })
  .catch((error) => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  })
