# [plugin-add] dsh-weixin-ilink

**插件地址 / Plugin link**

```text
dsh-weixin-ilink@0.7.5
https://www.npmjs.com/package/dsh-weixin-ilink
```

公开源码仓库：`https://github.com/asd45183/dsh-weixin-ilink`

**简短说明 / Summary**

Weixin iLink channel for DeepSeek Harness: text/image/file chat, QR login,
persona modes (`/mode`), companion pacing, `/status` `/clear` `/proactive`,
and launchd-friendly proactive messages.

个人微信 iLink 接入：扫码登录、文字/图片/文件、人格模式、拟人节奏、
`/status` `/clear` `/proactive`，支持主动消息。

**补充信息 / Additional details**

- License: MIT
- `engines.dsh`: `>=0.2.1-alpha.4 <0.3.0`
- Declares `dsh.bundle.patch`; `cordis.patch.yml` ships in the npm package.
- No secrets in the package; tokens are written at runtime to
  `~/.dsh/weixin-own` with `0600`.
- **Risk:** iLink is a reverse-engineered personal-WeChat protocol, not an
  official Tencent bot API. Users should bind a spare account.
