import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { startManagedOpenCode } from '/Volumes/extension/code/AgentTeams/runtime/managed-opencode.ts'
async function port(){const s=createServer();s.listen(0,'127.0.0.1');await once(s,'listening');const a=s.address();const p=typeof a==='object'&&a?a.port:0;await new Promise(r=>s.close(r));return p}
const root=await mkdtemp(join(tmpdir(),'teams-opencode-provider-live-'))
const goaiToken=process.env.GOAICHAT_TOKEN;if(typeof goaiToken!=='string'||goaiToken.length===0)throw new Error('GOAICHAT_TOKEN is required; provide it out of band')
const compiled={agentId:'live-provider-agent',acceptedRevision:5,primary:{provider:'rcc-4444',model:'gpt-5.5',protocol:'openai-chat',baseUrl:'http://127.0.0.1:4444/v1'},backup:{provider:'goaichat-openai',model:'qwen3.8-max',protocol:'openai-chat',baseUrl:'https://llm.goaichat.top/v1',credentialRef:'GOAICHAT_TOKEN'}}
let managed
async function run(label, target){
 const headers={authorization:managed.authorization,'content-type':'application/json'}
 const sr=await fetch(`${managed.url}/session`,{method:'POST',headers,body:JSON.stringify({title:`Teams ${label} probe`}),signal:AbortSignal.timeout(10000)})
 if(!sr.ok) throw new Error(`${label} session HTTP ${sr.status}: ${await sr.text()}`)
 const session=await sr.json(); const mr=await fetch(`${managed.url}/session/${session.id}/message`,{method:'POST',headers,body:JSON.stringify({parts:[{type:'text',text:`Reply with exactly teams-${label}-open-code`}],model:{providerID:target.provider,modelID:target.model}}),signal:AbortSignal.timeout(45000)})
 const body=await mr.text(); let parsed;try{parsed=JSON.parse(body)}catch{parsed={}}
 const text=Array.isArray(parsed.parts)?parsed.parts.filter(x=>x?.type==='text').map(x=>x.text||'').join(''):''
 return {request:{model:target},httpStatus:mr.status,ok:mr.ok,assistant:text.slice(0,200),responseModel:parsed.model,responseBodyPrefix:body.slice(0,500)}
}
try{
 managed=await startManagedOpenCode({executable:'/Users/fanzhang/.opencode/bin/opencode',directory:join(root,'opencode'),port:await port(),startupTimeoutMs:15000,stopTimeoutMs:5000,compiled,resolveCredential:async ref=>ref==='GOAICHAT_TOKEN'?goaiToken:(()=>{throw new Error('unexpected credential ref')})()})
 const primary=await run('rcc',compiled.primary)
 const backup=await run('goaichat',compiled.backup)
 console.log(JSON.stringify({primary,backup,acceptedRevision:compiled.acceptedRevision}))
}finally{
 let cleanupFailure
 try { await managed?.stop() } catch (error) { console.error(`cleanup failed: managed OpenCode stop: ${error instanceof Error ? error.message : String(error)}`); cleanupFailure=error }
 if (cleanupFailure) { console.error(`cleanup incomplete; preserving evidence runtime directory: ${root}`); throw cleanupFailure }
 await rm(root,{recursive:true,force:true})
}
