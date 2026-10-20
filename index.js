// dsh-llm-compare v0.2.0: 在一次对话里并行调用两个 LLM，结果以左右对照表格直接呈现。
// 改进：不再需要手动打开 Sidebar 文件——对话内即可看到并排比对 + 摘要统计。

export const name = 'dsh-llm-compare'
export const inject = ['tools']

/* ---------- OpenAI 兼容 API 调用 ---------- */

async function callModel(config, prompt, options, signal) {
  const start = Date.now()
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
  const usage = data.usage
    ? { input: data.usage.prompt_tokens, output: data.usage.completion_tokens }
    : { input: 0, output: 0 }
  return {
    label: config.label,
    model: config.model,
    text,
    usage,
    latencyMs: Date.now() - start,
    error: null,
  }
}

/* ---------- 工作区文件写入（可选，供 Sidebar 分栏） ---------- */

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
  } catch { /* 工作区不可用时跳过 */ }
}

/* ---------- 左右对照表格生成 ---------- */

function escapeCell(text) {
  return text.replace(/\|/g, '\\|').replace(/\n/g, '<br>')
}

function buildSideBySideTable(a, b) {
  // 按双换行分段；代码块（``` 围栏）作为整体保留
  const splitParagraphs = (text) => {
    if (!text) return []
    const blocks = []
    const lines = text.split('\n')
    let current = []
    let inCode = false
    for (const line of lines) {
      if (line.trim().startsWith('```')) {
        if (inCode) { current.push(line); blocks.push(current.join('\n')); current = []; inCode = false }
        else { if (current.length) { blocks.push(current.join('\n')); current = [] } current.push(line); inCode = true }
      } else { current.push(line) }
    }
    if (current.length) blocks.push(current.join('\n'))
    return blocks.filter(b => b.trim())
  }

  const pa = splitParagraphs(a.text)
  const pb = splitParagraphs(b.text)
  const max = Math.max(pa.length, pb.length)

  const lines = []
  lines.push(`| ${a.label} | ${b.label} |`)
  lines.push(`|---|---|`)
  for (let i = 0; i < max; i++) {
    const left = pa[i] ? escapeCell(pa[i]) : ''
    const right = pb[i] ? escapeCell(pb[i]) : ''
    lines.push(`| ${left} | ${right} |`)
  }
  return lines.join('\n')
}

function buildSummary(a, b, elapsedMs) {
  const parts = []
  parts.push(`| | ${a.label} | ${b.label} |`)
  parts.push(`|---|---|---|`)
  parts.push(`| 延迟 | ${a.latencyMs}ms | ${b.latencyMs}ms |`)
  parts.push(`| tokens | ${a.usage.input}+${a.usage.output} | ${b.usage.input}+${b.usage.output} |`)
  parts.push(`| 字数 | ${a.text.length} | ${b.text.length} |`)
  if (a.error) parts.push(`| 错误 | ${escapeCell(a.error)} | - |`)
  if (b.error) parts.push(`| 错误 | - | ${escapeCell(b.error)} |`)
  parts.push(``)
  parts.push(`总耗时: ${Math.round(elapsedMs)}ms`)
  return parts.join('\n')
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
    description: [
      `Send the same prompt to two configured LLMs (${modelA.label} vs ${modelB.label}) in parallel.`,
      'Results are returned as a side-by-side comparison table plus summary stats (latency, tokens, char count).',
      'The agent should present the comparison directly in the reply—no need to open extra windows.',
      'Optionally writes results to workspace files for sidebar split-pane viewing.',
      'Use when the user wants to compare models, benchmark outputs, or evaluate different LLMs.',
    ].join(' '),
    parameters: {
      prompt: { type: 'string', required: true, description: 'The prompt to send to both models' },
      writeFiles: { type: 'boolean', required: false, description: 'Also write results to llm-compare/*.md files in workspace for sidebar split-pane view (default: false)' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          comparisonTable: { type: 'string', description: 'Side-by-side markdown comparison table' },
          summary: { type: 'string', description: 'Summary stats (latency, tokens, char count)' },
          modelA: { type: 'object', properties: { label: { type: 'string' }, text: { type: 'string' }, latencyMs: { type: 'number' }, tokens: { type: 'string' } } },
          modelB: { type: 'object', properties: { label: { type: 'string' }, text: { type: 'string' }, latencyMs: { type: 'number' }, tokens: { type: 'string' } } },
          elapsedMs: { type: 'number' },
        },
      },
      render: (_args, value) => {
        if (!value || !value.modelA) return [{ type: 'text', text: 'llm_compare: no result' }]
        const parts = []
        parts.push(`## LLM 比对结果\n`)
        parts.push(value.comparisonTable ?? '')
        parts.push(`\n### 摘要\n`)
        parts.push(value.summary ?? '')
        return [{ type: 'text', text: parts.join('\n') }]
      },
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `LLM 比对 · ${modelA.label} vs ${modelB.label}`,
      content: args.prompt?.slice(0, 120) ?? '',
    }),
    presentResult: (_args, { content }) => ({
      card: 'generic',
      title: `LLM 比对完成 · ${modelA.label} vs ${modelB.label}`,
      content: content?.slice(0, 200) ?? '',
    }),
    async execute(args, exec) {
      const start = Date.now()
      const options = { temperature, maxTokens }
      const [resultA, resultB] = await Promise.allSettled([
        callModel(modelA, args.prompt, options, exec.signal),
        callModel(modelB, args.prompt, options, exec.signal),
      ])
      const a = resultA.status === 'fulfilled'
        ? resultA.value
        : { label: modelA.label, model: modelA.model, text: '', usage: { input: 0, output: 0 }, latencyMs: 0, error: String(resultA.reason) }
      const b = resultB.status === 'fulfilled'
        ? resultB.value
        : { label: modelB.label, model: modelB.model, text: '', usage: { input: 0, output: 0 }, latencyMs: 0, error: String(resultB.reason) }
      const elapsedMs = Date.now() - start

      const comparisonTable = buildSideBySideTable(a, b)
      const summary = buildSummary(a, b, elapsedMs)

      // 可选：写入工作区文件供 Sidebar 分栏
      if (args.writeFiles) {
        await writeWorkspaceFile(ctx, `llm-compare/${a.label}.md`, `# ${a.label} (${a.model})\n${a.error ? `> **错误**: ${a.error}\n` : ''}\n${a.text}`)
        await writeWorkspaceFile(ctx, `llm-compare/${b.label}.md`, `# ${b.label} (${b.model})\n${b.error ? `> **错误**: ${b.error}\n` : ''}\n${b.text}`)
      }

      return {
        comparisonTable,
        summary,
        modelA: { label: a.label, text: a.text, latencyMs: a.latencyMs, tokens: `${a.usage.input}+${a.usage.output}` },
        modelB: { label: b.label, text: b.text, latencyMs: b.latencyMs, tokens: `${b.usage.input}+${b.usage.output}` },
        elapsedMs,
      }
    },
  })
}
