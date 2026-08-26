const SECRET_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\bsk-[A-Za-z0-9._-]+/gi,
  /\b(token|password|api_key)\s*([=:])\s*["']?[^\s,"'}]+["']?/gi,
]

export function redactSecrets(text: string): string {
  return SECRET_PATTERNS.reduce((result, pattern, index) => {
    if (index < 2) return result.replace(pattern, '[REDACTED]')
    return result.replace(pattern, (_match, name: string) => `${name}=[REDACTED]`)
  }, text)
}

export function containsSecret(text: string): boolean {
  return SECRET_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0
    const match = pattern.exec(text)
    pattern.lastIndex = 0
    return match !== null && !match[0].includes('[REDACTED]')
  })
}
