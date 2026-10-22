# dsh-image-hub

**多 API 生图插件 for DeepSeek Harness** —— 一套 provider 抽象，原生支持 Labnana、OpenAI 兼容（官方/中转站）、Gemini、Seedream（火山方舟）、DashScope（通义万相）、本地 ComfyUI。

在设置里存**多套 API 配置**，每套填自己的地址、Key、模型；对话里用 `image_generate` / `image_edit`，随时指定用哪套、换哪个模型。

## 支持的接口

| provider | 说明 | 生图 | 改图 | 参考图 | 拉模型 |
| --- | --- | :--: | :--: | :----: | :----: |
| `labnana` | Labnana（火星电波）原生 OpenAPI | ✅ | ✅ | 14 张 | ✅ |
| `openai-compatible` | OpenAI 官方 / 各类中转站 / xAI / 智谱 | ✅ | ✅ | 支持 | ✅ |
| `gemini` | Google Gemini 原生 `generateContent` | ✅ | ✅ | 支持 | ✅ |
| `seedream` | 火山方舟 Seedream / SeedEdit | ✅ | ✅ | 支持 | — |
| `dashscope` | 通义万相 / Qwen-Image | ✅ | ✅ | 支持 | — |
| `comfyui` | 本地 ComfyUI（导入 API 格式工作流） | ✅ | — | — | — |

> 每个 provider 的字段不同：ComfyUI 多一个工作流 JSON，其余主要是「地址 + Key + 模型」。

## 安装

```bash
pnpm dsh plugin --profile desktop add ./dsh-image-hub     # 本地目录
# 或发布之后：
pnpm dsh plugin --profile desktop add github:<你>/dsh-image-hub
```

安装后重启 DSH，在 **设置 → 插件 → 图像中枢** 里配置。

## 配置

点「+ 添加 API」，选接口类型，填地址 / Key / 模型（可以点「拉取模型」自动取），保存。

- 多套配置可以共存，选一套「设为默认」
- 每套有自己的默认比例（1:1 … 21:9）和清晰度（1K/2K/4K）
- 每套可以单独填**代理**（可选）
- 全局可以设「生成结果另存到工作区」和子目录

配置文件：`<DSH_HOME>/image-hub/config.json`（权限 0600），Key 只存在本机，只发给对应配置里的地址。

### 代理（国内访问 Labnana / OpenAI 常需要）

Node 的 `fetch` **不读 Windows 系统代理**，所以即便你开了「系统代理」，DSH 里的请求也可能仍然直连。插件自己实现了 HTTP CONNECT 隧道：在对应配置的「代理」里填

```
http://127.0.0.1:7890
http://user:pass@127.0.0.1:7890
```

生图、改图、拉模型、测试连接都会走这条代理，不依赖系统设置。

限制：只支持 **http/https 代理**；SOCKS5 请把代理开成 TUN/全局模式（那样连直连也会被接管）。

## 用法

对话里直接说：

```
画一张雨夜霓虹港口，16:9
用 Labnana 的 seedream-5-0-pro 生成一张 2K 的产品图
把这张图背景换成草原，人物别动
```

参数（两个工具都支持）：

| 参数 | 说明 |
| --- | --- |
| `prompt` | 必填 |
| `profile` | 用哪套配置（名称或 id），默认当前激活的那套 |
| `model` | 本次覆盖模型 |
| `aspect_ratio` | `1:1` / `3:2` / `2:3` / `4:3` / `3:4` / `16:9` / `9:16` / `21:9` |
| `image_size` | `1K` / `2K` / `4K` |
| `source_attachment_ids` / `source_paths` | 参考图（会话附件 id 或工作区路径） |

## 开发

```bash
node --test "tests/*.test.mjs"    # 24 个用例：核心工具、6 个 provider 适配、客户端 bundle
node --check lib/client.js
```

结构：

```
lib/core.js       配置、HTTP、图片解码、参考图、工作区落盘（纯函数，易测）
lib/providers.js  6 个 provider 适配 + 注册表 + 像素表
lib/index.js      宿主半：两个工具、同源 API、参数收敛
lib/client.js     浏览器半：设置页（手写 __ModuleLoader__ bundle，无构建）
```

设计取舍：

- **不依赖任何 `@deepseek-ai/*` 包**，只用 `node:` 内置模块；
- **provider 适配与插件本体解耦**：加新厂商只动 `lib/providers.js` 的一个对象；
- **客户端 bundle 必须自己声明 `module`/`exports`**，且 `apply` 不能把异常抛出去——否则会让整个 DSH 界面起不来（踩过这个坑）；
- ComfyUI 用占位符注入（`{{prompt}}` `{{width}}` `{{height}}` `{{seed}}`），不内置任何工作流。

## License

MIT
