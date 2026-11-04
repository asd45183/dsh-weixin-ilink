window.__ModuleLoader__.load({
  id: 'dsh-weixin-ilink',
  factory: require => {
    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const { createElement: h, useEffect, useRef, useState } = React
    const Button = primitives.Button, Input = primitives.Input || 'input'
    const PREFIX = '/api/weixin-settings', RPC_CHANNEL = '/weixin-settings'
    const routes = new Set(['/state', '/login/start', '/login/poll', '/login/cancel', '/logout', '/save'])
    const column = { display: 'flex', flexDirection: 'column', gap: 10 }
    const row = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }
    const muted = { color: 'var(--dsw-alias-label-tertiary)', fontSize: 13, margin: 0 }
    const control = { font: 'inherit', color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-base)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, padding: 8, maxWidth: '100%', width: '100%', boxSizing: 'border-box' }
    const note = (text, key) => h('p', { key, style: muted }, text)
    const section = (title, ...children) => h('section', { key: title, style: { ...column, marginBottom: 18 } }, h('h3', { style: { margin: '4px 0 2px' } }, title), ...children)
    const fmt = ts => Number.isFinite(ts) && ts > 0 ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : '暂无'

    function createTransport(globals, rpc) {
      const carrier = globals.__DSH_TRANSPORT__
      const address = globals.location
      const http = address && ['http:', 'https:'].includes(address.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(address.hostname)
      const fetcher = typeof carrier?.fetch === 'function' ? carrier.fetch.bind(carrier) : http && typeof globals.fetch === 'function' ? globals.fetch.bind(globals) : null
      let token = ''
      return {
        async request(route, input) {
          if (!routes.has(route)) throw new Error('只允许本插件的设置接口。')
          if (!fetcher && typeof rpc?.call !== 'function') throw new Error('当前 DSH 页面没有可用的插件设置通信接口。')
          if (input !== undefined && !token) throw new Error('请先刷新设置页，核实当前状态。')
          const signal = AbortSignal.timeout(route === '/state' ? 20_000 : 65_000)
          let response
          if (!fetcher && typeof rpc?.call === 'function') {
            const reply = await rpc.call(RPC_CHANNEL, 'request', { path: route, ...(input === undefined ? {} : { input }), token }, signal)
            if (!reply?.ok) throw new Error(reply?.error?.message || 'DSH 设置通信失败。')
            const outcome = reply.value
            if (!Number.isInteger(outcome?.status) || !outcome.body) throw new Error('DSH 设置接口版本不匹配，请重启 DSH。')
            response = { status: outcome.status, ok: outcome.status >= 200 && outcome.status < 300, json: async () => outcome.body }
          } else {
            response = await fetcher(PREFIX + route, { method: input === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', signal, headers: { 'content-type': 'application/json', ...(token ? { 'x-weixin-settings-token': token } : {}) }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) })
          }
          let value
          try { value = await response.json() } catch { throw new Error(`设置接口未返回 JSON（HTTP ${response.status || '未知'}）。`) }
          if (!response.ok) throw new Error(value.error || '设置操作未完成。')
          if (route === '/state') { if (typeof value.token !== 'string' || !value.token) throw new Error('设置未取得有效会话。'); token = value.token; const { token: hidden, ...state } = value; return state }
          return value
        },
      }
    }

    function SettingsPage({ rpc } = {}) {
      const [api] = useState(() => createTransport(globalThis, rpc))
      const [state, setState] = useState(null)
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const [busy, setBusy] = useState('')
      const [login, setLogin] = useState(null)
      const [senderText, setSenderText] = useState('')
      const [groupText, setGroupText] = useState('')
      const [workspace, setWorkspace] = useState('')
      const [confirmId, setConfirmId] = useState('')
      const alive = useRef(true)

      const applyState = value => {
        setState(value)
        setSenderText((value.settings?.allowedSenders || []).join('\n'))
        setGroupText((value.settings?.allowedGroups || []).join('\n'))
        setWorkspace(value.settings?.workspace || '')
        if (value.login) setLogin(value.login)
      }
      async function refresh() {
        try { applyState(await api.request('/state')); setError('') } catch (failure) { setError(failure.message) }
      }
      useEffect(() => { alive.current = true; void refresh(); return () => { alive.current = false } }, [api])

      // 登录二维码轮询：等待扫码确认，成功后刷新状态并停止。
      useEffect(() => {
        if (!login || ['confirmed', 'blocked', 'error'].includes(login.status)) return
        let running = false
        const timer = setInterval(async () => {
          if (running) return
          running = true
          try {
            const value = await api.request('/login/poll', {})
            if (!alive.current) return
            setLogin(value.status ? value : null)
            if (value.status === 'confirmed') { setNotice(value.message || '登录成功。'); await refresh(); clearInterval(timer) }
            else if (['blocked', 'error'].includes(value.status)) { setError(value.message || '登录未完成。'); clearInterval(timer) }
          } catch (failure) { if (alive.current) setError(failure.message) }
          finally { running = false }
        }, 2500)
        return () => clearInterval(timer)
      }, [login?.status, api])

      async function act(key, action) {
        if (busy) return
        setBusy(key); setError(''); setNotice('')
        try { return await action() } catch (failure) { setError(failure.message) } finally { setBusy('') }
      }
      const save = patch => act('save', async () => { const value = await api.request('/save', { patch }); applyState(value); setNotice('已保存。') })
      const toggle = (key, label) => h('label', { key, style: row }, h('input', { type: 'checkbox', checked: state?.settings?.[key] === true, onChange: event => { const checked = event.target.checked; setState(current => ({ ...current, settings: { ...current.settings, [key]: checked } })); void save({ [key]: checked }) } }), label)
      const startLogin = () => act('login', async () => { const value = await api.request('/login/start', {}); setLogin(value); setNotice('请用微信扫描二维码。') })
      const refreshQr = () => act('login', async () => { const value = await api.request('/login/start', {}); setLogin(value) })
      const cancelLogin = () => act('login', async () => { await api.request('/login/cancel', {}); setLogin(null) })

      const accounts = state?.accounts || []
      const recent = state?.senders || []
      return h('div', { style: column },
        h('h2', { style: { margin: '0 0 4px' } }, '微信通道'),
        note('iLink 是逆向的个人微信协议，建议使用小号。凭据保存在本机 0600 文件，不会显示 token。'),
        error && h('p', { role: 'alert', style: { color: 'var(--dsw-alias-label-error, #c0392b)' } }, error),
        notice && h('p', { role: 'status', style: muted }, notice),
        !state ? note('正在读取微信通道状态…') : null,

        state && section('账号',
          note(`已绑定 ${accounts.length} 个账号 · 会话 ${state.conversations?.count || 0} 个 · 最近消息 ${fmt(state.conversations?.lastInboundAt)}`),
          ...accounts.map(account => h('div', { key: account.id, style: { ...row, justifyContent: 'space-between', borderBottom: '1px solid var(--dsw-alias-border-l2)', padding: '6px 0' } },
            h('span', null, `${account.masked} · ${account.ready ? '凭据有效' : '缺少凭据'}${account.host ? ` · ${account.host}` : ''}`),
            Button ? h(Button, { type: 'button', size: 'sm', variant: confirmId === account.id ? 'danger' : 'outline', onClick: () => { if (confirmId !== account.id) { setConfirmId(account.id); setTimeout(() => setConfirmId(current => current === account.id ? '' : current), 6000); return } setConfirmId(''); void act('logout', async () => { await api.request('/logout', { accountId: account.id }); setNotice('已退出该账号。'); await refresh() }) } }, confirmId === account.id ? '确认退出' : '退出登录') : h('button', { type: 'button', onClick: () => {} }, '退出登录')
          )),
          h('div', { style: row },
            Button ? h(Button, { type: 'button', size: 'sm', onClick: startLogin, disabled: busy === 'login' }, busy === 'login' ? '获取二维码…' : '扫码登录') : null,
            login ? (Button ? h(Button, { type: 'button', size: 'sm', variant: 'outline', onClick: refreshQr }, '刷新二维码') : null) : null,
            login ? (Button ? h(Button, { type: 'button', size: 'sm', variant: 'outline', onClick: cancelLogin }, '取消登录') : null) : null
          ),
          login && login.image ? h('div', { style: column },
            h('img', { src: login.image, alt: '微信登录二维码', style: { width: 260, height: 260, background: '#fff', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8 } }),
            note(({ wait: '等待扫码', scaned: '已扫码，请在手机确认', expired: '二维码已过期，点“刷新二维码”', confirmed: '已登录', blocked: '该机器人仍绑定在本机，请先在微信解除绑定', error: '登录出错' }[login.status] || login.status) + (login.expiresAt ? ` · 有效期至 ${new Date(login.expiresAt).toLocaleTimeString('zh-CN', { hour12: false })}` : '')),
            login.message ? note(login.message) : null
          ) : null,
          note('登录成功后新账号在重启 DSH 后开始接收消息。')
        ),

        state && section('授权',
          h('label', { style: column }, '允许的发送者（每行一个微信 id）', h('textarea', { value: senderText, onChange: event => setSenderText(event.target.value), rows: 3, style: control })),
          h('div', { style: row }, Button ? h(Button, { type: 'button', size: 'sm', onClick: () => save({ allowedSenders: senderText.split('\n').map(item => item.trim()).filter(Boolean) }) }, '保存发送者') : null),
          toggle('allowFirstContact', '允许首次接触（仅配置用）'),
          toggle('groupChatEnabled', '服务群聊'),
          h('label', { style: row }, '群聊触发', h('select', { value: state.settings?.groupReplyWhen || 'mention', onChange: event => { const value = event.target.value; setState(current => ({ ...current, settings: { ...current.settings, groupReplyWhen: value } })); void save({ groupReplyWhen: value }) }, style: { ...control, width: 'auto' } }, h('option', { value: 'mention' }, '仅被 @'), h('option', { value: 'all' }, '全部消息'))),
          h('label', { style: column }, '允许的群聊（每行一个群 id；留空表示任意群）', h('textarea', { value: groupText, onChange: event => setGroupText(event.target.value), rows: 2, style: control })),
          h('div', { style: row }, Button ? h(Button, { type: 'button', size: 'sm', onClick: () => save({ allowedGroups: groupText.split('\n').map(item => item.trim()).filter(Boolean) }) }, '保存群聊') : null),
          recent.length ? h('div', { style: column }, note('最近发送者（点击加入白名单）'), ...recent.slice(0, 10).map(rowItem => h('div', { key: rowItem.senderId, style: row },
            h('code', { style: { fontSize: 12 } }, rowItem.senderId),
            note(rowItem.isGroup ? '群聊' : '个人'),
            note(fmt(rowItem.lastAt)),
            Button ? h(Button, { type: 'button', size: 'sm', variant: 'outline', onClick: () => { if (senderText.includes(rowItem.senderId)) return; const next = [senderText.trim(), rowItem.senderId].filter(Boolean).join('\n'); setSenderText(next); void save({ allowedSenders: next.split('\n') }) } }, '加入白名单') : null
          ))) : note('还没有记录到发送者；收到消息后会出现在这里。')
        ),

        state && section('人格模式',
          note('默认人格只影响“新会话”；已有会话用 /mode 单独覆盖。当前默认：' + (state.persona?.modes.find(mode => mode.id === state.persona?.defaultMode)?.name || state.persona?.defaultMode || 'default')),
          h('label', { style: row }, '默认人格',
            h('select', { value: state.persona?.defaultMode || 'default', onChange: event => { const value = event.target.value; setState(current => ({ ...current, persona: { ...current.persona, defaultMode: value } })); void save({ personaDefaultMode: value }) }, style: { ...control, width: 'auto' } },
              ...(state.persona?.modes || []).map(mode => h('option', { key: mode.id, value: mode.id }, `${mode.name}${mode.id === 'default' ? '（默认助手）' : ''}`))
            )
          ),
          ...(state.persona?.modes || []).map(mode => h('div', { key: mode.id, style: { ...column, borderLeft: '2px solid var(--dsw-alias-border-l2)', paddingLeft: 8 } },
            h('strong', null, `${mode.name} · ${mode.id}${mode.builtin ? ' · 内置' : ''}`),
            mode.preview ? note(mode.preview) : note('空提示词，等同默认助手。')
          ))
        ),

        state && section('运行',
          toggle('enabled', '启用通道'),
          toggle('mediaEnabled', '收发媒体（图片/文件/语音/视频）'),
          toggle('imageAsFile', '图片以文件附件发送（关闭则用图片气泡）'),
          toggle('typingIndicator', '显示“正在输入”'),
          toggle('proactiveEnabled', '允许主动消息'),
          h('label', { style: column }, '会话工作目录（agent cwd 与写入边界）', h('input', { value: workspace, onChange: event => setWorkspace(event.target.value), placeholder: '~/.dsh/weixin-own/sessions', style: control })),
          h('div', { style: row }, Button ? h(Button, { type: 'button', size: 'sm', onClick: () => save({ workspace }) }, '保存工作目录') : null),
          h('label', { style: row }, '权限预设', h('select', { value: state.settings?.permissionPreset || 'workspace-write', onChange: event => save({ permissionPreset: event.target.value }), style: { ...control, width: 'auto' } }, h('option', { value: 'workspace-write' }, '工作区内写入'), h('option', { value: 'danger-full-access' }, '整盘写入（仅可信账号）'))),
          note('工作目录、权限预设和账号轮询范围修改后需要重启 DSH；白名单与开关保存后立即用于新消息。')
        )
      )
    }

    function apply(ctx) {
      let rpc
      try { rpc = (ctx.get?.('connection') || ctx.connection)?.rpc } catch {}
      const Page = rpc ? () => h(SettingsPage, { rpc }) : SettingsPage
      ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'weixin-ilink', order: 15, label: () => '微信' }, Page))
    }
    return { name: 'weixin-settings', inject: ['slots', 'connection'], apply, SettingsPage, createTransport }
  },
})
