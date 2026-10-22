#!/usr/bin/env node
import { connect } from 'node:net'
import { randomUUID } from 'node:crypto'

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
  status`

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

function main(argv) {
  const socketIndex = argv.indexOf('--socket')
  if (socketIndex < 0 || socketIndex + 1 >= argv.length) fail('--socket <path> is required')
  const socketPath = argv[socketIndex + 1]
  argv = [...argv.slice(0, socketIndex), ...argv.slice(socketIndex + 2)]
  const domain = arg(argv, 'group', 'subcommand')
  const op = arg(argv, domain, `${domain} subcommand`)
  const id = () => randomUUID()

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
      create: () => ({ kind: 'issue.create', requestId: id(), commitId: id(), groupId: arg(argv, 'issue create', 'groupId'), vikunjaProjectId: arg(argv, 'issue create', 'projectId'), title: arg(argv, 'issue create', 'title'), body: argv.join(' ') }),
      reference: () => ({ kind: 'issue.reference', requestId: id(), commitId: id(), groupId: arg(argv, 'issue reference', 'groupId'), vikunjaIssueId: arg(argv, 'issue reference', 'issueId') }),
      query: () => ({ kind: 'issue.query', requestId: id(), sessionId: arg(argv, 'issue query', 'sessionId') }),
      close: () => ({ kind: 'issue.close', requestId: id(), commitId: id(), sessionId: arg(argv, 'issue close', 'sessionId'), reason: arg(argv, 'issue close', 'reason'), conclusion: arg(argv, 'issue close', 'conclusion') }),
      reopen: () => ({ kind: 'issue.reopen', requestId: id(), commitId: id(), sessionId: arg(argv, 'issue reopen', 'sessionId'), reason: arg(argv, 'issue reopen', 'reason') }),
    },
    action: {
      create: () => {
        const sessionId = arg(argv, 'action create', 'sessionId')
        const assigneeAgentId = arg(argv, 'action create', 'assignee')
        const kind = arg(argv, 'action create', 'kind')
        const reason = arg(argv, 'action create', 'reason')
        const expectedResult = arg(argv, 'action create', 'expectedResult')
        const reply = argv.includes('--reply')
        return { kind: 'action.create', requestId: id(), commitId: id(), sessionId, assigneeAgentId, actionKind: kind, reason, expectedResult, replyRequired: reply }
      },
      submit: () => ({ kind: 'action.submit', requestId: id(), resultCommitId: id(), actionId: arg(argv, 'action submit', 'actionId'), resultBody: argv.join(' ') }),
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
        return {
          kind: 'message.send', requestId: id(), commitId: id(), groupId,
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
