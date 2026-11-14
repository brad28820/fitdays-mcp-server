import type { IncomingMessage, ServerResponse } from 'node:http'

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createServer } from 'node:http'

import type { FitDaysSession } from './fitdays.js'

import { getBaseUrl, handleOAuthRequest, loadOAuthConfig, verifyBearerToken } from './oauth.js'
import { buildServer } from './server.js'

const readJsonBody = async (req: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (!raw) return undefined
  return JSON.parse(raw) as unknown
}

const setCorsHeaders = (res: ServerResponse): void => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, mcp-session-id, mcp-protocol-version')
}

export const startHttpServer = async (
  session: FitDaysSession,
  fallbackPassword: string,
): Promise<void> => {
  const port = Number.parseInt(process.env.PORT ?? '8000', 10)
  const host = process.env.HOST ?? '0.0.0.0'
  const oauthConfig = loadOAuthConfig(fallbackPassword)

  const httpServer = createServer(async (req, res) => {
    setCorsHeaders(res)

    const url = new URL(req.url ?? '/', getBaseUrl(req))
    res.on('finish', () => {
      if (url.pathname !== '/health' && url.pathname !== '/healthz') {
        console.error(`${req.method ?? 'UNKNOWN'} ${url.pathname} -> ${String(res.statusCode)}`)
      }
    })

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    if (
      (req.method === 'GET' || req.method === 'HEAD') &&
      (url.pathname === '/health' || url.pathname === '/healthz' || url.pathname === '/')
    ) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      if (req.method === 'HEAD') {
        res.end()
      } else {
        res.end(JSON.stringify({ service: 'fitdays-mcp-server', status: 'ok' }))
      }
      return
    }

    try {
      const handledOAuth = await handleOAuthRequest(req, res, url, oauthConfig)
      if (handledOAuth) return

      if (url.pathname === '/mcp') {
        if (!verifyBearerToken(req, oauthConfig)) {
          const baseUrl = getBaseUrl(req)
          res.writeHead(401, {
            'Content-Type': 'application/json; charset=utf-8',
            'WWW-Authenticate': `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`,
          })
          res.end(JSON.stringify({ error: 'unauthorized' }))
          return
        }

        const parsedBody = req.method === 'POST' ? await readJsonBody(req) : undefined
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
        })
        const mcpServer = buildServer(session)
        res.on('close', () => {
          void transport.close()
          void mcpServer.close()
        })
        await mcpServer.connect(transport)
        await transport.handleRequest(req, res, parsedBody)
        return
      }

      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'not_found' }))
    } catch (err) {
      console.error('HTTP request error:', err)
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: 'internal_server_error' }))
      }
    }
  })

  await new Promise<void>((resolve) => {
    httpServer.listen(port, host, () => {
      console.error(`FitDays MCP HTTP server listening on http://${host}:${String(port)}/mcp`)
      resolve()
    })
  })
}
