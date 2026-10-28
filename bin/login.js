#!/usr/bin/env node
/**
 * Terminal QR login for dsh-weixin-ilink.
 *
 * Fetches a login QR from iLink, prints it (ASCII via the optional
 * qrcode-terminal dep, else just the liteapp URL), polls until the phone
 * confirms, and saves the bound account to ~/.dsh/weixin-own/accounts/<id>.json
 * (0600).
 *
 * Usage: node bin/login.js [bot_type]   (bot_type defaults to "3")
 */
import { fetchQrCode, pollQrStatus, ILINK_BASE_URL } from '../src/transport/ilink.js'
import { saveAccount, registerAccountId } from '../src/state.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Only accept iLink/WeChat HTTPS origins; never save or send a token elsewhere. */
function safeIlinkBase(value) {
  const raw = String(value ?? '').trim()
  if (raw === '') return ILINK_BASE_URL
  let url
  try {
    url = new URL(raw.includes('://') ? raw : `https://${raw}`)
  } catch {
    throw new Error(`refusing invalid iLink base URL: ${raw.slice(0, 80)}`)
  }
  if (url.protocol !== 'https:') throw new Error(`refusing non-HTTPS iLink base: ${url.protocol}`)
  const host = url.hostname.toLowerCase()
  if (host !== 'weixin.qq.com' && host !== 'ilinkai.weixin.qq.com' && !host.endsWith('.weixin.qq.com')) {
    throw new Error(`refusing unexpected iLink host: ${host}`)
  }
  return url.origin
}

async function main() {
  const botType = process.argv[2] ?? '3'
  let { qrcode, qrcode_img_content: link } = await fetchQrCode({ botType })
  qrcode = String(qrcode ?? '')
  link = String(link ?? '')
  if (!qrcode || !link) {
    console.error('QR response missing fields')
    process.exit(1)
  }
  console.log('\n请用微信扫描以下二维码(或在手机浏览器打开链接):\n')
  console.log(link)
  try {
    const { default: qrcodeTerminal } = await import('qrcode-terminal')
    qrcodeTerminal.generate(link, { small: true }, (s) => console.log(s))
  } catch {
    console.log('(未装 qrcode-terminal;直接打开上面链接扫码同样有效)')
  }

  const deadline = Date.now() + 480_000
  let baseUrl = ILINK_BASE_URL
  let refreshCount = 0
  while (Date.now() < deadline) {
    const status = await pollQrStatus({ baseUrl, qrcode })
    const s = String(status.status ?? 'wait')
    if (s === 'wait') {
      process.stdout.write('.')
      await sleep(1000)
      continue
    }
    if (s === 'scaned') {
      console.log('\n已扫码,请在微信里确认...')
      await sleep(1000)
      continue
    }
    if (s === 'scaned_but_redirect' && status.redirect_host) {
      baseUrl = safeIlinkBase(status.redirect_host)
      await sleep(1000)
      continue
    }
    if (s === 'expired') {
      refreshCount += 1
      if (refreshCount > 3) {
        console.error('\n二维码多次过期,请重新执行登录')
        process.exit(1)
      }
      console.log(`\n二维码已过期,刷新 (${refreshCount}/3)...`)
      const fresh = await fetchQrCode({ botType })
      qrcode = String(fresh.qrcode ?? '')
      link = String(fresh.qrcode_img_content ?? '')
      console.log(link)
      await sleep(1000)
      continue
    }
    if (s === 'confirmed') {
      const accountId = String(status.ilink_bot_id ?? '')
      const token = String(status.bot_token ?? '')
      if (!accountId || !token) {
        console.error('登录确认但凭证不完整')
        process.exit(1)
      }
      const base = safeIlinkBase(status.baseurl)
      const userId = String(status.ilink_user_id ?? '')
      saveAccount(accountId, { token, baseUrl: base, userId })
      registerAccountId(accountId)
      console.log(`\n微信连接成功,account_id=${accountId}`)
      console.log(`凭证写入 ~/.dsh/weixin-own/accounts/${accountId}.json (0600)`)
      process.exit(0)
    }
    if (s === 'binded_redirect') {
      console.error('\n服务器仍认为该机器人绑定在本机。请先在手机微信里解除该机器人的绑定,然后重新扫码。')
      process.exit(1)
    }
    await sleep(1000)
  }
  console.error('\n登录超时')
  process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
