/**
 * dsh-image-hub —— 浏览器半（手写 __ModuleLoader__ bundle，无构建工具）。
 *
 * 设置页「生图配置」：
 *   - 多套 API，每套卡片独立：保存 / 取消 / 恢复默认 / 启用停用 / 删除
 *   - 拉取模型、测试连接（都针对这一套）
 *   - 全局：默认用哪套、结果是否存工作区、保存全局设置
 *
 * 事故教训：factory 必须自己声明 module/exports；apply 不能抛异常；
 * 加载器缺失时静默跳过。否则整个 web boot 会被拖死。
 */

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
    const RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9']
    const RATIO_LABELS = {
      '1:1': '方形', '2:3': '照片', '3:2': '横版照片', '3:4': '竖版海报', '4:3': '传统横版',
      '4:5': '大画幅', '5:4': '横版大画幅', '9:16': '竖版', '16:9': '横版', '21:9': '超宽屏',
    }
    const SIZES = ['1K', '2K', '4K']
    /** 常见模型 id 的中文注解（只影响显示，不影响请求） */
    const MODEL_NOTES = {
      'gemini-3.1-flash-image': 'Nano Banana Flash（快、便宜）',
      'gemini-3-pro-image': 'Nano Banana Pro（质量优先）',
      'gpt-image-2': 'GPT-Image-2',
      'gpt-image-2.5-flare': 'GPT-Image-2.5 Flare（偏快）',
      'gpt-image-2.5-sunburst': 'GPT-Image-2.5 Sunburst（偏细节）',
      'wan2.7-image': 'Wan 2.7',
      'wan2.7-image-pro': 'Wan 2.7 Pro',
      'seedream-5-0-pro': 'Seedream 5.0 Pro',
    }

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

    function apiGet(path) { return fetch(API + path, { cache: 'no-store' }).then(readJson) }
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

    function modelLabel(id) {
      return MODEL_NOTES[id] ? id + ' — ' + MODEL_NOTES[id] : id
    }

    // ---- 小组件 -----------------------------------------------------------

    function Row(props) { return h('div', { className: 'ih-row' }, props.children) }
    function Field(props) {
      return h('label', { className: 'ih-field' },
        h('span', { className: 'ih-label' }, props.label),
        props.hint ? h('span', { className: 'ih-hint' }, props.hint) : null,
        props.children)
    }
    function Banner(props) { return h('div', { className: 'ih-banner ih-banner-' + (props.kind || 'info') }, props.children) }

    // ---- 单张配置卡 -------------------------------------------------------

    function ProfileCard(props) {
      const { profile, providers, active, onServer, onMakeActive, onRemove } = props
      // 卡片内的草稿：保存前只改这里，取消就回到 profile
      const [form, setForm] = useState(profile)
      const [busy, setBusy] = useState('')
      const [note, setNote] = useState('')
      const [customModel, setCustomModel] = useState(false)

      useEffect(function () {
        setForm(profile)
      }, [profile.id, profile.enabled, profile.keyHint])

      const provider = providers.find(function (p) { return p.id === form.provider }) || null
      const isSubscription = Boolean(provider && provider.subscription)
      const dirty = JSON.stringify({
        name: form.name, baseURL: form.baseURL, apiKey: form.apiKey || '', model: form.model,
        aspectRatio: form.aspectRatio, imageSize: form.imageSize, proxy: form.proxy || '',
      }) !== JSON.stringify({
        name: profile.name, baseURL: profile.baseURL, apiKey: '', model: profile.model,
        aspectRatio: profile.aspectRatio, imageSize: profile.imageSize, proxy: profile.proxy || '',
      })

      const modelOptions = Array.from(new Set([].concat(form.models || [], provider ? provider.models : []))).filter(Boolean)

      function set(patch) {
        setForm(function (previous) { return Object.assign({}, previous, patch) })
      }

      function changeProvider(id) {
        const next = providers.find(function (p) { return p.id === id }) || null
        set({
          provider: id,
          baseURL: next ? next.defaultBaseURL : '',
          model: next && next.models.length > 0 ? next.models[0] : '',
          models: next ? next.models : [],
        })
        setNote('')
        setCustomModel(false)
      }

      function save() {
        if (busy !== '') return
        setBusy('save')
        apiPost('/profile', { profile: form }).then(function (result) {
          if (result && result.config) {
            onServer(result)
            const updated = (result.config.profiles || []).find(function (p) { return p.id === form.id })
            if (updated) setForm(updated)
          }
          setNote('✅ 这一套已保存')
          setBusy('')
        }).catch(function (error) {
          setNote('❌ 保存失败：' + errorText(error))
          setBusy('')
        })
      }

      function cancel() {
        setForm(profile)
        setCustomModel(false)
        setNote('已取消未保存的改动')
      }

      function resetDefaults() {
        const next = providers.find(function (p) { return p.id === form.provider }) || null
        setForm(Object.assign({}, form, {
          baseURL: next ? next.defaultBaseURL : '',
          model: next && next.models.length > 0 ? next.models[0] : '',
          models: next ? next.models : [],
          aspectRatio: '1:1',
          imageSize: '2K',
          proxy: '',
        }))
        setCustomModel(false)
        setNote('已恢复这套接口的默认值（还没保存）')
      }

      function toggle() {
        if (busy !== '') return
        setBusy('toggle')
        apiPost('/profile/toggle', { id: profile.id, enabled: !(profile.enabled !== false) }).then(function (result) {
          if (result && result.config) onServer(result)
          setBusy('')
        }).catch(function (error) {
          setNote('❌ 切换失败：' + errorText(error))
          setBusy('')
        })
      }

      function test() {
        setBusy('test')
        setNote('')
        apiPost('/test', { profileId: profile.id }).then(function (result) {
          setNote(result && result.ok ? '✅ ' + (result.detail || '连接正常') : '❌ ' + ((result && result.error) || '测试失败'))
          setBusy('')
        }).catch(function (error) {
          setNote('❌ ' + errorText(error))
          setBusy('')
        })
      }

      function pullModels() {
        setBusy('pull')
        setNote('')
        apiPost('/models', { profileId: profile.id }).then(function (result) {
          if (result && result.ok && Array.isArray(result.models)) {
            set({ models: result.models, model: form.model || result.models[0] || '' })
            setCustomModel(false)
            setNote('✅ 拉到 ' + result.models.length + ' 个模型（点保存生效）')
          } else {
            setNote('❌ ' + ((result && result.error) || '拉取失败'))
          }
          setBusy('')
        }).catch(function (error) {
          setNote('❌ ' + errorText(error))
          setBusy('')
        })
      }

      const customSelected = customModel || (form.model !== '' && modelOptions.indexOf(form.model) === -1)

      return h('div', { className: 'ih-card' + (profile.enabled === false ? ' ih-card-off' : '') },
        h('div', { className: 'ih-card-head' },
          h('div', { className: 'ih-card-title' },
            h('span', { className: 'ih-dot ' + (profile.enabled === false ? '' : 'ih-dot-on') }),
            h('span', null, form.name || (provider && provider.label) || form.provider),
            profile.enabled === false ? h('span', { className: 'ih-tag ih-tag-off' }, '已停用') : null,
            active ? h('span', { className: 'ih-tag' }, '默认') : null,
            dirty ? h('span', { className: 'ih-tag ih-tag-dirty' }, '未保存') : null),
          h('div', { className: 'ih-card-actions' },
            active ? null : h('button', { className: 'ih-btn', onClick: onMakeActive }, '设为默认'),
            h('button', { className: 'ih-btn', onClick: toggle, disabled: busy !== '' },
              profile.enabled === false ? '启用' : '停用'))),

        h(Row, null,
          h(Field, { label: '名称' },
            h('input', {
              className: 'ih-input',
              value: form.name,
              placeholder: '例如：Labnana 主力',
              onChange: function (e) { set({ name: e.target.value }) },
            })),
          h(Field, { label: '接口类型' },
            h('select', {
              className: 'ih-input',
              value: form.provider,
              onChange: function (e) { changeProvider(e.target.value) },
            }, providers.map(function (p) {
              return h('option', { key: p.id, value: p.id }, p.label)
            })))),

        isSubscription
          ? h(Banner, { kind: 'warn' }, '这个通道走账号登录（不是 API Key），当前版本还没接入登录流程——可以先存着，等以后支持了直接启用。')
          : h(Row, null,
              h(Field, { label: '接口地址', hint: provider && provider.defaultBaseURL ? '留空用 ' + provider.defaultBaseURL : '' },
                h('input', {
                  className: 'ih-input',
                  value: form.baseURL,
                  placeholder: provider ? provider.defaultBaseURL : '',
                  onChange: function (e) { set({ baseURL: e.target.value }) },
                })),
              h(Field, { label: 'API Key', hint: profile.keyHint ? '已保存：' + profile.keyHint + '（留空表示不改）' : '只保存在本机' },
                h('input', {
                  className: 'ih-input',
                  type: 'password',
                  autoComplete: 'off',
                  value: form.apiKey || '',
                  placeholder: profile.hasKey ? '••••••••' : '粘贴 Key',
                  onChange: function (e) { set({ apiKey: e.target.value }) },
                }))),

        isSubscription
          ? null
          : h(Row, null,
              h(Field, { label: '代理（可选）', hint: 'http/https 代理；SOCKS 请用 TUN 模式' },
                h('input', {
                  className: 'ih-input',
                  value: form.proxy || '',
                  placeholder: '留空 = 直连',
                  onChange: function (e) { set({ proxy: e.target.value }) },
                }))),

        isSubscription
          ? null
          : h(Row, null,
              h(Field, {
                label: '模型',
                hint: modelOptions.length > 0 ? '共 ' + modelOptions.length + ' 个；网站上叫法可能不同，API 只认 id' : '点「拉取模型」自动获取，或手填',
              },
                h('select', {
                  className: 'ih-input',
                  value: customSelected ? '__custom__' : (form.model || '__custom__'),
                  onChange: function (e) {
                    if (e.target.value === '__custom__') { setCustomModel(true); return }
                    setCustomModel(false)
                    set({ model: e.target.value })
                  },
                },
                  modelOptions.map(function (id) { return h('option', { key: id, value: id }, modelLabel(id)) }),
                  h('option', { key: '__custom__', value: '__custom__' }, '手动输入…')),
                customSelected
                  ? h('input', {
                      className: 'ih-input',
                      value: form.model,
                      placeholder: '模型 id',
                      onChange: function (e) { set({ model: e.target.value }) },
                    })
                  : null),
              h(Field, { label: '默认比例' },
                h('select', {
                  className: 'ih-input',
                  value: form.aspectRatio || '1:1',
                  onChange: function (e) { set({ aspectRatio: e.target.value }) },
                }, RATIOS.map(function (r) {
                  return h('option', { key: r, value: r }, r + (RATIO_LABELS[r] ? ' · ' + RATIO_LABELS[r] : ''))
                }))),
              h(Field, { label: '默认清晰度' },
                h('select', {
                  className: 'ih-input',
                  value: form.imageSize || '2K',
                  onChange: function (e) { set({ imageSize: e.target.value }) },
                }, SIZES.map(function (s) { return h('option', { key: s, value: s }, s) })))),

        provider && provider.needsWorkflow
          ? h(Field, { label: 'ComfyUI 工作流 JSON', hint: '支持 {{prompt}} {{negative}} {{width}} {{height}} {{seed}}' },
              h('textarea', {
                className: 'ih-input ih-textarea',
                rows: 6,
                value: (form.extra && form.extra.workflow) || '',
                onChange: function (e) { set({ extra: Object.assign({}, form.extra, { workflow: e.target.value }) }) },
              }))
          : null,

        h('div', { className: 'ih-actions' },
          h('button', { className: 'ih-btn ih-btn-primary', onClick: save, disabled: busy !== '' || !dirty }, busy === 'save' ? '保存中…' : '保存'),
          h('button', { className: 'ih-btn', onClick: cancel, disabled: busy !== '' || !dirty }, '取消'),
          h('button', { className: 'ih-btn', onClick: resetDefaults, disabled: busy !== '' }, '恢复默认'),
          h('span', { className: 'ih-sep' }),
          h('button', { className: 'ih-btn', onClick: test, disabled: busy !== '' || isSubscription }, busy === 'test' ? '测试中…' : '测试连接'),
          h('button', {
            className: 'ih-btn',
            onClick: pullModels,
            disabled: busy !== '' || isSubscription || !(provider && provider.supports && provider.supports.listModels),
          }, busy === 'pull' ? '拉取中…' : '拉取模型'),
          h('span', { className: 'ih-sep' }),
          h('button', { className: 'ih-btn ih-btn-danger', onClick: onRemove, disabled: busy !== '' }, '删除')),
        note !== '' ? h('div', { className: 'ih-note' }, note) : null)
    }

    // ---- 主页面 -----------------------------------------------------------

    function HubSection() {
      const [data, setData] = useState(null)
      const [globals, setGlobals] = useState(null)
      const [loading, setLoading] = useState(true)
      const [loadError, setLoadError] = useState('')
      const [saving, setSaving] = useState(false)
      const [message, setMessage] = useState('')

      useEffect(function () {
        let alive = true
        apiGet('/state').then(function (next) {
          if (!alive) return
          setData(next)
          setGlobals({
            activeProfile: next.config.activeProfile || '',
            saveToWorkspace: next.config.saveToWorkspace !== false,
            workspaceFolder: next.config.workspaceFolder || 'dsh-image-hub',
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

      function applyServer(result) {
        if (!result || !result.config) return
        setData({ config: result.config, providers: result.providers })
        setGlobals({
          activeProfile: result.config.activeProfile || '',
          saveToWorkspace: result.config.saveToWorkspace !== false,
          workspaceFolder: result.config.workspaceFolder || 'dsh-image-hub',
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
          enabled: true,
          extra: {},
        }
        apiPost('/profile', { profile }).then(applyServer).catch(function (error) { setMessage('新建失败：' + errorText(error)) })
      }

      function removeProfile(id) {
        apiPost('/profile', { profile: { id, provider: 'labnana' }, remove: true })
          .then(function (result) {
            applyServer(result)
            setMessage('已删除这套配置')
          })
          .catch(function (error) { setMessage('删除失败：' + errorText(error)) })
      }

      function saveGlobal() {
        if (globals === null || data === null) return
        setSaving(true)
        setMessage('')
        apiPost('/config', Object.assign({}, globals, {
          profiles: data.config.profiles.map(function (p) {
            return {
              id: p.id, provider: p.provider, name: p.name, baseURL: p.baseURL, model: p.model,
              models: p.models, aspectRatio: p.aspectRatio, imageSize: p.imageSize, proxy: p.proxy,
              enabled: p.enabled, extra: p.extra,
            }
          }),
        })).then(function (result) {
          applyServer(result)
          setMessage('全局设置已保存')
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
      if (data === null || globals === null) return null

      const profiles = data.config.profiles || []

      return h('div', { className: 'ih-root' },
        h('div', { className: 'ih-head' },
          h('div', null,
            h('div', { className: 'ih-title' }, '生图配置 · 多 API'),
            h('div', { className: 'ih-sub' }, '每套 API 独立保存；对话里用 image_generate / image_edit，可用 profile 参数指定哪一套。')),
          h('button', { className: 'ih-btn ih-btn-primary', onClick: addProfile }, '+ 添加 API')),

        profiles.length === 0
          ? h(Banner, { kind: 'warn' }, '还没有任何 API 配置。点右上角「+ 添加 API」，先加一套 Labnana 或 OpenAI 兼容的。')
          : profiles.map(function (profile) {
              return h(ProfileCard, {
                key: profile.id,
                profile: profile,
                providers: providers,
                active: globals.activeProfile === profile.id || (globals.activeProfile === '' && profiles[0] && profiles[0].id === profile.id),
                onServer: applyServer,
                onRemove: function () { removeProfile(profile.id) },
                onMakeActive: function () {
                  setGlobals(Object.assign({}, globals, { activeProfile: profile.id }))
                  setMessage('已选为默认（点「保存全局设置」生效）')
                },
              })
            }),

        h('div', { className: 'ih-global' },
          h(Field, { label: '工作区保存', hint: '生成结果另存一份到当前会话目录' },
            h('div', { className: 'ih-inline' },
              h('label', { className: 'ih-check' },
                h('input', {
                  type: 'checkbox',
                  checked: globals.saveToWorkspace === true,
                  onChange: function (e) { setGlobals(Object.assign({}, globals, { saveToWorkspace: e.target.checked })) },
                }),
                h('span', null, '启用')),
              h('input', {
                className: 'ih-input ih-input-folder',
                value: globals.workspaceFolder,
                placeholder: 'dsh-image-hub',
                disabled: globals.saveToWorkspace !== true,
                onChange: function (e) { setGlobals(Object.assign({}, globals, { workspaceFolder: e.target.value })) },
              })))),

        h('div', { className: 'ih-actions' },
          h('button', { className: 'ih-btn ih-btn-primary', disabled: saving, onClick: saveGlobal }, saving ? '保存中…' : '保存全局设置'),
          message !== '' ? h('span', { className: 'ih-note' }, message) : null),

        h('div', { className: 'ih-foot' },
          h('span', null, '工具：image_generate · image_edit'),
          h('span', null, '共 ' + profiles.length + ' 套配置')))
    }

    // ---- 样式 -------------------------------------------------------------

    const CSS = [
      '.ih-root{display:flex;flex-direction:column;gap:14px;padding:4px 2px 24px;color:var(--dsw-alias-label-primary,#1f1c18);font-size:13px;}',
      '.ih-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;}',
      '.ih-title{font-size:15px;font-weight:600;}',
      '.ih-sub{margin-top:4px;color:var(--dsw-alias-label-secondary,#6f6558);line-height:1.6;max-width:640px;}',
      '.ih-card{border:1px solid var(--dsw-alias-border-l2,#e3daca);border-radius:10px;padding:12px 14px;display:flex;flex-direction:column;gap:10px;background:var(--dsw-alias-bg-layer-1,#fffdf8);}',
      '.ih-card-off{opacity:.7;}',
      '.ih-card-head{display:flex;align-items:center;justify-content:space-between;gap:10px;}',
      '.ih-card-title{display:flex;align-items:center;gap:8px;font-weight:600;flex-wrap:wrap;}',
      '.ih-card-actions{display:flex;gap:8px;align-items:center;}',
      '.ih-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-border-l2,#e3daca);display:inline-block;}',
      '.ih-dot-on{background:var(--dsw-alias-state-success-primary,#2f6b46);}',
      '.ih-tag{font-size:11px;padding:2px 8px;border-radius:999px;border:1px solid currentColor;color:var(--dsw-alias-state-success-primary,#2f6b46);}',
      '.ih-tag-off{color:var(--dsw-alias-label-tertiary,#8a7f6e);}',
      '.ih-tag-dirty{color:var(--dsw-alias-state-warn-primary,#8a6a2f);}',
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
      '.ih-btn:disabled{opacity:.45;cursor:not-allowed;}',
      '.ih-btn-primary{background:var(--dsw-alias-brand-primary,#1f1c18);border-color:transparent;color:var(--dsw-alias-label-primary-foreground,#fffdf8);}',
      '.ih-btn-danger{color:var(--dsw-alias-state-error-primary,#a83a2c);}',
      '.ih-sep{width:1px;height:18px;background:var(--dsw-alias-border-l2,#e3daca);}',
      '.ih-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
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
          return h('div', { className: 'ih-root' }, h(Banner, { kind: 'error' }, '生图配置页渲染失败：' + errorText(this.state.error)))
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
          label: function () { return '生图配置' },
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
