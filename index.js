// dsh-llm-compare: 在一次对话里并行调用两个 LLM，实时比对处理效果。
// 工具 `llm_compare` 向两个配置的 OpenAI 兼容端点同时发送同一 prompt，
// 结果以结构化形式返回，agent 可引导用户在右侧 Sidebar 分栏打开比对文件。

export const name = 'dsh-llm-compare'
export const inject = ['tools']

/* ---------- OpenAI 兼容 API 调用 ---------- */

async function callModel(config, prompt, options, signal) {
  const url = `${config.baseUrl.replace(/\/$/, '')}/chat/completions`
  const body = JSON.stringify({
    model: config.model,
    messages: [{ role: 'user', content: prompt }],
    temperature: options.temperature,
    max_tokens: options.maxTokens,
    stream: false,
  })
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.apiKey}`,
    },
    body,
    ...(signal ? { signal } : {}),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`[${config.label}] HTTP ${response.status}: ${text.slice(0, 200)}`)
  }
  const data = await response.json()
  const text = data.choices?.[0]?.message?.content ?? ''
  const usage = data.usage ? `${data.usage.prompt_tokens}+${data.usage.completion_tokens} tok` : ''
  return { label: config.label, model: config.model, text, usage, error: null }
}

/* ---------- 工作区文件写入（尽力而为） ---------- */

async function writeWorkspaceFile(ctx, path, content) {
  try {
    if (ctx.workspaceFiles?.write) {
      await ctx.workspaceFiles.write(path, content)
    } else {
      const { writeFile, mkdir } = await import('node:fs/promises')
      const dir = path.slice(0, path.lastIndexOf('/'))
      await mkdir(dir, { recursive: true })
      await writeFile(path, content, 'utf-8')
    }
  } catch { /* 工作区不可用时跳过文件写入 */ }
}

/* ---------- 插件入口 ---------- */

export function apply(ctx, config) {
  const models = config?.models
  if (!models || models.length < 2) {
    ctx.logger?.warn?.('[dsh-llm-compare] 需要配置至少两个模型端点（models 数组），工具未注册。')
    return
  }

  const [modelA, modelB] = models
  const temperature = config.temperature ?? 0.7
  const maxTokens = config.maxTokens ?? 2048

  ctx.tools.register({
    name: 'llm_compare',
    description: 'Send the same prompt to two configured LLMs in parallel and return both responses for comparison. Use this when the user wants to compare different models, evaluate outputs side by side, or benchmark LLM performance.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'The prompt to send to both models' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          modelA: { type: 'object', properties: { label: { type: 'string' }, text: { type: 'string' }, usage: { type: 'string' } } },
          modelB: { type: 'object', properties: { label: { type: 'string' }, text: { type: 'string' }, usage: { type: 'string' } } },
          elapsedMs: { type: 'number' },
        },
      },
      render: (_args, value) => {
        if (!value || !value.modelA) return [{ type: 'text', text: 'llm_compare: no result' }]
        const parts = [`## LLM 比对结果\n`]
        parts.push(`### ${value.modelA.label} (左)\n${value.modelA.text}\n`)
        parts.push(`---\n`)
        parts.push(`### ${value.modelB.label} (右)\n${value.modelB.text}\n`)
        if (value.elapsedMs != null) parts.push(`\n耗时: ${Math.round(value.elapsedMs)}ms`)
        return [{ type: 'text', text: parts.join('\n') }]
      },
    },
    async execute(args, exec) {
      const start = Date.now()
      const options = { temperature, maxTokens }
      const [resultA, resultB] = await Promise.allSettled([
        callModel(modelA, args.prompt, options, exec.signal),
        callModel(modelB, args.prompt, options, exec.signal),
      ])
      const a = resultA.status === 'fulfilled'
        ? resultA.value
        : { label: modelA.label, model: modelA.model, text: '', usage: '', error: String(resultA.reason) }
      const b = resultB.status === 'fulfilled'
        ? resultB.value
        : { label: modelB.label, model: modelB.model, text: '', usage: '', error: String(resultB.reason) }
      const elapsedMs = Date.now() - start

      // 把两个结果写入工作区，供 Sidebar 分栏打开比对
      await writeWorkspaceFile(ctx, `llm-compare/${a.label}-left.md`, `# ${a.label} (${a.model})\n${a.error ? `> **错误**: ${a.error}\n` : ''}${a.usage ? `> tokens: ${a.usage}\n` : ''}\n---\n\n${a.text}`)
      await writeWorkspaceFile(ctx, `llm-compare/${b.label}-right.md`, `# ${b.label} (${b.model})\n${b.error ? `> **错误**: ${b.error}\n` : ''}${b.usage ? `> tokens: ${b.usage}\n` : ''}\n---\n\n${b.text}`)

      return {
        modelA: { label: a.label, text: a.text, usage: a.usage },
        modelB: { label: b.label, text: b.text, usage: b.usage },
        elapsedMs,
      }
    },
  })
}
