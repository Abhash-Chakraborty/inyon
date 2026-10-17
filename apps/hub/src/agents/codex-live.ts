import { shq } from '../hosts/host.ts'
import { PATHS } from '../features/setup.ts'
import type { LiveItem } from '@inyon/protocol'

/**
 * Codex's reply as it is being written. The TUI is a client of Codex's shared app-server daemon,
 * which other clients can join: `thread/resume` on a running thread rejoins it, and from then on
 * every delta, item and turn of that thread arrives as a notification. The daemon listens on
 * ~/.codex/app-server-control/app-server-control.sock and speaks WebSocket over it (`codex
 * app-server proxy` only forwards bytes), so a small node script on the machine does the framing
 * and prints what arrives as JSON lines. It ends when its stdin closes, which is how it's stopped.
 */
export const codexLiveScript = String.raw`
const net=require('node:net'),crypto=require('node:crypto'),os=require('node:os');
const thread=process.argv[1];
const home=process.env.CODEX_HOME||os.homedir()+'/.codex';
const out=(o)=>process.stdout.write(JSON.stringify(o)+'\n');
process.stdin.on('end',()=>process.exit(0));process.stdin.on('error',()=>process.exit(0));process.stdin.resume();
const sock=net.connect({path:home+'/app-server-control/app-server-control.sock'});
let up=false,buf=Buffer.alloc(0),parts=[],nextId=1;const pending=new Map();
function frame(op,payload){const mask=crypto.randomBytes(4),n=payload.length;let h;
if(n<126)h=Buffer.from([0x80|op,0x80|n]);else if(n<65536){h=Buffer.alloc(4);h[0]=0x80|op;h[1]=0xfe;h.writeUInt16BE(n,2);}else{h=Buffer.alloc(10);h[0]=0x80|op;h[1]=0xff;h.writeBigUInt64BE(BigInt(n),2);}
const m=Buffer.from(payload);for(let i=0;i<m.length;i++)m[i]^=mask[i&3];sock.write(Buffer.concat([h,mask,m]));}
const send=(msg)=>frame(1,Buffer.from(JSON.stringify(msg)));
const request=(method,params)=>new Promise((resolve)=>{const id=nextId++;pending.set(id,resolve);send({jsonrpc:'2.0',id,method,params});});
function frames(){while(buf.length>=2){const fin=(buf[0]&0x80)!==0,op=buf[0]&0x0f,masked=(buf[1]&0x80)!==0;let n=buf[1]&0x7f,off=2;
if(n===126){if(buf.length<4)return;n=buf.readUInt16BE(2);off=4;}else if(n===127){if(buf.length<10)return;n=Number(buf.readBigUInt64BE(2));off=10;}
if(masked)off+=4;if(buf.length<off+n)return;const payload=buf.subarray(off,off+n);buf=buf.subarray(off+n);
if(op===9)frame(10,payload);else if(op===8){out({e:'closed'});process.exit(1);}
else if(op===1||op===0){parts.push(Buffer.from(payload));if(fin){const text=Buffer.concat(parts).toString();parts=[];onText(text);}}}}
const DROP=new Set(['turn/moderationMetadata','thread/readState/changed','account/updated','remoteControl/status/changed','rawResponse/completed','rawResponseItem/completed','model/verification','model/safetyBuffering/updated']);
const children=new Set();
function onText(text){let m;try{m=JSON.parse(text)}catch{return}
if(m.id!==undefined&&!m.method){const r=pending.get(m.id);if(r){pending.delete(m.id);r(m);}return;}
const p=m.params||{};
if(m.method==='thread/started'){if(p.thread&&p.thread.parentThreadId===thread)children.add(p.thread.id);else if(!p.thread||p.thread.id!==thread)return;}
else if(p.threadId!==thread&&!children.has(p.threadId))return;
if(DROP.has(m.method))return;
// a request the daemon makes of its clients (an approval, a question): reported, never answered here, the TUI answers it
if(m.id!==undefined)out({m:m.method,p:p,req:true});else out({m:m.method,p:p});}
sock.on('connect',()=>{const key=crypto.randomBytes(16).toString('base64');sock.write('GET / HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: '+key+'\r\n\r\n');});
sock.on('data',(d)=>{buf=Buffer.concat([buf,d]);if(!up){const end=buf.indexOf('\r\n\r\n');if(end<0)return;const head=buf.subarray(0,end).toString();buf=buf.subarray(end+4);
if(!/ 101 /.test(head)){out({e:'refused',head:head.split('\n')[0]});process.exit(1);}up=true;ready();}frames();});
sock.on('error',(e)=>{out({e:'error',message:e.message});process.exit(1);});
sock.on('close',()=>{out({e:'closed'});process.exit(1);});
async function ready(){await request('initialize',{clientInfo:{name:'inyon',title:'Inyon',version:'0'},capabilities:{experimentalApi:true,requestAttestation:false}});send({jsonrpc:'2.0',method:'initialized',params:{}});
// the thread has no rollout until its first message, and can't be joined before then
for(;;){const r=await request('thread/resume',{threadId:thread,excludeTurns:true});
if(!r.error){const t=r.result||{};out({e:'resumed',model:t.model,effort:t.reasoningEffort,approval:t.approvalPolicy,tier:t.serviceTier,status:t.thread&&t.thread.status});return;}
out({e:'waiting',error:r.error.message});await new Promise((f)=>setTimeout(f,3000));}}
`

/** The command that follows thread `threadId` on the machine; stop it by closing its stdin. */
export const codexLiveCommand = (threadId: string) => `${PATHS}; node -e ${shq(codexLiveScript)} ${shq(threadId)}`

/** The thread a rollout file belongs to ("rollout-<time>-<thread>[_<segment>].jsonl"). */
export const codexThreadId = (path: string) =>
  path.split('/').pop()!.replace(/\.jsonl$/, '').replace(/^rollout-[\dT-]+-/, '').replace(/_[0-9a-f-]{36}$/, '')

export interface LiveChange {
  /** the live text changed */
  live?: boolean
  /** a turn started or ended */
  turn?: boolean
  /** the thread's status changed (working, idle, waiting for an approval or an answer) */
  status?: boolean
  /** token usage or limits were reported */
  usage?: boolean
  /** Codex (re)named the thread */
  name?: string
  /** the queue of follow-ups changed */
  queue?: boolean
  /** the daemon asked its clients something (an approval, a question) or one was answered */
  ask?: boolean
  /** a sub-agent started or finished */
  agents?: boolean
}

export interface LiveAgent {
  threadId: string
  description: string
  model?: string
  status: 'running' | 'done' | 'error'
  startedAt: string
}

const OUTPUT_KEEP = 4000

/**
 * What the live helper has said so far: the items being written (by id, oldest first), the turn
 * under way and the thread's status. `apply` takes one line of the helper's output and says what
 * changed, so the watcher knows what to publish.
 */
export class CodexLiveState {
  items = new Map<string, LiveItem>()
  /** items Codex has finished, with when, until their record shows up in the rollout */
  done = new Map<string, number>()
  turn?: { id: string; startedAt: number }
  status?: 'active' | 'idle' | 'notLoaded' | 'systemError'
  flags: string[] = []
  agents = new Map<string, LiveAgent>()
  /** settings reported when the thread was joined */
  settings?: { model?: string; effort?: string; tier?: string }
  private summaryIndex = new Map<string, number>()

  apply(line: string): LiveChange {
    let msg: any
    try {
      msg = JSON.parse(line)
    } catch {
      return {}
    }
    if (msg?.e === 'resumed') {
      this.settings = { model: msg.model ?? undefined, effort: msg.effort ?? undefined, tier: msg.tier ?? undefined }
      const t = msg.status?.type
      if (t) {
        this.status = t
        this.flags = msg.status.activeFlags ?? []
      }
      return { status: true }
    }
    if (typeof msg?.m !== 'string') return {}
    const p = msg.p ?? {}
    if (msg.req) return { ask: true }
    switch (msg.m as string) {
      case 'item/agentMessage/delta':
        return this.delta(p.itemId, 'text', p.delta, p.turnId)
      case 'item/plan/delta':
        return this.delta(p.itemId, 'plan', p.delta, p.turnId)
      case 'item/reasoning/summaryTextDelta': {
        // each summary is a paragraph of its own
        const prev = this.summaryIndex.get(p.itemId)
        const gap = prev !== undefined && p.summaryIndex !== prev && this.items.has(p.itemId)
        this.summaryIndex.set(p.itemId, p.summaryIndex)
        return this.delta(p.itemId, 'thinking', (gap ? '\n\n' : '') + p.delta, p.turnId)
      }
      case 'item/commandExecution/outputDelta':
        return this.delta(p.itemId, 'output', p.delta, p.turnId)
      case 'item/started': {
        const item = p.item ?? {}
        if (item.type === 'subAgentActivity' && item.kind === 'started') return this.agentStarted(item, p.startedAtMs)
        return {}
      }
      case 'item/completed': {
        const item = p.item ?? {}
        if (item.type === 'subAgentActivity') return this.agentEnded(item)
        const live = this.items.get(item.id)
        if (!live) return {}
        // the finished text, in case a delta went missing
        if (item.type === 'agentMessage' && typeof item.text === 'string' && item.text) live.text = item.text
        else if (item.type === 'reasoning' && Array.isArray(item.summary) && item.summary.length) live.text = item.summary.join('\n\n')
        else if (item.type === 'plan' && typeof item.text === 'string' && item.text) live.text = item.text
        this.done.set(item.id, p.completedAtMs ?? Date.now())
        return { live: true }
      }
      case 'turn/started':
        this.turn = { id: p.turn?.id, startedAt: (p.turn?.startedAt ?? Date.now() / 1000) * 1000 }
        return { turn: true }
      case 'turn/completed': {
        this.turn = undefined
        // whatever was still being written is over
        for (const [id, it] of this.items) if (it.turnId === p.turn?.id && !this.done.has(id)) this.done.set(id, Date.now())
        return { turn: true, live: true }
      }
      case 'thread/status/changed': {
        if (p.threadId && this.agents.has(p.threadId)) {
          const a = this.agents.get(p.threadId)!
          if (p.status?.type === 'idle' && a.status === 'running') a.status = 'done'
          if (p.status?.type === 'systemError') a.status = 'error'
          return { agents: true }
        }
        this.status = p.status?.type
        this.flags = p.status?.activeFlags ?? []
        return { status: true }
      }
      case 'thread/started': {
        const t = p.thread
        if (t?.parentThreadId && !this.agents.has(t.id)) {
          this.agents.set(t.id, { threadId: t.id, description: t.preview || 'Sub-agent', model: t.model ?? undefined, status: 'running', startedAt: new Date((t.createdAt ?? Date.now() / 1000) * 1000).toISOString() })
          return { agents: true }
        }
        return {}
      }
      case 'thread/tokenUsage/updated':
      case 'account/rateLimits/updated':
        return { usage: true }
      case 'thread/name/updated':
        return { name: p.threadName ?? '' }
      case 'thread/queue/changed':
        return { queue: true }
      case 'serverRequest/resolved':
        return { ask: true }
    }
    return {}
  }

  private delta(id: string, kind: LiveItem['kind'], text: string, turnId?: string): LiveChange {
    if (!id || typeof text !== 'string') return {}
    let it = this.items.get(id)
    if (!it) {
      it = { id, kind, text: '', turnId }
      this.items.set(id, it)
    }
    it.text += text
    // a command's output can run on for pages; the end is what's being watched
    if (kind === 'output' && it.text.length > OUTPUT_KEEP) it.text = it.text.slice(-OUTPUT_KEEP)
    this.done.delete(id)
    return { live: true }
  }

  private agentStarted(item: any, at?: number): LiveChange {
    const id = item.agentThreadId
    if (!id) return {}
    const cur = this.agents.get(id)
    this.agents.set(id, { threadId: id, description: cur?.description ?? item.agentPath ?? 'Sub-agent', model: item.model ?? cur?.model, status: 'running', startedAt: cur?.startedAt ?? new Date(at ?? Date.now()).toISOString() })
    return { agents: true }
  }

  private agentEnded(item: any): LiveChange {
    const a = this.agents.get(item.agentThreadId)
    if (!a) return {}
    if (item.kind === 'completed') a.status = 'done'
    else if (item.kind === 'interrupted') a.status = 'error'
    return { agents: true }
  }

  /**
   * A finished item's record arrived in the rollout (or it never will): drops the live copy.
   * Returns true when something was dropped.
   */
  settle(ids: (string | undefined)[]): boolean {
    let dropped = false
    for (const id of ids) {
      if (id && this.items.delete(id)) dropped = true
      if (id) this.done.delete(id)
    }
    return dropped
  }

  /** Drops finished items whose record hasn't shown up within `ms`; true when any went. */
  expire(ms: number, now = Date.now()): boolean {
    let dropped = false
    for (const [id, at] of this.done) {
      if (now - at < ms) continue
      this.items.delete(id)
      this.done.delete(id)
      dropped = true
    }
    return dropped
  }

  /** The items to show, oldest first, without the command output (that's for the working line). */
  list(): LiveItem[] {
    return [...this.items.values()].map((it) => ({ ...it }))
  }

  clear() {
    this.items.clear()
    this.done.clear()
    this.turn = undefined
    this.summaryIndex.clear()
  }
}
