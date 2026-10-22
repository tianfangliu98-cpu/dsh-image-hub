# Changelog

## 0.1.0 — 2026-10-22

首个版本。

### 能力

- 两个工具：`image_generate`、`image_edit`（默认取会话里最新一张图作参考）
- 设置页「图像中枢」：多套 API 配置（新增/删除/设为默认）、测试连接、拉取模型
- 六个 provider：Labnana 原生 / OpenAI 兼容 / Gemini 原生 / Seedream（方舟）/ DashScope（通义）/ 本地 ComfyUI
- 每套配置独立的地址、Key、模型、默认比例与清晰度
- 生成结果写入会话附件，可选另存到工作区子目录
- 每套配置可单独填 HTTP 代理（自实现 CONNECT 隧道，不依赖系统代理）

### 工程

- 纯 `node:` 实现，无 `@deepseek-ai/*` 依赖，无构建步骤
- 39 个测试：核心工具 10、provider 适配 11、代理 5、客户端 bundle 4、宿主端到端 9
- 客户端 bundle 自带 `module` 声明与 loader 守卫，`apply` 异常不外抛（避免拖垮 web boot）

### 已知限制

- 代理只支持 http/https（SOCKS 请用 TUN/全局模式）
- ComfyUI 只支持生图，需要自备 API 格式工作流
- Seedream / DashScope 没有公开模型列表接口，"拉取模型"不可用，需手填模型 id
