# Security

- **Protocol risk:** this plugin speaks the iLink personal-WeChat protocol, which is
  reverse-engineered, not a Tencent-official bot API. Bind a spare account; account
  restrictions or bans are possible.
- **Credentials:** the bot token is stored under `~/.dsh/weixin-own/accounts/` with
  `0600` permissions. It is sent only to the iLink origin that issued it.
- **Media:** inbound CDN URLs are checked against an explicit WeChat CDN host
  allowlist before a socket opens (SSRF protection). No `readLinks`.
- **Every inbound path** — agent turns, approval replies, `/cancel` and local commands — passes the allowlist/group gate before it runs.
- **Allowlist:** empty `allowedSenders` denies everyone unless `allowFirstContact: true` is set for first-run setup. Keep it false on a public bot.
- **Scope:** the plugin runs host code and can drive a DSH agent with the profile's
  permission preset. Review `permissionPreset` before using a trusted chat.
- **No telemetry.**
