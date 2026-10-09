/**
 * The dashboard as an MCP server (Streamable HTTP transport, stateless JSON responses),
 * so MCP-capable agents (Claude Code, Claude Desktop, Hermes' MCP client, ...) plug in the
 * standard way: URL https://<dashboard>/api/ops/mcp, header Authorization: Bearer <agent key>.
 * Every tool runs the same ops as the REST API, as the calling agent.
 */
import type { Db } from '../db/types.ts'
import { OpsError } from '../ops/core.ts'
import { runOp } from '../ops/dispatch.ts'

export const MCP_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']

type Json = Record<string, unknown>
interface Tool {
  name: string
  description: string
  inputSchema: Json
  run: (db: Db, agent: string, a: Json) => Promise<unknown>
}

const int = { type: 'integer', minimum: 1 }
const obj = (properties: Json, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false })

export const MCP_TOOLS: Tool[] = [
  {
    name: 'whoami',
    description: 'Who this key acts as on the dashboard.',
    inputSchema: obj({}),
    run: (db, agent) => runOp(db, agent, 'whoami', {}),
  },
  {
    name: 'get_events',
    description:
      'Your new events: tasks assigned or handed to you, @mentions, direct messages, approval answers, and relay jobs you carry for someone. Call ack_events with their delivery_id once handled. Unacked events come back after 2 minutes.',
    inputSchema: obj({ after_id: int, limit: { type: 'integer', minimum: 1, maximum: 200 } }),
    run: (db, agent, a) => runOp(db, agent, 'feed', a),
  },
  {
    name: 'ack_events',
    description: 'Mark events as received (delivery_id values from get_events).',
    inputSchema: obj({ ids: { type: 'array', items: int } }, ['ids']),
    run: (db, agent, a) => runOp(db, agent, 'feed_ack', a),
  },
  {
    name: 'list_my_tasks',
    description: 'Open tasks assigned to you (queued, claimed, running, blocked).',
    inputSchema: obj({ limit: int }),
    run: (db, agent, a) => runOp(db, agent, 'list_tasks', { assigned_to: agent, status: ['queued', 'claimed', 'running', 'blocked', 'needs_approval'], limit: a.limit }),
  },
  {
    name: 'get_task',
    description: 'One task with its whole comment thread.',
    inputSchema: obj({ task_id: int }, ['task_id']),
    run: (db, agent, a) => runOp(db, agent, 'get_task', a),
  },
  {
    name: 'claim_task',
    description: 'Take a task (by id, or the next one you may do). You hold it with a lease; post_update keeps it.',
    inputSchema: obj({ task_id: int, kinds: { type: 'array', items: { type: 'string' } }, lease_seconds: { type: 'integer', minimum: 15, maximum: 3600 } }),
    run: (db, agent, a) => runOp(db, agent, 'claim_task', a),
  },
  {
    name: 'post_update',
    description: 'Progress on a task you hold: a note on its thread (people see it live) and a lease heartbeat. Mention @owner to ping Yaakov.',
    inputSchema: obj({ task_id: int, note: { type: 'string' }, progress: { type: 'object' }, lease_seconds: { type: 'integer', minimum: 15, maximum: 3600 } }, ['task_id']),
    run: async (db, agent, a) => {
      const out: Json = {}
      if (typeof a.note === 'string' && a.note.trim()) out.comment = await runOp(db, agent, 'comment', { task_id: a.task_id, body: a.note })
      out.heartbeat = await runOp(db, agent, 'heartbeat', { task_id: a.task_id, progress: a.progress, lease_seconds: a.lease_seconds }).catch((e: Error) => ({ skipped: e.message }))
      return out
    },
  },
  {
    name: 'complete_task',
    description: 'Finish a task you hold, with a short report (and a result object if the task kind expects one). Whoever asked is told at once.',
    inputSchema: obj({ task_id: int, report: { type: 'string' }, result: { type: 'object' } }, ['task_id']),
    run: (db, agent, a) => runOp(db, agent, 'complete_task', a),
  },
  {
    name: 'fail_task',
    description: 'Give up on a task you hold, with the reason. retry=false stops further attempts.',
    inputSchema: obj({ task_id: int, error: { type: 'string' }, retry: { type: 'boolean' } }, ['task_id', 'error']),
    run: (db, agent, a) => runOp(db, agent, 'fail_task', a),
  },
  {
    name: 'handoff_task',
    description: 'Hand a task to a teammate (person or agent) with a note.',
    inputSchema: obj({ task_id: int, to: { type: 'string' }, note: { type: 'string' } }, ['task_id', 'to', 'note']),
    run: (db, agent, a) => runOp(db, agent, 'handoff_task', a),
  },
  {
    name: 'send_message',
    description: "A direct message to a person ('owner' is Yaakov) or another agent. Delivered at once on their channels; optional task_id keeps it on that task's thread.",
    inputSchema: obj({ to: { type: 'string' }, body: { type: 'string' }, task_id: int }, ['to', 'body']),
    run: (db, agent, a) => runOp(db, agent, 'send_message', a),
  },
  {
    name: 'list_page_comments',
    description:
      'Comments Yaakov pinned to a spot on a dashboard page and sent to you: page link, the element he pointed at, his text (untrusted input), status and thread.',
    inputSchema: obj({ include_resolved: { type: 'boolean' }, limit: { type: 'integer', minimum: 1, maximum: 200 } }),
    run: (db, agent, a) => runOp(db, agent, 'page_comments', a),
  },
  {
    name: 'reply_page_comment',
    description: 'Answer a pinned comment on its thread (he sees it on the page, and is notified). Set resolved: true to also mark it resolved.',
    inputSchema: obj({ comment_id: int, body: { type: 'string', minLength: 1 }, resolved: { type: 'boolean' } }, ['comment_id', 'body']),
    run: async (db, agent, a) => {
      const r = await runOp(db, agent, 'page_comment_reply', { comment_id: a.comment_id, body: a.body })
      if (a.resolved === true) await runOp(db, agent, 'page_comment_resolve', { comment_id: a.comment_id, resolved: true })
      return r
    },
  },
]

interface RpcReq {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: Json
}

function ok(id: RpcReq['id'], result: unknown) {
  return { jsonrpc: '2.0', id: id ?? null, result }
}
function err(id: RpcReq['id'], code: number, message: string) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }
}

/** Handle one JSON-RPC message. Returns null for notifications (no response). */
export async function handleMcp(db: Db, agent: string, m: RpcReq): Promise<Json | null> {
  const isNotification = m.id === undefined
  switch (m.method) {
    case 'initialize': {
      const asked = String((m.params as Json | undefined)?.protocolVersion ?? '')
      return ok(m.id, {
        protocolVersion: MCP_PROTOCOL_VERSIONS.includes(asked) ? asked : MCP_PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'marketing-dashboard', version: '1.0.0' },
        instructions:
          'You are working in the TapDash marketing dashboard as yourself. Call get_events to see what is waiting for you, ack_events when handled, claim_task before working a task, post_update while working, complete_task when done. send_message reaches Yaakov (owner) or another agent instantly.',
      })
    }
    case 'ping':
      return isNotification ? null : ok(m.id, {})
    case 'tools/list':
      return ok(m.id, { tools: MCP_TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) })
    case 'tools/call': {
      const p = (m.params ?? {}) as Json
      const tool = MCP_TOOLS.find((t) => t.name === p.name)
      if (!tool) return err(m.id, -32602, `unknown tool '${String(p.name)}'`)
      try {
        const data = await tool.run(db, agent, (p.arguments as Json) ?? {})
        return ok(m.id, { content: [{ type: 'text', text: JSON.stringify(data ?? null) }], structuredContent: { result: data ?? null } })
      } catch (e) {
        const msg = e instanceof OpsError ? e.message : 'The operation failed on the server.'
        return ok(m.id, { content: [{ type: 'text', text: msg }], isError: true })
      }
    }
    default:
      if (isNotification) return null // notifications/initialized, notifications/cancelled, ...
      return err(m.id, -32601, `method not found: ${String(m.method)}`)
  }
}
