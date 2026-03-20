const input = JSON.parse(await Bun.stdin.text());

const toolName: string = input.tool_name || "";

// Only check memory_add
if (toolName !== "memory_add") {
  console.log(JSON.stringify({}));
  process.exit(0);
}

const content: string = input.tool_input?.content || "";

// Common credential patterns
const SENSITIVE_PATTERNS = [
  /(?:api[_-]?key|apikey)\s*[:=]\s*\S+/i,
  /(?:secret[_-]?key|secretkey)\s*[:=]\s*\S+/i,
  /(?:access[_-]?token|accesstoken)\s*[:=]\s*\S+/i,
  /(?:password|passwd|pwd)\s*[:=]\s*\S+/i,
  /(?:private[_-]?key)\s*[:=]\s*\S+/i,
  /Bearer\s+[A-Za-z0-9\-._~+\/]+=*/,
  /\bAKIA[0-9A-Z]{16}\b/,                          // AWS Access Key
  /\bsk-[a-zA-Z0-9]{20,}\b/,                        // OpenAI / Stripe key
  /\bghp_[a-zA-Z0-9]{36}\b/,                        // GitHub PAT
  /\bglpat-[a-zA-Z0-9\-_]{20,}\b/,                  // GitLab PAT
  /-----BEGIN\s(?:RSA|EC|OPENSSH)?\s?PRIVATE\sKEY----/,
  /mongodb(?:\+srv)?:\/\/[^:]+:[^@]+@/,              // MongoDB URI with creds
  /postgres(?:ql)?:\/\/[^:]+:[^@]+@/,                // PostgreSQL URI with creds
  /mysql:\/\/[^:]+:[^@]+@/,                          // MySQL URI with creds
];

const matched = SENSITIVE_PATTERNS.find(p => p.test(content));

if (matched) {
  console.log(JSON.stringify({
    decision: "deny",
    message: "⚠️ 检测到敏感信息（疑似凭据/密钥），已阻止保存。请移除敏感内容后重试，或只记录事实（如"项目使用 AWS S3"），不要包含具体密钥。",
  }));
} else {
  console.log(JSON.stringify({}));
}
