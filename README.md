# dsh-image-hub

**多 API 生图插件 for DeepSeek Harness** —— 一套 provider 抽象，原生支持 Labnana、OpenAI（官方/兼容）、Gemini、Seedream（火山方舟）、DashScope（通义万相）、xAI Grok、智谱 GLM-Image、本地 ComfyUI。

在设置里存**多套 API 配置**，每套填自己的地址、Key、模型；对话里用 `image_generate` / `image_edit`，随时指定用哪套、换哪个模型；画过的图在对话顶部的「画廊」里能一次看完，每张都带本次消耗与剩余积分。

| 动漫海报 | 数据看板 | 服装设计稿 |
| :--: | :--: | :--: |
| <img src="docs/sample-1.jpg" width="270" alt="动漫海报示例" /> | <img src="docs/sample-2.jpg" width="270" alt="数据看板示例" /> | <img src="docs/sample-3.jpg" width="270" alt="服装设计稿示例" /> |

<sub>示例图均由本插件生成（Labnana 通道）。</sub>

## 特性

- **多套 API 并存**：每套独立地址 / Key / 模型 / 比例 / 清晰度 / 代理
- **每套卡片独立操作**：保存、取消、恢复默认、启用停用、删除，互不影响
- **参考图**：会话附件 id 或工作区路径，最多 14 张
- **积分可见**（Labnana）：生成前调官方估算接口，生成后查余额，输出里直接写「本次 X 积分，剩余 Y 积分」
- **画廊**：对话顶部「画廊」页签 + `image_gallery` 工具，记录落盘，重启不丢
- **代理**：自实现 HTTP CONNECT 隧道，不依赖系统代理设置

## 支持的接口

| provider | 说明 | 生图 | 改图 | 参考图 | 拉模型 |
| --- | --- | :--: | :--: | :----: | :----: |
| `labnana` | Labnana（火星电波）原生 OpenAPI | ✅ | ✅ | 14 张 | ✅ |
| `openai` | OpenAI 官方 | ✅ | ✅ | 支持 | ✅ |
| `openai-compatible` | OpenAI 兼容的各类中转站 | ✅ | ✅ | 支持 | ✅ |
| `gemini` | Google Gemini 原生 `generateContent` | ✅ | ✅ | 支持 | ✅ |
| `seedream` | 火山方舟 Seedream / SeedEdit | ✅ | ✅ | 支持 | — |
| `dashscope` | 通义万相 / Qwen-Image | ✅ | ✅ | 支持 | — |
| `xai` | xAI Grok Imagine | ✅ | — | — | ✅ |
| `zhipu` | 智谱 GLM-Image | ✅ | — | — | — |
| `comfyui` | 本地 ComfyUI（导入 API 格式工作流） | ✅ | — | — | — |
| `chatgpt-sub` / `grok-sub` | 订阅通道（**实验性**：填访问令牌直连，令牌会过期） | ✅ | — | — | — |
| `google-sub` | 订阅通道（暂未支持，v1internal 专有协议） | — | — | — | — |

> 订阅通道没有账号登录（OAuth）流程，需要自己提供访问令牌；令牌过期后要重新获取。

## 安装

```bash
pnpm dsh plugin --profile desktop add github:tianfangliu98-cpu/dsh-image-hub
# 本地目录调试：
pnpm dsh plugin --profile desktop add ./dsh-image-hub
```

安装后重启 DSH，在 **设置 → 插件 → 生图配置** 里配置。

## 配置

点「+ 添加 API」，选接口类型，填地址 / Key / 模型（可点「拉取模型」自动获取），点该卡片的「保存」。

- 每套卡片**独立保存**；底部「保存全局设置」只负责默认用哪套、工作区选项
- 停用的配置不会参与生成，工具会明确报「已停用」
- 配置文件：`<DSH_HOME>/image-hub/config.json`（权限 0600）

### 代理（国内访问 Labnana / OpenAI 常需要）

Node 的 `fetch` **不读 Windows 系统代理**，所以即使开了「系统代理」，DSH 里的请求也可能仍然直连。插件自己实现了 HTTP CONNECT 隧道，在对应配置的「代理」里填：

```
http://127.0.0.1:7890
http://user:pass@127.0.0.1:7890
```

生图、改图、拉模型、测试连接都会走这条代理。只支持 **http/https 代理**；SOCKS5 请把代理开成 TUN/全局模式。

## 用法

```
画一张雨夜霓虹港口，16:9
用 Labnana 的 seedream-5-0-pro 生成一张 2K 的产品图
把这张图背景换成草原，人物别动
看看这次对话生成的图（或：打开画廊）
```

参数（`image_generate` / `image_edit` 都支持）：

| 参数 | 说明 |
| --- | --- |
| `prompt` | 必填 |
| `profile` | 用哪套配置（名称或 id），默认当前激活的那套 |
| `model` | 本次覆盖模型 |
| `aspect_ratio` | `1:1` 方形 / `2:3` 照片 / `3:2` 横版照片 / `3:4` 竖版海报 / `4:3` 传统横版 / `4:5` 大画幅 / `5:4` 横版大画幅 / `9:16` 竖版 / `16:9` 横版 / `21:9` 超宽屏 |
| `image_size` | `1K` / `2K` / `4K` |
| `source_attachment_ids` / `source_paths` | 参考图（会话附件 id 或工作区路径） |

## 数据与隐私

- Key 只存在本机，只发给该套配置里填的地址
- 画廊记录：`<DSH_HOME>/image-hub/gallery.jsonl`（只记录本插件生成的图，不含你上传的图）
- 生成结果写入会话附件；开启「工作区保存」时另存到 `<会话目录>/dsh-image-hub/`
- 不经过任何第三方中转

## 已知限制

- 订阅通道是**实验性令牌直连**，没有 OAuth 登录与自动续期
- Google 订阅走 v1internal 专有协议，未实现
- Seedream / DashScope / 智谱没有公开的模型列表接口，「拉取模型」不可用，需手填 id
- ComfyUI 只支持生图，需自备 API 格式工作流
- 项目与 Labnana（火星电波）、OpenAI、Google 等厂商均无隶属关系

## 开发

```bash
node --test "tests/*.test.mjs"    # 48 个用例：核心、12 个 provider 适配、代理、客户端 bundle、宿主端到端
node --check lib/client.js
```

结构：

```
lib/core.js       配置、HTTP、图片解码、参考图、工作区落盘（纯函数，易测）
lib/providers.js  12 个 provider 适配 + 注册表 + 像素表
lib/proxy.js      HTTP CONNECT 代理隧道（fetch 兼容）
lib/index.js      宿主半：三个工具、同源 API、参数收敛、画廊记录
lib/client.js     浏览器半：设置页 + 画廊页签（手写 __ModuleLoader__ bundle，无构建）
```

设计取舍：

- **不依赖任何 `@deepseek-ai/*` 包**，只用 `node:` 内置模块
- **provider 适配与插件本体解耦**：加新厂商只动 `lib/providers.js` 的一个对象
- **客户端 bundle 必须自己声明 `module`/`exports`**，且 `apply` 不能把异常抛出去——否则整个 DSH 界面起不来（踩过这个坑）
- ComfyUI 用占位符注入（`{{prompt}}` `{{width}}` `{{height}}` `{{seed}}`），不内置任何工作流

## License

MIT
