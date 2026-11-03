// Browser half of dsh-github-sync.
//
// Hand-written in the `window.__ModuleLoader__.load` bundle format the Client
// module system serves at /plugins/dsh-github-sync/client.js. It adds one tab to
// the Plugins page and talks to the Host half over same-origin
// fetch('/dsh-github-sync/api/...') — no typert Remote generation is available
// to a plain-JS bundle.

window.__ModuleLoader__.load({
  id: 'dsh-github-sync',
  factory: function (require) {
    var React = require('react')
    var h = React.createElement
    var API = '/dsh-github-sync/api/'

    var CSS = [
      '.dsh-gs{color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5;padding:4px 20px 24px;max-width:900px}',
      '.dsh-gs h2{font-size:15px;font-weight:600;margin:0 0 2px}',
      '.dsh-gs .dsh-gs-sub{color:var(--dsw-alias-label-secondary);font-size:12px;margin:0 0 16px}',
      '.dsh-gs-card{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:14px 16px;margin-bottom:14px;background:var(--dsw-alias-bg-layer-1)}',
      '.dsh-gs-card h3{margin:0 0 10px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--dsw-alias-label-secondary);font-weight:600}',
      '.dsh-gs-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:6px 0}',
      '.dsh-gs-label{flex:0 0 84px;color:var(--dsw-alias-label-secondary);font-size:12px}',
      '.dsh-gs input[type=text]{flex:1 1 300px;min-width:0;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:7px 10px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:12px;font-family:inherit}',
      '.dsh-gs input[type=text]:focus{outline:none;border-color:var(--dsw-alias-state-business-primary)}',
      '.dsh-gs button{cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 14px;font-size:12px;font-family:inherit}',
      '.dsh-gs button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsh-gs button.primary{background:var(--dsw-alias-button-info-fill);border-color:transparent;color:#fff}',
      '.dsh-gs button:disabled{opacity:.5;cursor:default}',
      '.dsh-gs-kv{display:flex;gap:8px;padding:3px 0;font-size:12px}',
      '.dsh-gs-kv b{flex:0 0 84px;font-weight:400;color:var(--dsw-alias-label-secondary)}',
      '.dsh-gs-kv span{min-width:0;word-break:break-all}',
      '.dsh-gs-tag{display:inline-block;border-radius:999px;padding:1px 8px;font-size:11px}',
      '.dsh-gs-tag.ok{color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 14%,transparent)}',
      '.dsh-gs-tag.bad{color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 14%,transparent)}',
      '.dsh-gs-tag.off{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2)}',
      '.dsh-gs-pre{white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:10px;max-height:260px;overflow:auto;margin:8px 0 0}',
      '.dsh-gs-error{color:var(--dsw-alias-state-error-primary);font-size:12px}',
      '.dsh-gs-warn{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:10px 12px;margin-top:10px;background:var(--dsw-alias-bg-layer-2);font-size:12px}',
      '.dsh-gs-list{margin:6px 0 0;padding-left:18px;font-size:12px;max-height:180px;overflow:auto}',
      '.dsh-gs-muted{color:var(--dsw-alias-label-secondary);font-size:12px}',
      '.dsh-gs-switch{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer}',
      '.dsh-gs-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}'
    ].join('\n')

    var DICT = {
      zh: {
        tab: 'GitHub 同步',
        title: 'GitHub 同步',
        sub: '把当前 profile 的配置、插件、模式与 skill 同步到一个 GitHub 仓库。认证使用本机 git 凭据（SSH key 或 credential helper），插件不保存令牌。',
        connection: '连接',
        repo: '仓库地址',
        repoPlaceholder: 'git@github.com:you/dsh-config.git 或 https://github.com/you/dsh-config.git',
        branch: '分支',
        autoPull: '启动后自动拉取',
        save: '保存',
        test: '测试连接',
        saving: '保存中…',
        testing: '正在检查仓库…',
        status: '状态',
        configured: '仓库',
        notConfigured: '未配置',
        git: 'git',
        clone: '本地克隆',
        drift: '本地未同步',
        lastSync: '上次同步',
        lastCheck: '上次检查',
        presets: '模式',
        skills: 'skill 目录',
        actions: '操作',
        check: '检查',
        checking: '正在检查远端…',
        pull: '拉取',
        pulling: '正在拉取…',
        push: '推送',
        pushing: '正在推送…',
        never: '从未',
        notCloned: '尚未克隆',
        resultOk: '完成',
        resultFailed: '失败',
        added: '新增',
        modified: '更新',
        deleted: '删除',
        backup: '备份目录',
        confirmPull: '将覆盖本地有差异的文件（覆盖前会备份），并可能安装缺失插件。确认拉取？',
        confirmYes: '确认拉取',
        cancel: '取消',
        failed: '操作失败',
        loading: '加载中…',
        emptyHint: '还没有配置仓库。推荐新建一个私有仓库（可以是空仓库），填入地址后先“测试连接”，再“推送”初始化。',
        foot: '不会同步：.env、.credentials.yaml、sessions、node_modules、pnpm-lock.yaml、私钥文件。',
        ahead: '领先',
        behind: '落后',
        remoteEmpty: '远端还没有提交',
        none: '无',
        paths: '本机路径',
        errCode: '错误码'
      },
      en: {
        tab: 'GitHub Sync',
        title: 'GitHub Sync',
        sub: 'Synchronize this profile\'s configuration, plugins, agent presets and skills with a GitHub repository. Authentication uses your local git credentials (SSH key or credential helper); no token is stored.',
        connection: 'Connection',
        repo: 'Repository',
        repoPlaceholder: 'git@github.com:you/dsh-config.git or https://github.com/you/dsh-config.git',
        branch: 'Branch',
        autoPull: 'Pull once after startup',
        save: 'Save',
        test: 'Test connection',
        saving: 'Saving…',
        testing: 'Checking repository…',
        status: 'Status',
        configured: 'Repository',
        notConfigured: 'Not configured',
        git: 'git',
        clone: 'Local clone',
        drift: 'Local changes',
        lastSync: 'Last sync',
        lastCheck: 'Last check',
        presets: 'Presets',
        skills: 'Skill roots',
        actions: 'Actions',
        check: 'Check',
        checking: 'Checking remote…',
        pull: 'Pull',
        pulling: 'Pulling…',
        push: 'Push',
        pushing: 'Pushing…',
        never: 'never',
        notCloned: 'not cloned yet',
        resultOk: 'Done',
        resultFailed: 'Failed',
        added: 'added',
        modified: 'modified',
        deleted: 'deleted',
        backup: 'Backups',
        confirmPull: 'Local files that differ will be overwritten (backed up first) and missing plugins may be installed. Pull now?',
        confirmYes: 'Pull now',
        cancel: 'Cancel',
        failed: 'Operation failed',
        loading: 'Loading…',
        emptyHint: 'No repository configured. Create a private repository (it may be empty), paste its address, test the connection, then push to initialize it.',
        foot: 'Never synchronized: .env, .credentials.yaml, sessions, node_modules, pnpm-lock.yaml, private keys.',
        ahead: 'ahead',
        behind: 'behind',
        remoteEmpty: 'remote has no commits yet',
        none: 'none',
        paths: 'Local paths',
        errCode: 'Error code'
      }
    }

    function chooseLanguage(ctx) {
      var candidates = []
      try {
        var snapshot = ctx.locale && ctx.locale.getSnapshot ? ctx.locale.getSnapshot() : null
        if (!snapshot && ctx.locale && ctx.locale.getLocale) snapshot = ctx.locale.getLocale()
        if (snapshot) {
          candidates.push(snapshot.id, snapshot.locale, snapshot.language, snapshot.lang)
        }
      } catch (error) {
        // Fall through to the document language.
      }
      try {
        if (typeof document !== 'undefined' && document.documentElement) {
          candidates.push(document.documentElement.lang)
        }
      } catch (error) {
        // No document: default to Chinese.
      }
      var joined = candidates.filter(Boolean).join(' ').toLowerCase()
      return /(^|\s|_)en\b/.test(joined) && joined.indexOf('zh') === -1 ? 'en' : 'zh'
    }

    function ensureStyles() {
      try {
        if (typeof document === 'undefined' || !document.head) return
        if (document.querySelector('style[data-dsh-github-sync]') !== null) return
        var tag = document.createElement('style')
        tag.setAttribute('data-dsh-github-sync', '1')
        tag.textContent = CSS
        document.head.appendChild(tag)
      } catch (error) {
        // Styling is best effort; the tab still works unstyled.
      }
    }

    function request(name, body) {
      var options = { credentials: 'same-origin', headers: {} }
      if (body === undefined) {
        options.method = 'GET'
      } else {
        options.method = 'POST'
        options.headers['Content-Type'] = 'application/json'
        options.body = JSON.stringify(body)
      }
      return fetch(API + name, options).then(function (response) {
        return response.json().then(
          function (value) {
            return value
          },
          function () {
            throw new Error('HTTP ' + response.status)
          }
        )
      })
    }

    function shortSha(sha) {
      return typeof sha === 'string' && sha.length > 12 ? sha.slice(0, 12) : sha || ''
    }

    function formatTime(value) {
      if (!value) return ''
      var date = new Date(value)
      if (isNaN(date.getTime())) return String(value)
      return date.toLocaleString()
    }

    function kv(t, label, value, key) {
      return h('div', { className: 'dsh-gs-kv', key: key || label }, h('b', null, label), h('span', null, value))
    }

    function Tag(props) {
      return h('span', { className: 'dsh-gs-tag ' + (props.tone || 'off') }, props.children)
    }

    function ListBlock(props) {
      var items = props.items
      if (!items || items.length === 0) return null
      return h(
        'div',
        { style: { marginTop: '8px' } },
        h('div', { className: 'dsh-gs-muted' }, props.label + ' (' + items.length + ')'),
        h(
          'ul',
          { className: 'dsh-gs-list' },
          items.slice(0, 200).map(function (item, index) {
            return h('li', { key: props.label + index }, item)
          })
        )
      )
    }

    function ResultCard(props) {
      var t = props.t
      var result = props.result
      if (!result) return null
      var summary = Array.isArray(result.summary) ? result.summary : []
      var data = result.data || {}
      var applied = data.applied
      var blocks = []
      if (applied) {
        blocks.push(h(ListBlock, { key: 'a', label: t('added'), items: applied.added }))
        blocks.push(h(ListBlock, { key: 'm', label: t('modified'), items: applied.modified }))
        blocks.push(h(ListBlock, { key: 'd', label: t('deleted'), items: applied.deleted }))
        if (applied.backupDir) blocks.push(kv(t, t('backup'), applied.backupDir, 'backup'))
      }
      return h(
        'div',
        { className: 'dsh-gs-card' },
        h('h3', null, result.ok ? t('resultOk') : t('resultFailed')),
        summary.map(function (line, index) {
          return h('div', { key: 'sum' + index, className: result.ok ? 'dsh-gs-muted' : 'dsh-gs-error' }, line)
        }),
        blocks,
        result.error && result.error.detail
          ? h('pre', { className: 'dsh-gs-pre' }, String(result.error.detail))
          : null
      )
    }

    function Panel(props) {
      var t = props.t
      var statusState = React.useState(null)
      var status = statusState[0]
      var setStatus = statusState[1]
      var errorState = React.useState(null)
      var error = errorState[0]
      var setError = errorState[1]
      var busyState = React.useState('')
      var busy = busyState[0]
      var setBusy = busyState[1]
      var resultState = React.useState(null)
      var result = resultState[0]
      var setResult = resultState[1]
      var repoState = React.useState('')
      var repo = repoState[0]
      var setRepo = repoState[1]
      var branchState = React.useState('main')
      var branch = branchState[0]
      var setBranch = branchState[1]
      var autoPullState = React.useState(false)
      var autoPull = autoPullState[0]
      var setAutoPull = autoPullState[1]
      var confirmState = React.useState(false)
      var confirmPull = confirmState[0]
      var setConfirmPull = confirmState[1]

      function applyStatus(data) {
        setStatus(data)
        setRepo(data.repo || '')
        setBranch(data.branch || 'main')
        setAutoPull(data.autoPull === true)
      }

      function refresh() {
        return request('status')
          .then(function (res) {
            if (res && res.ok) {
              applyStatus(res.data)
              setError(null)
            } else if (res && res.error) {
              setError(res.error.message)
            }
          })
          .catch(function (err) {
            setError(String(err && err.message ? err.message : err))
          })
      }

      React.useEffect(function () {
        refresh()
      }, [])

      function run(name, body, label) {
        setBusy(label)
        setError(null)
        setResult(null)
        setConfirmPull(false)
        request(name, body === undefined ? {} : body)
          .then(function (res) {
            setResult(res)
            if (!res.ok && res.error) setError(res.error.message)
          })
          .catch(function (err) {
            setError(String(err && err.message ? err.message : err))
          })
          .then(function () {
            setBusy('')
            refresh()
          })
      }

      function save() {
        setBusy(t('saving'))
        setError(null)
        setResult(null)
        request('config', { repo: repo.trim(), branch: branch.trim(), autoPull: autoPull })
          .then(function (res) {
            setResult(res)
            if (!res.ok && res.error) setError(res.error.message)
          })
          .catch(function (err) {
            setError(String(err && err.message ? err.message : err))
          })
          .then(function () {
            setBusy('')
            refresh()
          })
      }

      function startPull() {
        var drift = status && status.drift ? status.drift.count : 0
        var behind = status && status.lastCheck ? status.lastCheck.behind : 0
        if (!confirmPull && (drift > 0 || behind > 0)) {
          setConfirmPull(true)
          return
        }
        run('pull', {}, t('pulling'))
      }

      var disabled = busy !== ''
      var configured = Boolean(status && status.configured)
      var gitInfo = status ? status.git : null
      var clone = status ? status.clone : null
      var drift = status && status.drift ? status.drift : null
      var lastSync = status ? status.lastSync : null
      var lastCheck = status ? status.lastCheck : null
      var presets = status && status.presets ? status.presets : null

      var statusRows = []
      if (status) {
        statusRows.push(
          kv(
            t,
            t('git'),
            gitInfo && gitInfo.ok ? (gitInfo.version || 'git') + ' · ' + (gitInfo.path || '') : gitInfo && gitInfo.error ? gitInfo.error : '—',
            'git'
          )
        )
        statusRows.push(
          kv(t, t('clone'), clone && clone.exists ? (clone.branch || '') + ' · ' + shortSha(clone.head) : t('notCloned'), 'clone')
        )
        if (drift) {
          statusRows.push(
            kv(
              t,
              t('drift'),
              drift.count === 0
                ? t('none')
                : drift.count + ' (' + t('added') + ' ' + drift.added.length + ', ' + t('modified') + ' ' + drift.modified.length + ', ' + t('deleted') + ' ' + drift.deleted.length + ')',
              'drift'
            )
          )
        }
        statusRows.push(
          kv(
            t,
            t('lastCheck'),
            lastCheck
              ? formatTime(lastCheck.at) + ' · ' + t('ahead') + ' ' + (lastCheck.ahead || 0) + ' · ' + t('behind') + ' ' + (lastCheck.behind || 0)
              : t('never'),
            'check'
          )
        )
        statusRows.push(
          kv(
            t,
            t('lastSync'),
            lastSync ? (lastSync.direction || '') + ' · ' + formatTime(lastSync.at) + ' · ' + shortSha(lastSync.sha) : t('never'),
            'sync'
          )
        )
        if (presets && presets.available) {
          statusRows.push(
            kv(
              t,
              t('presets'),
              presets.items.length === 0 ? t('none') : presets.items.map(function (preset) { return preset.name || preset.id }).join('、'),
              'presets'
            )
          )
        }
        if (status.paths && status.paths.skills) {
          statusRows.push(
            kv(
              t,
              t('skills'),
              status.paths.skills.map(function (dir) { return dir.label + ' → ' + dir.path }).join(' · '),
              'skills'
            )
          )
        }
      }

      return h(
        'div',
        { className: 'dsh-gs' },
        h('h2', null, t('title')),
        h('p', { className: 'dsh-gs-sub' }, t('sub')),

        h(
          'div',
          { className: 'dsh-gs-card' },
          h('h3', null, t('connection')),
          h(
            'div',
            { className: 'dsh-gs-row' },
            h('span', { className: 'dsh-gs-label' }, t('repo')),
            h('input', {
              type: 'text',
              value: repo,
              placeholder: t('repoPlaceholder'),
              disabled: disabled,
              onChange: function (event) { setRepo(event.target.value) }
            })
          ),
          h(
            'div',
            { className: 'dsh-gs-row' },
            h('span', { className: 'dsh-gs-label' }, t('branch')),
            h('input', {
              type: 'text',
              value: branch,
              disabled: disabled,
              onChange: function (event) { setBranch(event.target.value) }
            }),
            h(
              'label',
              { className: 'dsh-gs-switch' },
              h('input', {
                type: 'checkbox',
                checked: autoPull,
                disabled: disabled,
                onChange: function (event) { setAutoPull(event.target.checked) }
              }),
              t('autoPull')
            )
          ),
          h(
            'div',
            { className: 'dsh-gs-actions' },
            h('button', { className: 'primary', disabled: disabled, onClick: save }, t('save')),
            h('button', { disabled: disabled || !configured, onClick: function () { run('test', {}, t('testing')) } }, t('test'))
          ),
          !configured ? h('div', { className: 'dsh-gs-warn' }, t('emptyHint')) : null
        ),

        h(
          'div',
          { className: 'dsh-gs-card' },
          h('h3', null, t('status')),
          status
            ? statusRows
            : h('div', { className: 'dsh-gs-muted' }, t('loading')),
          status && status.lastError
            ? h('div', { className: 'dsh-gs-error', style: { marginTop: '8px' } },
                (status.lastError.code || t('errCode')) + ' · ' + formatTime(status.lastError.at) + ' · ' + status.lastError.message)
            : null
        ),

        h(
          'div',
          { className: 'dsh-gs-card' },
          h('h3', null, t('actions')),
          h(
            'div',
            { className: 'dsh-gs-actions' },
            h('button', { disabled: disabled || !configured, onClick: function () { run('check', {}, t('checking')) } }, t('check')),
            h('button', { disabled: disabled || !configured, onClick: startPull }, t('pull')),
            h('button', { className: 'primary', disabled: disabled || !configured, onClick: function () { run('push', {}, t('pushing')) } }, t('push')),
            busy ? h('span', { className: 'dsh-gs-muted' }, busy) : null
          ),
          confirmPull
            ? h(
                'div',
                { className: 'dsh-gs-warn' },
                h('div', null, t('confirmPull')),
                h(
                  'div',
                  { className: 'dsh-gs-actions' },
                  h('button', { className: 'primary', disabled: disabled, onClick: function () { run('pull', {}, t('pulling')) } }, t('confirmYes')),
                  h('button', { disabled: disabled, onClick: function () { setConfirmPull(false) } }, t('cancel'))
                )
              )
            : null,
          error ? h('div', { className: 'dsh-gs-error', style: { marginTop: '8px' } }, error) : null
        ),

        h(ResultCard, { t: t, result: result }),

        h('p', { className: 'dsh-gs-sub', style: { marginTop: '12px' } }, t('foot'))
      )
    }

    function apply(ctx) {
      ensureStyles()
      var language = chooseLanguage(ctx)
      var dict = DICT[language] || DICT.zh
      function translate(key) {
        if (dict[key]) return dict[key]
        if (DICT.zh[key]) return DICT.zh[key]
        return key
      }
      ctx.slots.inject('plugins.tab', function () {
        return ctx.slots.register(
          {
            name: 'plugins.tab',
            id: 'github-sync',
            order: 10,
            label: function () { return translate('tab') }
          },
          function Tab() {
            return h(Panel, { t: translate })
          }
        )
      })
    }

    return {
      name: 'dsh-github-sync',
      inject: ['slots'],
      apply: apply
    }
  }
})
