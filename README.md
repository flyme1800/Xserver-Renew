### Xserver 自动续期脚本

#### 运行方式
1. 创建项目，选择 Private 私密项目
2. 上传 app.js 和 package.json
3. 点击 Actions 菜单，选择 set up a workflow yourself，创建一个 yml 文件（文件名随意）
4. 将 `.github/workflows/renew-xserver.yml` 的内容粘贴进编辑框并保存
5. 在 Settings -> Secrets and variables -> Actions 中添加所需 secrets

#### 登录优先级
- 方案 1：优先使用 `COOKIE_VALUE`
- 方案 2：Cookie 失效时自动回退到 `ACCOUNTS`

这样可以尽量绕过 Cloudflare Turnstile，只有在 Cookie 失效时才会回落到账密登录。

### 相关环境变量

| Secret 名称 | 是否必填 | 说明 |
|---------------------|----------|---------------------------------------------------|
| COOKIE_VALUE | ❌ 可选 | Xserver 登录 Cookie，优先级最高；可直接填 `sessionid=...; ...` 或完整 Cookie 字符串 |
| ACCOUNTS | ❌ 可选 | 备用登录邮箱和密码，格式：`[{"username":"...","password":"..."}]` |
| NODE_LINK | ❌ 可选 | 代理链接，例如 vless:// / hysteria2:// / socks5:// / vmess:// |
| IS_PROXY | ❌ 可选 | 是否启用浏览器代理，通常填 `true` |
| PROXY_SERVER | ❌ 可选 | 代理地址，默认 `socks5://127.0.0.1:1080` |
| TG_BOT_TOKEN | ❌ 可选 | Telegram Bot Token（用于发送通知） |
| TG_CHAT_ID | ❌ 可选 | Telegram Chat ID（接收通知的用户或群组 ID） |

#### COOKIE_VALUE 示例
```text
session_id=xxxxxx; _session=xxxxxx; other_cookie=xxxx
```

或者直接复制浏览器开发者工具中请求头中的 Cookie。

#### ACCOUNTS 格式示例
```json
[
    {
        "username": "your-xserver-email@gmail.com",
        "password": "your-xerver-password"
    }
]
```

#### 建议配置
- 如果你已经拿到了有效登录 Cookie，建议优先设置 `COOKIE_VALUE`
- 如果 Cookie 失效，再设置 `ACCOUNTS` 作为兜底
- 如果是 GitHub Actions 环境，建议同时保留 `IS_PROXY` 与 `PROXY_SERVER`
