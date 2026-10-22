/**
 * dsh-image-hub —— 浏览器半（手写 __ModuleLoader__ bundle，无构建工具）。
 *
 * 设置页「图像中枢」：
 *   - 多套 API 配置（provider / 地址 / Key / 模型 / 默认比例与清晰度）
 *   - 每套都能「测试连接」「拉取模型」，可设默认
 *   - 全局：结果是否存工作区、子目录
 *
 * 事故教训（写在这里免得再犯）：
 *   1. factory 里必须自己声明 CommonJS 的 module/exports，宿主只给 require；
 *   2. 不能在 import 阶段抛异常，否则整个 web boot 失败 —— apply 要包 try/catch；
 *   3. 加载器缺失时静默跳过。
 */

// 加载器不存在时静默跳过：宁可设置页消失，也不能让 web boot 挂掉。
if (typeof window !== 'undefined' && window.__ModuleLoader__ !== undefined) window.__ModuleLoader__.load({
  id: 'dsh-image-hub',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const h = React.createElement
    const useEffect = React.useEffect
    const useState = React.useState
    const useMemo = React.useMemo

    const API = '/api/image-hub'
    const RATIOS = ['1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16', '21:9']
    const SIZES = ['1K', '2K', '4K']

    // ---- 同源 API ---------------------------------------------------------

    function readJson(res) {
      return res.text().then(function (text) {
        let data = null
        try { data = text === '' ? null : JSON.parse(text) } catch (e) { data = null }
        if (!res.ok) {
          const message = data && data.error ? data.error : 'HTTP ' + res.status
          const error = new Error(message)
          error.status = res.status
          throw error
        }
        return data
      })
    }

    function apiGet(path) {
      return fetch(API + path, { cache: 'no-store' }).then(readJson)
    }

    function apiPost(path, body) {
      return fetch(API + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      }).then(readJson)
    }

    function errorText(error) {
      return error === null || error === undefined ? '' : String(error.message || error)
    }

    function newId() {
      return 'p-' + Math.random().toString(36).slice(2, 8)
    }

    // ---- 小部件 -----------------------------------------------------------

    function Row(props) { return h('div', { className: 'ih-row' }, props.children) }
    function Field(props) {
      return h('label', { className: 'ih-field' },
        h('span', { className: 'ih-label' }, props.label),
        props.hint ? h('span', { className: 'ih-hint' }, props.hint) : null,
        props.children)
    }
    function Banner(props) { return h('div', { className: 'ih-banner ih-banner-' + (props.kind || 'info') }, props.children) }

    // ---- 单个配置卡 -------------------------------------------------------

    function ProfileCard(props) {
      const { profile, providers, active, onChange, onRemove, onMakeActive } = props
      const [testing, setTesting] = useState(false)
      const [pulling, setPulling] = useState(false)
      const [note, setNote] = useState('')

      const provider = providers.find(function (p) { return p.id === profile.provider }) || null

      function update(patch) {
        onChange(Object.assign({}, profile, patch))
      }

      function changeProvider(id) {
        const next = providers.find(function (p) { return p.id === id })
        update({
          provider: id,
          baseURL: next ? next.defaultBaseURL : '',
          model: next && next.models.length > 0 ? next.models[0] : '',
          models: next ? next.models : [],
        })
        setNote('')
      }

      function test() {
        setTesting(true)
        setNote('')
        apiPost('/test', { profileId: profile.id }).then(function (result) {
          setNote(result && result.ok ? '✅ ' + (result.detail || '连接正常') : '❌ ' + ((result && result.error) || '测试失败'))
          setTesting(false)
        }).catch(function (error) {
          setNote('❌ ' + errorText(error))
          setTesting(false)
        })
      }

      function pullModels() {
        setPulling(true)
        setNote('')
        apiPost('/models', { profileId: profile.id }).then(function (result) {
          if (result && result.ok && Array.isArray(result.models)) {
            update({ models: result.models, model: profile.model || result.models[0] || '' })
            setNote('✅ 拉到 ' + result.models.length + ' 个模型')
          } else {
            setNote('❌ ' + ((result && result.error) || '拉取失败'))
          }
          setPulling(false)
        }).catch(function (error) {
          setNote('❌ ' + errorText(error))
          setPulling(false)
        })
      }

      const modelOptions = Array.from(new Set([].concat(profile.models || [], provider ? provider.models : [])))

      return h('div', { className: 'ih-card' },
        h('div', { className: 'ih-card-head' },
          h('div', { className: 'ih-card-title' },
            h('span', { className: 'ih-dot ' + (active ? 'ih-dot-on' : '') }),
            h('span', null, profile.name || provider && provider.label || profile.provider)),
          h('div', { className: 'ih-card-actions' },
            active ? h('span', { className: 'ih-tag' }, '默认')
              : h('button', { className: 'ih-btn', onClick: onMakeActive }, '设为默认'),
            h('button', { className: 'ih-btn', onClick: onRemove }, '删除'))),

        h(Row, null,
          h(Field, { label: '名称' },
            h('input', {
              className: 'ih-input',
              value: profile.name,
              placeholder: '例如：Labnana 主力',
              onChange: function (e) { update({ name: e.target.value }) },
            })),
          h(Field, { label: '接口类型' },
            h('select', {
              className: 'ih-input',
              value: profile.provider,
              onChange: function (e) { changeProvider(e.target.value) },
            }, providers.map(function (p) { return h('option', { key: p.id, value: p.id }, p.label) })))),

        h(Row, null,
          h(Field, { label: '接口地址', hint: provider && provider.defaultBaseURL ? '留空用 ' + provider.defaultBaseURL : '' },
            h('input', {
              className: 'ih-input',
              value: profile.baseURL,
              placeholder: provider ? provider.defaultBaseURL : '',
              onChange: function (e) { update({ baseURL: e.target.value }) },
            })),
          h(Field, { label: 'API Key', hint: profile.keyHint ? '已保存：' + profile.keyHint + '（留空表示不改）' : '本地保存，只发给上面的地址' },
            h('input', {
              className: 'ih-input',
              type: 'password',
              autoComplete: 'off',
              value: profile.apiKey || '',
              placeholder: profile.hasKey ? '••••••••' : '粘贴 Key',
              onChange: function (e) { update({ apiKey: e.target.value }) },
            }))),

        h(Row, null,
          h(Field, {
            label: '代理（可选）',
            hint: '形如 http://127.0.0.1:7890；只支持 http/https 代理，SOCKS 请把代理开成 TUN/全局',
          },
            h('input', {
              className: 'ih-input',
              value: profile.proxy || '',
              placeholder: '留空 = 直连',
              onChange: function (e) { update({ proxy: e.target.value }) },
            }))),

        h(Row, null,
          h(Field, { label: '模型' },
            h('input', {
              className: 'ih-input',
              value: profile.model,
              placeholder: '模型 id',
              list: 'ih-models-' + profile.id,
              onChange: function (e) { update({ model: e.target.value }) },
            }),
            h('datalist', { id: 'ih-models-' + profile.id },
              modelOptions.map(function (id) { return h('option', { key: id, value: id }) }))),
          h(Field, { label: '默认比例' },
            h('select', {
              className: 'ih-input',
              value: profile.aspectRatio || '1:1',
              onChange: function (e) { update({ aspectRatio: e.target.value }) },
            }, RATIOS.map(function (r) { return h('option', { key: r, value: r }, r) }))),
          h(Field, { label: '默认清晰度' },
            h('select', {
              className: 'ih-input',
              value: profile.imageSize || '2K',
              onChange: function (e) { update({ imageSize: e.target.value }) },
            }, SIZES.map(function (s) { return h('option', { key: s, value: s }, s) })))),

        provider && provider.needsWorkflow
          ? h(Field, { label: 'ComfyUI 工作流 JSON', hint: '支持 {{prompt}} {{negative}} {{width}} {{height}} {{seed}} 占位符' },
              h('textarea', {
                className: 'ih-input ih-textarea',
                rows: 6,
                value: (profile.extra && profile.extra.workflow) || '',
                onChange: function (e) { update({ extra: Object.assign({}, profile.extra, { workflow: e.target.value }) }) },
              }))
          : null,

        h('div', { className: 'ih-actions' },
          h('button', { className: 'ih-btn', disabled: testing, onClick: test }, testing ? '测试中…' : '测试连接'),
          h('button', { className: 'ih-btn', disabled: pulling || !(provider && provider.supports && provider.supports.listModels), onClick: pullModels },
            pulling ? '拉取中…' : '拉取模型'),
          note !== '' ? h('span', { className: 'ih-note' }, note) : null))
    }

    // ---- 主页面 -----------------------------------------------------------

    function HubSection() {
      const [data, setData] = useState(null)
      const [draft, setDraft] = useState(null)
      const [loading, setLoading] = useState(true)
      const [loadError, setLoadError] = useState('')
      const [saving, setSaving] = useState(false)
      const [message, setMessage] = useState('')

      useEffect(function () {
        let alive = true
        apiGet('/state').then(function (next) {
          if (!alive) return
          setData(next)
          setDraft({
            activeProfile: next.config.activeProfile || '',
            saveToWorkspace: next.config.saveToWorkspace !== false,
            workspaceFolder: next.config.workspaceFolder || 'dsh-image-hub',
            profiles: next.config.profiles || [],
          })
          setLoading(false)
        }).catch(function (error) {
          if (!alive) return
          setLoadError(errorText(error))
          setLoading(false)
        })
        return function () { alive = false }
      }, [])

      const providers = useMemo(() => (data ? data.providers : []), [data])

      function patchDraft(patch) {
        setDraft(function (previous) { return previous === null ? previous : Object.assign({}, previous, patch) })
      }

      function updateProfile(next) {
        patchDraft({
          profiles: draft.profiles.map(function (p) { return p.id === next.id ? Object.assign({}, p, next) : p }),
        })
      }

      function addProfile() {
        const provider = providers[0]
        if (provider === undefined) return
        const profile = {
          id: newId(),
          provider: provider.id,
          name: provider.label,
          baseURL: provider.defaultBaseURL,
          apiKey: '',
          model: provider.models[0] || '',
          models: provider.models || [],
          aspectRatio: '1:1',
          imageSize: '2K',
          proxy: '',
          extra: {},
        }
        patchDraft({ profiles: draft.profiles.concat([profile]) })
      }

      function removeProfile(id) {
        const remaining = draft.profiles.filter(function (p) { return p.id !== id })
        patchDraft({ profiles: remaining, activeProfile: draft.activeProfile === id ? (remaining[0] ? remaining[0].id : '') : draft.activeProfile })
      }

      function save() {
        setSaving(true)
        setMessage('')
        apiPost('/config', draft).then(function (result) {
          if (result && result.config) {
            setData({ config: result.config, providers: result.providers })
            setDraft({
              activeProfile: result.config.activeProfile || '',
              saveToWorkspace: result.config.saveToWorkspace !== false,
              workspaceFolder: result.config.workspaceFolder || 'dsh-image-hub',
              profiles: result.config.profiles || [],
            })
          }
          setMessage('已保存')
          setSaving(false)
        }).catch(function (error) {
          setMessage('保存失败：' + errorText(error))
          setSaving(false)
        })
      }

      if (loading) return h('div', { className: 'ih-root' }, h('div', { className: 'ih-muted' }, '正在读取配置…'))
      if (loadError !== '') {
        return h('div', { className: 'ih-root' },
          h(Banner, { kind: 'error' }, '读不到宿主配置：' + loadError),
          h('div', { className: 'ih-muted' }, '刚装好插件时请先重启一次 DSH。'))
      }
      if (draft === null) return null

      return h('div', { className: 'ih-root' },
        h('div', { className: 'ih-head' },
          h('div', null,
            h('div', { className: 'ih-title' }, '图像中枢 · 多 API 配置'),
            h('div', { className: 'ih-sub' }, '对话里用 image_generate / image_edit；这里配几套 API，模型随便切。')),
          h('button', { className: 'ih-btn ih-btn-primary', onClick: addProfile }, '+ 添加 API')),

        draft.profiles.length === 0
          ? h(Banner, { kind: 'warn' }, '还没有任何 API 配置。点右上角「+ 添加 API」，先加一套 Labnana 或 OpenAI 兼容的。')
          : draft.profiles.map(function (profile) {
              return h(ProfileCard, {
                key: profile.id,
                profile: profile,
                providers: providers,
                active: draft.activeProfile === profile.id || (draft.activeProfile === '' && draft.profiles[0] && draft.profiles[0].id === profile.id),
                onChange: updateProfile,
                onRemove: function () { removeProfile(profile.id) },
                onMakeActive: function () { patchDraft({ activeProfile: profile.id }) },
              })
            }),

        h('div', { className: 'ih-global' },
          h(Field, { label: '工作区保存', hint: '生成结果另存一份到当前会话目录' },
            h('div', { className: 'ih-inline' },
              h('label', { className: 'ih-check' },
                h('input', {
                  type: 'checkbox',
                  checked: draft.saveToWorkspace === true,
                  onChange: function (e) { patchDraft({ saveToWorkspace: e.target.checked }) },
                }),
                h('span', null, '启用')),
              h('input', {
                className: 'ih-input ih-input-folder',
                value: draft.workspaceFolder,
                placeholder: 'dsh-image-hub',
                disabled: draft.saveToWorkspace !== true,
                onChange: function (e) { patchDraft({ workspaceFolder: e.target.value }) },
              })))),

        h('div', { className: 'ih-actions' },
          h('button', { className: 'ih-btn ih-btn-primary', disabled: saving, onClick: save }, saving ? '保存中…' : '保存全部'),
          message !== '' ? h('span', { className: 'ih-note' }, message) : null),

        h('div', { className: 'ih-foot' },
          h('span', null, '配置：' + (data && data.config ? data.configPath || '' : '')),
          h('span', null, '工具：image_generate · image_edit')))
    }

    // ---- 样式 -------------------------------------------------------------

    const CSS = [
      '.ih-root{display:flex;flex-direction:column;gap:14px;padding:4px 2px 24px;color:var(--dsw-alias-label-primary,#1f1c18);font-size:13px;}',
      '.ih-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;}',
      '.ih-title{font-size:15px;font-weight:600;}',
      '.ih-sub{margin-top:4px;color:var(--dsw-alias-label-secondary,#6f6558);line-height:1.6;max-width:640px;}',
      '.ih-card{border:1px solid var(--dsw-alias-border-l2,#e3daca);border-radius:10px;padding:12px 14px;display:flex;flex-direction:column;gap:10px;background:var(--dsw-alias-bg-layer-1,#fffdf8);}',
      '.ih-card-head{display:flex;align-items:center;justify-content:space-between;gap:10px;}',
      '.ih-card-title{display:flex;align-items:center;gap:8px;font-weight:600;}',
      '.ih-card-actions{display:flex;gap:8px;align-items:center;}',
      '.ih-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-border-l2,#e3daca);display:inline-block;}',
      '.ih-dot-on{background:var(--dsw-alias-state-success-primary,#2f6b46);}',
      '.ih-tag{font-size:11px;padding:2px 8px;border-radius:999px;border:1px solid currentColor;color:var(--dsw-alias-state-success-primary,#2f6b46);}',
      '.ih-row{display:flex;gap:12px;flex-wrap:wrap;}',
      '.ih-row > .ih-field{flex:1 1 200px;min-width:160px;}',
      '.ih-field{display:flex;flex-direction:column;gap:5px;}',
      '.ih-label{font-weight:600;}',
      '.ih-hint,.ih-muted{color:var(--dsw-alias-label-tertiary,#8a7f6e);font-size:12px;line-height:1.5;}',
      '.ih-input{appearance:none;width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2,#e3daca);background:var(--dsw-alias-bg-layer-2,#f4efe4);color:inherit;border-radius:8px;padding:7px 10px;font:inherit;outline:none;}',
      '.ih-input:focus{border-color:var(--dsw-alias-brand-primary,#1f1c18);}',
      '.ih-textarea{font-family:ui-monospace,Consolas,monospace;font-size:12px;resize:vertical;}',
      '.ih-input-folder{flex:0 1 180px;}',
      '.ih-inline{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}',
      '.ih-check{display:inline-flex;align-items:center;gap:6px;white-space:nowrap;}',
      '.ih-btn{border:1px solid var(--dsw-alias-border-l2,#e3daca);background:var(--dsw-alias-bg-layer-2,#f4efe4);color:inherit;border-radius:8px;padding:7px 12px;font:inherit;cursor:pointer;white-space:nowrap;}',
      '.ih-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.10));}',
      '.ih-btn:disabled{opacity:.5;cursor:not-allowed;}',
      '.ih-btn-primary{background:var(--dsw-alias-brand-primary,#1f1c18);border-color:transparent;color:var(--dsw-alias-label-primary-foreground,#fffdf8);}',
      '.ih-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}',
      '.ih-note{font-size:12px;color:var(--dsw-alias-label-secondary,#6f6558);}',
      '.ih-banner{border-radius:8px;padding:9px 12px;line-height:1.6;border:1px solid transparent;font-size:12px;}',
      '.ih-banner-info{border-color:var(--dsw-alias-border-l2,#e3daca);color:var(--dsw-alias-label-secondary,#6f6558);}',
      '.ih-banner-warn{border-color:var(--dsw-alias-state-warn-primary,#8a6a2f);color:var(--dsw-alias-state-warn-primary,#8a6a2f);}',
      '.ih-banner-error{border-color:var(--dsw-alias-state-error-primary,#a83a2c);color:var(--dsw-alias-state-error-primary,#a83a2c);}',
      '.ih-global{border-top:1px solid var(--dsw-alias-border-l1,#ece5d8);padding-top:10px;display:flex;flex-direction:column;gap:8px;}',
      '.ih-foot{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;color:var(--dsw-alias-label-tertiary,#8a7f6e);font-size:11px;border-top:1px solid var(--dsw-alias-border-l1,#ece5d8);padding-top:10px;}',
    ].join('')

    // ---- 入口 -------------------------------------------------------------

    class ErrorBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }
      static getDerivedStateFromError(error) { return { error: error } }
      componentDidCatch(error) { console.error('[dsh-image-hub]', error) }
      render() {
        if (this.state.error) {
          return h('div', { className: 'ih-root' }, h(Banner, { kind: 'error' }, '图像中枢设置页渲染失败：' + errorText(this.state.error)))
        }
        return this.props.children
      }
    }

    function applySection(ctx) {
      ctx.effect(function () {
        const id = 'dsh-image-hub-style'
        if (document.getElementById(id) !== null) return function () {}
        const style = document.createElement('style')
        style.id = id
        style.textContent = CSS
        document.head.appendChild(style)
        return function () {
          const element = document.getElementById(id)
          if (element !== null && element.parentNode !== null) element.parentNode.removeChild(element)
        }
      }, 'dsh-image-hub: styles')

      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register({
          name: 'settings.section',
          id: 'image-hub',
          order: 48,
          locale: 'dsh-image-hub',
          label: function () { return '图像中枢' },
        }, function (props) {
          const p = props !== null && props !== undefined ? props : {}
          return h(ErrorBoundary, { key: String(p.sessionId || 'global') }, h(HubSection, p))
        })
      })
    }

    function apply(ctx) {
      try {
        applySection(ctx)
      } catch (error) {
        console.error('[dsh-image-hub] 设置页挂载失败：', error)
      }
    }

    module.exports = { name: 'image-hub', inject: ['slots'], apply: apply }
    return module.exports
  },
})
