# Publishing checklist — dsh-weixin-ilink

## 1. Public source repository

Push this package to a public GitHub repository, e.g.
`https://github.com/<owner>/dsh-weixin-ilink`.

Then add to `package.json`:

```json
"repository": {
  "type": "git",
  "url": "git+https://github.com/<owner>/dsh-weixin-ilink.git"
},
"homepage": "https://github.com/<owner>/dsh-weixin-ilink#readme"
```

## 2. Publish to npm

```sh
npm login
npm publish --access public
```

Verify:

```sh
npm view dsh-weixin-ilink version
npm view dsh-weixin-ilink engines
```

## 3. Validate the tarball

```sh
npm pack --dry-run
```

Expected: no `.env`, tokens, accounts, or `~/.dsh` state; the tarball includes
`src/`, `bin/`, `cordis.patch.yml`, `README.md`, `LICENSE`, and `NOTICE`.

## 4. Request listing

Open the plugin-add form:

<https://github.com/polang233/dsh-plugin-index/issues/new?template=plugin-add.yml>

Use `market/plugin-add-issue.md`. The maintainer checks the npm release,
license, bundle patch, and entry files, then adds it to:

<https://polang233.github.io/dsh-plugin-index/index.json>

The index tracks npm `latest` by default. For a Git source instead, provide the
public repo, version, full 40-character commit SHA, and subdirectory.

## 5. Local switch (optional)

The package is renamed but the profile row id and state directory stay stable.
To switch the running profile after publishing:

```sh
cd ~/.dsh/profiles/web
# package.json dependency: "dsh-weixin-ilink": "file:/.../dsh-weixin-own"
# dsh.profile.bundles: replace "dsh-weixin-own" with "dsh-weixin-ilink"
# cordis.patch.yml: row name "dsh-weixin-ilink"; keep id: dsh-weixin-own
rm -rf node_modules/dsh-weixin-own
pnpm install
launchctl kickstart -k gui/$(id -u)/ai.deepseek.harness.web
```

Existing accounts/sessions stay in `~/.dsh/weixin-own`.
