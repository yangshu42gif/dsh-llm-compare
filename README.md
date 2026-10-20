# dsh-llm-compare

DeepSeek Harness 组合包：在一次对话里并行调用两个 LLM，实时比对处理效果。

## 功能

注册 `llm_compare` 工具——agent 收到比对请求时，向两个配置的 OpenAI 兼容端点**同时**发送同一 prompt，结果以结构化形式返回。同时把两个结果写入工作区 `llm-compare/` 目录，可在右侧 Sidebar 分栏打开比对。

## 配置

在你的 profile 的 `cordis.patch.yml` 中覆盖配置：

```yaml
- id: llm-compare
  name: dsh-llm-compare
  config:
    models:
      - label: deepseek-chat
        baseUrl: https://api.deepseek.com/v1
        apiKey: !!js process.env.DEEPSEEK_API_KEY
        model: deepseek-chat
      - label: gpt-4o-mini
        baseUrl: https://api.openai.com/v1
        apiKey: !!js process.env.OPENAI_API_KEY
        model: gpt-4o-mini
    temperature: 0.7
    maxTokens: 2048
```

## 使用

在对话中让 agent 调用：
> "用 llm_compare 工具比对这两个模型对以下问题的回答：..."

## 安装

```sh
dsh plugin --profile <name> add github:yangshu42gif/dsh-llm-compare
```

或本地路径 / tgz 安装。
