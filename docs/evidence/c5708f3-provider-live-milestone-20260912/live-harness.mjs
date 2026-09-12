import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { createRelayServer } from '/Volumes/extension/code/AgentTeams/server/relay.ts'
import { createRelayClient } from '/Volumes/extension/code/AgentTeams/network/relay-client.ts'
import { createRelayConsoleClient } from '/Volumes/extension/code/AgentTeams/runtime/relay-console-client.ts'
import { startAgentProcess } from '/Volumes/extension/code/AgentTeams/runtime/agent-process.ts'

const root = await mkdtemp(join(tmpdir(), 'teams-provider-live-'))
let relay
let consumer
let agent
let restarted
const startedAt = new Date().toISOString()
async function port() {
  const s = createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening')
  const a = s.address(); const p = typeof a === 'object' && a ? a.port : 0
  await new Promise(resolve => s.close(resolve)); return p
}
const keyPath = join(root, 'key.pem'); const certPath = join(root, 'cert.pem')
execFileSync('openssl', ['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=localhost','-addext','subjectAltName=IP:127.0.0.1','-keyout',keyPath,'-out',certPath], {stdio:'ignore'})
const cert = await readFile(certPath)
const goaiToken = process.env.GOAICHAT_TOKEN
if (typeof goaiToken !== 'string' || goaiToken.length === 0) throw new Error('GOAICHAT_TOKEN is required; provide it out of band')
const relayAuth = credential => credential === 'Bearer console' ? { accountId:'account', scopeId:'scope', agentId:'console' } : credential === 'Bearer live-agent' ? { accountId:'account', scopeId:'scope', agentId:'live-provider-agent' } : null
try {
  relay = await createRelayServer({ host:'127.0.0.1', port:0, cert, key:await readFile(keyPath), maxPayload:131072, maxConnections:16, maxGrants:8, maxBufferedAmount:131072, maxPendingMessages:32, maxPendingBytes:262144, grantTtlMs:10000, authenticate: relayAuth })
  consumer = await createRelayClient({ transport:{ endpoint:relay.url, credential:'Bearer console', ca:cert, connectTimeoutMs:1000, maxMessageBytes:131072, maxBufferedBytes:131072, maxPendingFrames:32 }, declaration:{ identity:{ hostId:'console-host', machineId:'live', agentId:'console', accountId:'account', agentKind:'custom', label:'Console' }, scopeId:'scope', revision:1, capabilities:[], routes:[] }, admissionTimeoutMs:2000, requestTimeoutMs:5000, maxPendingRequests:16, maxDataConnections:8 })
  await mkdir(join(root,'search'), {recursive:true})
  const cfgPath = join(root,'agent.json'); const runtimePath = join(root,'runtime-config.json')
  const providerConfig = { revision:3, acceptedRevision:3,
    providers:{
      'rcc-4444':{ id:'rcc-4444', label:'RCC 4444', protocol:'openai-chat', apiBaseUrl:'http://127.0.0.1:4444/v1', enabled:true, auth:{kind:'none'} },
      'goaichat-openai':{ id:'goaichat-openai', label:'GoAIChat', protocol:'openai-chat', apiBaseUrl:'https://llm.goaichat.top/v1', enabled:true, auth:{kind:'bearer', credentialRef:'GOAICHAT_TOKEN'} },
    },
    catalogs:{
      'rcc-4444':{ state:'ready', entries:[{ ref:{providerInstanceId:'rcc-4444', modelId:'gpt-5.5'}, origin:'manual', base:{label:'RCC explicit'}, overrides:{} }] },
      'goaichat-openai':{ state:'ready', entries:[{ ref:{providerInstanceId:'goaichat-openai', modelId:'qwen3.8-max'}, origin:'manual', base:{label:'GoAIChat backup'}, overrides:{} }] },
    },
    agents:{ 'live-provider-agent':{ primary:{providerInstanceId:'rcc-4444', modelId:'gpt-5.5'}, backup:{providerInstanceId:'goaichat-openai', modelId:'qwen3.8-max'} } }
  }
  await writeFile(runtimePath, JSON.stringify(providerConfig))
  const agentConfig = { version:1, identity:{hostId:'live-provider-host', machineId:'live', agentId:'live-provider-agent', accountId:'account', agentKind:'custom', label:'Live Provider Agent'}, scopeId:'scope', dataDirectory:'./agent-data', leasePort:await port(), presenceIntervalMs:1000, policy:{revision:1, allowedConsumers:[], allowedManagers:['console']}, cli:{camoExecutable:'/missing/camo', searchExecutable:'/opt/homebrew/bin/rg', searchRoot:'./search', profilePrefix:'teams-live'}, relay:{endpoint:relay.url, credentialEnv:'TEAMS_RELAY', caFile:'./cert.pem', connectTimeoutMs:1000, admissionTimeoutMs:2000, requestTimeoutMs:5000, maxMessageBytes:131072, maxBufferedBytes:131072, maxPendingFrames:32, maxPendingRequests:16, maxDataConnections:8}, openCode:{executable:'/Users/fanzhang/.opencode/bin/opencode', directory:'./opencode', configFile:'./runtime-config.json', port:await port(), startupTimeoutMs:15000, stopTimeoutMs:5000} }
  await writeFile(join(root,'cert.pem'), cert)
  await writeFile(cfgPath, JSON.stringify(agentConfig))
  const env = {...process.env, TEAMS_RELAY:'Bearer live-agent', GOAICHAT_TOKEN:goaiToken}
  agent = await startAgentProcess(cfgPath, env)
  const management = createRelayConsoleClient(consumer, 'live-provider-agent', 10000)
  const before = await management.readProjection()
  const refreshRccRequest = {kind:'config.refreshModels', agentId:'live-provider-agent', expectedRevision:3, providerId:'rcc-4444'}
  const refreshRcc = await management.command(refreshRccRequest)
  const afterRcc = await management.readProjection()
  const rccState = afterRcc.configs[0]
  const refreshGoaiRequest = {kind:'config.refreshModels', agentId:'live-provider-agent', expectedRevision:rccState.acceptedRevision, providerId:'goaichat-openai'}
  const refreshGoai = await management.command(refreshGoaiRequest)
  const afterGoai = await management.readProjection()
  const goaiState = afterGoai.configs[0]
  const applyRequest = {kind:'config.apply', agentId:'live-provider-agent'}
  const apply = await management.command(applyRequest)
  const applied = await management.readProjection()
  const persistedAfterApply = JSON.parse(await readFile(runtimePath,'utf8'))
  await agent.stop(); agent = undefined
  restarted = await startAgentProcess(cfgPath, env)
  const management2 = createRelayConsoleClient(consumer, 'live-provider-agent', 10000)
  const afterRestart = await management2.readProjection()
  console.log(JSON.stringify({
    startedAt,
    relay: 'local TLS relay',
    before: before.configs[0]?.acceptedRevision,
    requests: [
      {request: refreshRccRequest, response: refreshRcc},
      {request: refreshGoaiRequest, response: refreshGoai},
      {request: applyRequest, response: apply},
    ],
    projections: {
      afterRcc: {acceptedRevision:rccState.acceptedRevision, provider:rccState.providers.find(p=>p.id==='rcc-4444')},
      afterGoai: {acceptedRevision:goaiState.acceptedRevision, provider:goaiState.providers.find(p=>p.id==='goaichat-openai')},
      applied: {acceptedRevision:applied.configs[0]?.acceptedRevision, effectiveRevision:applied.configs[0]?.effectiveRevision},
      restart: {acceptedRevision:afterRestart.configs[0]?.acceptedRevision, effectiveRevision:afterRestart.configs[0]?.effectiveRevision},
    },
    refreshRcc,
    rccCatalogState: rccState.providers.find(p=>p.id==='rcc-4444')?.catalogState,
    rccModels: rccState.providers.find(p=>p.id==='rcc-4444')?.models.map(m=>m.id),
    refreshGoai,
    goaiCatalogState: goaiState.providers.find(p=>p.id==='goaichat-openai')?.catalogState,
    goaiModelsCount: goaiState.providers.find(p=>p.id==='goaichat-openai')?.models.length,
    apply,
    appliedRevision: applied.configs[0]?.acceptedRevision,
    effectiveRevision: applied.configs[0]?.effectiveRevision,
    persisted:{acceptedRevision:persistedAfterApply.acceptedRevision,effectiveRevision:persistedAfterApply.effectiveRevision},
    restart:{acceptedRevision:afterRestart.configs[0]?.acceptedRevision,effectiveRevision:afterRestart.configs[0]?.effectiveRevision}
  }))
} finally {
  if (restarted) await restarted.stop().catch(()=>{})
  if (agent) await agent.stop().catch(()=>{})
  await consumer?.close().catch(()=>{})
  await relay?.close().catch(()=>{})
  await rm(root,{recursive:true,force:true})
}
