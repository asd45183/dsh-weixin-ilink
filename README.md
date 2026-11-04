# dsh-weixin-ilink

把个人微信接到 DeepSeek Harness 的通道插件：一条微信消息就能驱动 DSH 里的 agent，支持文字、图片、文件、语音、群聊、人格模式和主动消息。

> **风险提示**：iLink 是逆向的个人微信协议，不是腾讯官方机器人接口。建议绑定**小号**，账号被限制/封禁的风险自行承担。

## 功能

- 长轮询已绑定的微信账号，每个会话对应一个 DSH agent 会话；回复按长度分段并回传 `context_token`
- 默认拒绝：白名单机制，首次接触需显式开启；群聊默认关闭，开启后只回复被 @ 的消息
- 挂载 profile 的默认 agent 预设和完整工具集；需要审批的操作转发到微信，回复 `y`/`n`
- 收发图片、文件、语音、视频：入站 CDN 下载 + AES-128-ECB 解密，出站 `MEDIA:` 上传
- 斜杠命令本地应答；会话线（line）管理、自动归档、显式删除
- 人格模式、生活状态、拟人节奏（分段、延迟）、可选主动消息
- 可配置工作目录：agent 的 `cwd`，也是 `workspace-write` 的写入边界，并注册为 Web 侧边栏项目
- 通过 `weixinPush` 服务供同一 DSH 内的其他插件推送提醒（例如抖音登录二维码）

## 环境要求

| 项 | 要求 |
| --- | --- |
| Node.js | ≥ 22.13 |
| DSH | `>=0.2.1-alpha.4 <0.3.0`（以 `package.json` 的 `engines.dsh` 为准） |
| 系统 | macOS / Linux；Windows 未验证 |
| 账号 | 建议使用个人微信小号，主号有被封风险 |

## 安装

### 从 npm 安装（推荐）

```sh
dsh plugin --profile web add dsh-weixin-ilink@0.9.3
```

安装后**完全退出并重新打开 DSH**。包自带 `cordis.patch.yml`，会自动插入 `id: dsh-weixin-own` 的插件行。

### 从源码安装

```sh
git clone https://github.com/asd45183/dsh-weixin-ilink.git
cd dsh-weixin-ilink
npm install
dsh plugin --profile web add .
```

## 设置页（推荐）

安装并重启 DSH 后，打开“设置 → 微信”，可以直接完成：

- **扫码登录**：点“扫码登录”显示二维码，手机微信扫码并在手机上确认；可刷新二维码或取消
- **账号**：列出已绑定账号的掩码 id、凭据是否有效、最近消息时间；可逐个“退出登录”
- **授权**：编辑 `allowedSenders`（允许驱动 agent 的微信 id）、开启首次接触、群聊开关与触发方式、允许的群聊；可从“最近发送者”一键加入白名单
- **运行**：媒体收发、图片发送方式、正在输入提示、主动消息、工作目录、权限预设

生效范围：白名单与各类开关保存后立即用于新消息；工作目录、权限预设、账号轮询范围和“启用通道”需要重启 DSH 生效。

设置页只在 DSH 宿主内可用，接口只接受本机同源请求和宿主所有者，不返回 token、消息正文或联系人昵称。

## 绑定微信账号

```sh
node bin/login.js
```

也可以用“设置 → 微信 → 扫码登录”在页面里扫码。凭据保存在 `~/.dsh/weixin-own/accounts/<id>.json`（权限 `0600`），不要提交到仓库或发给别人。

- 只绑一个账号时，配置里 `accountId` 留空即可
- 绑定多个账号时，用 `accountId` 指定要服务的那一个

## 配置

在 profile 的 `cordis.patch.yml`（或插件配置层）中追加：

```yaml
- id: dsh-weixin-own
  name: "dsh-weixin-ilink"
  config:
    enabled: true
    accountId: ""                 # 空 = 使用唯一已保存账号
    allowedSenders:               # 默认拒绝；填入允许驱动 agent 的微信 id
      - wxid_xxxxxxxx
    allowFirstContact: false      # 仅首次配置时临时开启
    workspace: "~/weixin-workspace"
    permissionPreset: workspace-write
    mediaEnabled: true
    imageAsFile: false            # false = 图片气泡；true = 文件附件
    groupChatEnabled: false
    groupReplyWhen: mention       # 群聊只在被 @ 时回复
```

### 常用配置项

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 插件加载后是否启动轮询 |
| `accountId` | `""` | 只服务指定账号；空 = 所有已保存账号 |
| `allowedSenders` | `[]` | 允许驱动 agent 的微信 id；为空时默认拒绝 |
| `allowFirstContact` | `false` | 首次配置用：临时允许第一个发送者，用于复制 id |
| `workspace` | `""` | agent 的 `cwd` 与写入边界；空 = `~/.dsh/weixin-own/sessions` |
| `permissionPreset` | `workspace-write` | 改成 `danger-full-access` 会让微信消息可写整盘，仅限完全可信账号 |
| `turnTimeoutMs` | `600000` | 单轮超时（10 分钟）后取消 |
| `approvalTimeoutMs` | `300000` | 审批提示等待时间，超时按拒绝处理 |
| `mediaEnabled` | `true` | 入站媒体下载解密、出站媒体上传 |
| `imageAsFile` | `true` | 发送图片的方式；`false` 显示为图片气泡 |
| `groupChatEnabled` | `false` | 是否服务群聊 |
| `groupReplyWhen` | `mention` | 群聊触发方式：`mention` 仅 @，`all` 全部 |
| `typingIndicator` | `true` | 处理中显示“正在输入” |
| `proactiveEnabled` | `false` | 人格模式是否允许 agent 先开口 |

完整配置项见仓库 `src/index.js` 的 Config schema 或 `cordis.patch.yml` 注释。

## 首次使用（白名单）

1. 保持 `allowedSenders: []`，先把 `allowFirstContact` 设为 `true`
2. 重启 DSH，用微信给绑定的账号发一条消息
3. 查看 DSH 日志里的 warn 行，复制完整的 sender id
4. 把该 id 填入 `allowedSenders`，并把 `allowFirstContact` 改回 `false`
5. 重启 DSH

之后只有白名单内的发送者能驱动 agent，其他人发消息不会得到回复。

## 常用聊天命令

| 发送 | 效果 |
| --- | --- |
| `/help` | 列出所有命令 |
| `/status` | 账号、模型、模式、会话 id、工作目录、白名单数量 |
| `/model` | 列出模型；`/model 2` 或 `/model provider/model` 切换 |
| `/mode` | 列人格模式；`/mode 女友` 切换并新开会话线 |
| `/new` | 新开一条会话线 |
| `/list` / `/use <n>` / `/delete <n> confirm` | 会话线管理 |
| `/compact` / `/clear` | 压缩或清空当前上下文 |
| `/cancel` | 中断当前轮次 |
| `/trust [10m\|off]` | 临时跳过审批提示（仅在内存中，最长 8 小时） |
| `/proactive on\|off` | 开关主动消息 |
| `y` / `n` | 批准或拒绝待处理的审批 |

## 数据目录

```
~/.dsh/weixin-own/
  accounts/<id>.json              账号凭据，0600
  accounts/accounts.json          已绑定账号索引
  accounts/<id>.sync.json         长轮询游标
  accounts/<id>.context-tokens.json
  sessions/                       微信会话的默认工作目录
  media/<conv>/<msg>/             入站附件解密结果
  session-lines.json              每个会话的当前会话线
  persona-modes.json              每个会话的人格模式
  proactive.json                  /proactive 的运行时覆盖
```

其他目录可用 `DSH_WEIXIN_OWN_STATE_DIR` 覆盖。

## 与其他 DSH 插件联动

插件向同一 DSH 提供 `weixinPush` 服务，只发给 `allowedSenders` 的第一个会话：

```js
const push = ctx.get('weixinPush')
await push.toOwner({ text: '需要处理', imagePath: '/path/to/qr.png' })
```

抖音插件用它推送登录二维码/身份验证截图；如未配置白名单或媒体发送被关闭，会返回明确的 `ok: false`。

## 常见问题

**微信发了消息没回复**
- 检查 `enabled` 是否为 true、DSH 是否在运行
- 检查发送者是否在 `allowedSenders` 内；首次配置用 `allowFirstContact`
- 检查账号凭据是否过期（重新执行 `node bin/login.js`）

**群聊不回复**
- 需要 `groupChatEnabled: true`，并确保群在 `allowedGroups`（为空表示任意群）
- 消息需要以 `@机器人` 开头（`groupReplyWhen: mention`）

**图片在微信里显示“已过期或已清理”**
- 把 `imageAsFile` 设为 `false`，改用图片气泡发送

**权限提示太多**
- 确认 `permissionPreset` 是 `workspace-write`，并让工作目录覆盖常用路径
- 临时可用 `/trust 10m` 跳过提示，但不要长期开启

**重启后没有恢复**
- DSH 需要保持运行；退出 DSH 后通道不会继续轮询
- 检查 `~/.dsh/weixin-own/accounts/` 下的凭据是否还在

## 安全

- 这是逆向协议，平台可能调整；账号存在被限制的风险，建议只用小号
- 凭据文件权限为 `0600`，不要复制到其他机器或提交到仓库
- `danger-full-access` 会让微信消息拥有整盘写入权限，只对完全可信的账号和会话开启
- `workspace` 内的写入不需要审批，工作区外会转发审批提示

## 许可

MIT。第三方组件与来源见 [NOTICE](NOTICE) 与 [LICENSE](LICENSE)。
