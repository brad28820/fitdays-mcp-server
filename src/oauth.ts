import type { IncomingMessage, ServerResponse } from 'node:http'

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export type OAuthConfig = {
  allowedRedirectOrigins: readonly string[]
  authDisabled: boolean
  authPassword: string
  tokenSecret: string
}

type AuthCodePayload = {
  clientId: string
  codeChallenge: string
  codeChallengeMethod: 'S256'
  exp: number
  redirectUri: string
  scope: string
  type: 'code'
}

type TokenPayload = {
  clientId: string
  exp: number
  scope: string
  type: 'access' | 'refresh'
}

const DEFAULT_ALLOWED_HOSTS = [
  'claude.ai',
  'claude.com',
  'gemini.google.com',
  'localhost',
  '127.0.0.1',
]

const ACCESS_TOKEN_TTL_SEC = 60 * 60 * 24 * 30 // 30 days
const REFRESH_TOKEN_TTL_SEC = 60 * 60 * 24 * 90 // 90 days
const AUTH_CODE_TTL_SEC = 60 * 10 // 10 minutes

const base64UrlEncode = (input: Buffer | string): string => {
  return Buffer.from(input).toString('base64url')
}

const base64UrlDecode = (input: string): string => {
  return Buffer.from(input, 'base64url').toString('utf8')
}

const signPayload = (payload: object, secret: string): string => {
  const encoded = base64UrlEncode(JSON.stringify(payload))
  const sig = createHmac('sha256', secret).update(encoded).digest('base64url')
  return `${encoded}.${sig}`
}

const verifySignedPayload = <T extends { exp: number }>(
  token: string,
  secret: string,
): null | T => {
  const parts = token.split('.')
  if (parts.length !== 2) return null
  const [encoded, sig] = parts
  if (!encoded || !sig) return null
  const expectedSig = createHmac('sha256', secret).update(encoded).digest('base64url')
  const a = Buffer.from(sig)
  const b = Buffer.from(expectedSig)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  try {
    const parsed = JSON.parse(base64UrlDecode(encoded)) as T
    if (typeof parsed.exp !== 'number' || Math.floor(Date.now() / 1000) > parsed.exp) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

const timingSafePasswordCheck = (provided: string, expected: string): boolean => {
  const h1 = createHash('sha256').update(provided).digest()
  const h2 = createHash('sha256').update(expected).digest()
  return timingSafeEqual(h1, h2)
}

const escapeHtml = (value: string): string => {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export const loadOAuthConfig = (fallbackPassword: string): OAuthConfig => {
  const rawSecret = process.env.MCP_TOKEN_SECRET?.trim()
  const tokenSecret =
    rawSecret && rawSecret.length > 0 ?
      rawSecret :
      createHash('sha256').update(`fitdays-mcp:${fallbackPassword}`).digest('hex')
  const authPassword = process.env.MCP_AUTH_PASSWORD?.trim() || fallbackPassword
  const extraOrigins = (process.env.OAUTH_ALLOWED_REDIRECT_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  return {
    allowedRedirectOrigins: extraOrigins,
    authDisabled: process.env.MCP_AUTH_DISABLED === 'true',
    authPassword,
    tokenSecret,
  }
}

export const getBaseUrl = (req: IncomingMessage): string => {
  const protoHeader = req.headers['x-forwarded-proto']
  const hostHeader = req.headers['x-forwarded-host'] ?? req.headers.host
  const proto = Array.isArray(protoHeader) ? protoHeader[0] : (protoHeader ?? 'https')
  const host = Array.isArray(hostHeader) ? hostHeader[0] : (hostHeader ?? 'localhost:8000')
  return `${proto}://${host}`
}

export const isAllowedRedirectUri = (
  redirectUri: string,
  extraAllowedOrigins: readonly string[],
): boolean => {
  try {
    const url = new URL(redirectUri)
    if (extraAllowedOrigins.some((origin) => redirectUri.startsWith(origin))) {
      return true
    }
    if (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')) {
      return true
    }
    if (url.protocol !== 'https:') {
      return false
    }
    return DEFAULT_ALLOWED_HOSTS.some(
      (host) => url.hostname === host || url.hostname.endsWith(`.${host}`) || url.hostname.endsWith('.googleusercontent.com') || url.hostname.endsWith('.google.com'),
    )
  } catch {
    return false
  }
}

export const verifyBearerToken = (
  req: IncomingMessage,
  config: OAuthConfig,
): boolean => {
  if (config.authDisabled) return true
  const authHeader = req.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) return false
  const token = authHeader.slice('Bearer '.length).trim()
  const payload = verifySignedPayload<TokenPayload>(token, config.tokenSecret)
  return payload !== null && payload.type === 'access'
}

const sendJson = (res: ServerResponse, statusCode: number, body: unknown): void => {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

const readBody = async (req: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}

const renderAuthorizePage = (params: {
  clientId: string
  codeChallenge: string
  codeChallengeMethod: string
  error?: string
  redirectUri: string
  scope: string
  state: string
}): string => {
  const errorBlock = params.error ?
    `<p style="color:#b91c1c;background:#fee2e2;padding:10px 12px;border-radius:6px;font-size:14px;">${escapeHtml(params.error)}</p>` :
    ''

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Authorize FitDays MCP</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; background: #f8fafc; color: #0f172a; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 16px; }
    .card { background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 28px; max-width: 400px; width: 100%; box-shadow: 0 4px 16px rgba(15, 23, 42, 0.06); }
    h1 { font-size: 20px; margin: 0 0 8px; }
    p.sub { font-size: 14px; color: #475569; margin: 0 0 20px; }
    label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 6px; }
    input[type=password] { width: 100%; box-sizing: border-box; padding: 10px 12px; border: 1px solid #cbd5e1; border-radius: 8px; font-size: 15px; margin-bottom: 16px; }
    button { width: 100%; background: #0f172a; color: #fff; border: 0; border-radius: 8px; padding: 11px 16px; font-size: 15px; font-weight: 600; cursor: pointer; }
    button:hover { background: #1e293b; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Authorize FitDays MCP</h1>
    <p class="sub">Enter your MCP access password to grant read-only access to your FitDays weight data.</p>
    ${errorBlock}
    <form method="POST" action="/oauth/authorize">
      <input type="hidden" name="client_id" value="${escapeHtml(params.clientId)}" />
      <input type="hidden" name="redirect_uri" value="${escapeHtml(params.redirectUri)}" />
      <input type="hidden" name="state" value="${escapeHtml(params.state)}" />
      <input type="hidden" name="scope" value="${escapeHtml(params.scope)}" />
      <input type="hidden" name="code_challenge" value="${escapeHtml(params.codeChallenge)}" />
      <input type="hidden" name="code_challenge_method" value="${escapeHtml(params.codeChallengeMethod)}" />
      <label for="password">MCP Password</label>
      <input id="password" name="password" type="password" required autofocus />
      <button type="submit">Authorize</button>
    </form>
  </div>
</body>
</html>`
}

export const handleOAuthRequest = async (
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  config: OAuthConfig,
): Promise<boolean> => {
  const baseUrl = getBaseUrl(req)

  if (req.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') {
    sendJson(res, 200, {
      authorization_endpoint: `${baseUrl}/oauth/authorize`,
      code_challenge_methods_supported: ['S256'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      issuer: baseUrl,
      registration_endpoint: `${baseUrl}/oauth/register`,
      response_types_supported: ['code'],
      scopes_supported: ['fitdays:read'],
      token_endpoint: `${baseUrl}/oauth/token`,
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
    })
    return true
  }

  if (
    req.method === 'GET' &&
    (url.pathname === '/.well-known/oauth-protected-resource' ||
      url.pathname === '/.well-known/oauth-protected-resource/mcp')
  ) {
    sendJson(res, 200, {
      authorization_servers: [baseUrl],
      bearer_methods_supported: ['header'],
      resource: `${baseUrl}/mcp`,
      scopes_supported: ['fitdays:read'],
    })
    return true
  }

  if (req.method === 'POST' && url.pathname === '/oauth/register') {
    const raw = await readBody(req)
    let body: Record<string, unknown> = {}
    try {
      body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
    } catch {
      sendJson(res, 400, { error: 'invalid_client_metadata' })
      return true
    }
    const clientId = `fitdays-${randomBytes(8).toString('hex')}`
    sendJson(res, 201, {
      client_id: clientId,
      client_name: typeof body.client_name === 'string' ? body.client_name : 'MCP Client',
      grant_types: ['authorization_code', 'refresh_token'],
      redirect_uris: Array.isArray(body.redirect_uris) ? body.redirect_uris : [],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    })
    return true
  }

  if (req.method === 'GET' && url.pathname === '/oauth/authorize') {
    const clientId = url.searchParams.get('client_id') ?? ''
    const redirectUri = url.searchParams.get('redirect_uri') ?? ''
    const responseType = url.searchParams.get('response_type') ?? ''
    const state = url.searchParams.get('state') ?? ''
    const scope = url.searchParams.get('scope') ?? 'fitdays:read'
    const codeChallenge = url.searchParams.get('code_challenge') ?? ''
    const codeChallengeMethod = url.searchParams.get('code_challenge_method') ?? 'S256'

    if (responseType !== 'code' || !clientId || !redirectUri || !codeChallenge || codeChallengeMethod !== 'S256') {
      sendJson(res, 400, { error: 'invalid_request', error_description: 'Missing or invalid OAuth PKCE parameters.' })
      return true
    }

    if (!isAllowedRedirectUri(redirectUri, config.allowedRedirectOrigins)) {
      sendJson(res, 400, { error: 'invalid_request', error_description: 'Redirect URI is not allowlisted.' })
      return true
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(renderAuthorizePage({
      clientId,
      codeChallenge,
      codeChallengeMethod,
      redirectUri,
      scope,
      state,
    }))
    return true
  }

  if (req.method === 'POST' && url.pathname === '/oauth/authorize') {
    const raw = await readBody(req)
    const form = new URLSearchParams(raw)
    const clientId = form.get('client_id') ?? ''
    const redirectUri = form.get('redirect_uri') ?? ''
    const state = form.get('state') ?? ''
    const scope = form.get('scope') ?? 'fitdays:read'
    const codeChallenge = form.get('code_challenge') ?? ''
    const codeChallengeMethod = form.get('code_challenge_method') ?? 'S256'
    const password = form.get('password') ?? ''

    if (!isAllowedRedirectUri(redirectUri, config.allowedRedirectOrigins)) {
      sendJson(res, 400, { error: 'invalid_request', error_description: 'Redirect URI is not allowlisted.' })
      return true
    }

    if (!timingSafePasswordCheck(password, config.authPassword)) {
      res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(renderAuthorizePage({
        clientId,
        codeChallenge,
        codeChallengeMethod,
        error: 'Incorrect password. Please try again.',
        redirectUri,
        scope,
        state,
      }))
      return true
    }

    const codePayload: AuthCodePayload = {
      clientId,
      codeChallenge,
      codeChallengeMethod: 'S256',
      exp: Math.floor(Date.now() / 1000) + AUTH_CODE_TTL_SEC,
      redirectUri,
      scope,
      type: 'code',
    }
    const code = signPayload(codePayload, config.tokenSecret)
    const target = new URL(redirectUri)
    target.searchParams.set('code', code)
    if (state) target.searchParams.set('state', state)

    res.writeHead(302, { Location: target.toString() })
    res.end()
    return true
  }

  if (req.method === 'POST' && url.pathname === '/oauth/token') {
    const raw = await readBody(req)
    const contentType = req.headers['content-type'] ?? ''
    const params = contentType.includes('application/json') ?
      new URLSearchParams(Object.entries(JSON.parse(raw) as Record<string, string>)) :
      new URLSearchParams(raw)

    const grantType = params.get('grant_type') ?? ''

    if (grantType === 'authorization_code') {
      const code = params.get('code') ?? ''
      const codeVerifier = params.get('code_verifier') ?? ''
      const redirectUri = params.get('redirect_uri') ?? ''
      const payload = verifySignedPayload<AuthCodePayload>(code, config.tokenSecret)

      if (!payload || payload.type !== 'code') {
        sendJson(res, 400, { error: 'invalid_grant' })
        return true
      }

      if (redirectUri && redirectUri !== payload.redirectUri) {
        sendJson(res, 400, { error: 'invalid_grant' })
        return true
      }

      const expectedChallenge = createHash('sha256').update(codeVerifier).digest('base64url')
      if (expectedChallenge !== payload.codeChallenge) {
        sendJson(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed.' })
        return true
      }

      const now = Math.floor(Date.now() / 1000)
      const accessToken = signPayload(
        { clientId: payload.clientId, exp: now + ACCESS_TOKEN_TTL_SEC, scope: payload.scope, type: 'access' } satisfies TokenPayload,
        config.tokenSecret,
      )
      const refreshToken = signPayload(
        { clientId: payload.clientId, exp: now + REFRESH_TOKEN_TTL_SEC, scope: payload.scope, type: 'refresh' } satisfies TokenPayload,
        config.tokenSecret,
      )

      sendJson(res, 200, {
        access_token: accessToken,
        expires_in: ACCESS_TOKEN_TTL_SEC,
        refresh_token: refreshToken,
        scope: payload.scope,
        token_type: 'Bearer',
      })
      return true
    }

    if (grantType === 'refresh_token') {
      const refreshToken = params.get('refresh_token') ?? ''
      const payload = verifySignedPayload<TokenPayload>(refreshToken, config.tokenSecret)
      if (!payload || payload.type !== 'refresh') {
        sendJson(res, 400, { error: 'invalid_grant' })
        return true
      }

      const now = Math.floor(Date.now() / 1000)
      const newAccessToken = signPayload(
        { clientId: payload.clientId, exp: now + ACCESS_TOKEN_TTL_SEC, scope: payload.scope, type: 'access' } satisfies TokenPayload,
        config.tokenSecret,
      )
      const newRefreshToken = signPayload(
        { clientId: payload.clientId, exp: now + REFRESH_TOKEN_TTL_SEC, scope: payload.scope, type: 'refresh' } satisfies TokenPayload,
        config.tokenSecret,
      )

      sendJson(res, 200, {
        access_token: newAccessToken,
        expires_in: ACCESS_TOKEN_TTL_SEC,
        refresh_token: newRefreshToken,
        scope: payload.scope,
        token_type: 'Bearer',
      })
      return true
    }

    sendJson(res, 400, { error: 'unsupported_grant_type' })
    return true
  }

  return false
}
