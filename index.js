// dsh-llm-compare v0.4.0: 对话内开关对比模式——说「打开对比模式」即可切换。
// 注册两个工具：
//   compare_mode: 切换对比模式（on / off / status），切换后 system prompt 即时注入/移除
//   llm_compare:  并行调用两个 LLM，结果以左右对照表格返回
// 模型配置仍通过 profile 的 cordis.patch.yml 传入（YAML config）。

export const name = 'dsh-llm-compare'
export const inject = ['tools', 'systemPrompt']

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
    label: config.label, model: config.model, text, usage,
    latencyMs: Date.now() - start, error: null,
  }
}

/* ---------- 工作区文件写入（可选） ---------- */

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

/* ---------- 左右对照表格与摘要 ---------- */

function escapeCell(text) {
  return text.replace(/\|/g, '\\|').replace(/\n/g, '<br>')
}

function buildSideBySideTable(a, b) {
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
  const lines = [`| ${a.label} | ${b.label} |`, `|---|---|`]
  for (let i = 0; i < max; i++) {
    lines.push(`| ${pa[i] ? escapeCell(pa[i]) : ''} | ${pb[i] ? escapeCell(pb[i]) : ''} |`)
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

  /* ---------- 对比模式状态 ---------- */

  let compareEnabled = false
  let promptDisposer = null

  const setCompareMode = (enabled) => {
    compareEnabled = enabled
    if (promptDisposer) { promptDisposer(); promptDisposer = null }
    if (!enabled) return
    promptDisposer = ctx.systemPrompt.section({
      name: 'llm-compare-auto',
      order: 1100,
      text: `# 对比模式已开启

每次回答用户问题后，你**必须**调用 llm_compare 工具，把你刚才的回答内容作为 prompt 参数，让两个模型也回答同一问题。
工具返回后，在回复末尾附上左右对照表格和摘要统计，让用户看到两个模型的差异。
格式：先正常回答，然后附比对表格。`,
      interpolate: false,
    })
  }

  ctx.effect(() => () => { if (promptDisposer) promptDisposer() })

  /* ---------- compare_mode 工具（对话内开关） ---------- */

  ctx.tools.register({
    name: 'compare_mode',
    description: `Toggle LLM compare mode on/off. When ON, every answer is automatically compared between ${modelA.label} and ${modelB.label}. Use action 'on' to enable, 'off' to disable, 'status' to check current state. Call this when the user says "打开对比模式", "开启对比", "比对模式", "关闭对比模式", "停止比对" etc.`,
    parameters: {
      action: { type: 'string', required: true, description: `'on' to enable compare mode, 'off' to disable, 'status' to check current state` },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          enabled: { type: 'boolean', description: 'Current compare mode state after this call' },
          message: { type: 'string', description: 'Human-readable status message' },
        },
      },
      render: (_args, value) => {
        if (!value) return [{ type: 'text', text: 'compare_mode: no result' }]
        return [{ type: 'text', text: value.message ?? `对比模式: ${value.enabled ? '已开启' : '已关闭'}` }]
      },
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `对比模式 · ${args.action === 'on' ? '开启' : args.action === 'off' ? '关闭' : '查询'}`,
      content: `${modelA.label} vs ${modelB.label}`,
    }),
    presentResult: (_args, { content }) => ({
      card: 'generic',
      title: `对比模式 · ${content?.enabled ? '已开启' : '已关闭'}`,
      content: content?.message ?? '',
    }),
    async execute(args, _exec) {
      switch (args.action) {
        case 'on':
          setCompareMode(true)
          return { enabled: true, message: `对比模式已开启：${modelA.label} vs ${modelB.label}。此后每次回答都会自动并行比对两个模型。` }
        case 'off':
          setCompareMode(false)
          return { enabled: false, message: '对比模式已关闭。恢复正常单模型对话。' }
        case 'status':
          return { enabled: compareEnabled, message: `对比模式当前${compareEnabled ? '已开启' : '已关闭'}。` }
        default:
          return { enabled: compareEnabled, message: `未知操作 "${args.action}"，可用值：on / off / status。` }
      }
    },
  })

  /* ---------- llm_compare 工具（并行比对） ---------- */

  ctx.tools.register({
    name: 'llm_compare',
    description: [
      `Send the same prompt to two configured LLMs (${modelA.label} vs ${modelB.label}) in parallel.`,
      'Results are returned as a side-by-side comparison table plus summary stats.',
      'In compare mode, call this after each answer with your answer as the prompt to show how the other model would respond.',
      'Use when the user wants to compare models, benchmark outputs, or when compare mode is enabled.',
    ].join(' '),
    parameters: {
      prompt: { type: 'string', required: true, description: 'The prompt to send to both models' },
      writeFiles: { type: 'boolean', required: false, description: 'Also write results to workspace files for sidebar split-pane view (default: false)' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          comparisonTable: { type: 'string' },
          summary: { type: 'string' },
          modelA: { type: 'object', properties: { label: { type: 'string' }, text: { type: 'string' }, latencyMs: { type: 'number' }, tokens: { type: 'string' } } },
          modelB: { type: 'object', properties: { label: { type: 'string' }, text: { type: 'string' }, latencyMs: { type: 'number' }, tokens: { type: 'string' } } },
          elapsedMs: { type: 'number' },
        },
      },
      render: (_args, value) => {
        if (!value || !value.modelA) return [{ type: 'text', text: 'llm_compare: no result' }]
        return [{ type: 'text', text: `## LLM 比对结果\n\n${value.comparisonTable ?? ''}\n\n### 摘要\n${value.summary ?? ''}` }]
      },
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `LLM 比对 · ${modelA.label} vs ${modelB.label}`,
      content: String(args.prompt ?? '').slice(0, 120),
    }),
    presentResult: (_args, { content }) => ({
      card: 'generic',
      title: `LLM 比对完成 · ${modelA.label} vs ${modelB.label}`,
      content: String(content ?? '').slice(0, 200),
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
