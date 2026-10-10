const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { ProxyAgent } = require('undici');

const LOGIN_URL = 'https://secure.xserver.ne.jp/xapanel/login/xmgame';

const TG_CHAT_ID = process.env.TG_CHAT_ID || '';
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || '';

const IS_PROXY =
  String(process.env.IS_PROXY || 'false').toLowerCase() === 'true';

const PROXY_SERVER = process.env.PROXY_SERVER || '';
const COOKIE_VALUE = process.env.COOKIE_VALUE || '';

const ACCOUNT_VALUE =
  process.env.ACCOUNTS || process.env.ACCOUNT || '';

const BROWSER_PATH = process.env.BROWSER_PATH || '';

const PAGE_TIMEOUT = 60000;
const TURNSTILE_WAIT_MS = 20000;

const SCREENSHOT_DIR = path.join(__dirname, 'screenshots');

fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function safeFilename(value) {
  return String(value || 'unknown')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 100);
}

function maskValue(value) {
  if (!value) return '';

  if (value.length <= 8) {
    return '********';
  }

  return `${value.slice(0, 4)}********${value.slice(-4)}`;
}

// ==============================
// Telegram 通知
// ==============================

async function sendTelegramMessage(message, screenshotPath = null) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
    console.log(
      'ℹ️ 未配置 TG_BOT_TOKEN/TG_CHAT_ID，跳过 Telegram 通知'
    );
    return;
  }

  try {
    const base = `https://api.telegram.org/bot${TG_BOT_TOKEN}`;

    let response;

    if (screenshotPath && fs.existsSync(screenshotPath)) {
      const form = new FormData();

      form.append('chat_id', TG_CHAT_ID);
      form.append('caption', message.slice(0, 1000));

      form.append(
        'photo',
        new Blob(
          [fs.readFileSync(screenshotPath)],
          { type: 'image/png' }
        ),
        path.basename(screenshotPath)
      );

      response = await fetch(`${base}/sendPhoto`, {
        method: 'POST',
        body: form
      });
    } else {
      response = await fetch(`${base}/sendMessage`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          chat_id: TG_CHAT_ID,
          text: message
        })
      });
    }

    if (!response.ok) {
      console.error(
        'Telegram 请求失败:',
        response.status,
        (await response.text()).slice(0, 300)
      );
    }
  } catch (error) {
    console.error('Telegram 通知失败:', error.message);
  }
}

// ==============================
// Cookie 解析
// ==============================

function parseCookies(cookieValue) {
  if (!cookieValue || !cookieValue.trim()) {
    return [];
  }

  const value = cookieValue.trim();

  // 支持 JSON Cookie 数组
  if (value.startsWith('[')) {
    const cookies = JSON.parse(value);

    if (!Array.isArray(cookies)) {
      throw new Error('COOKIE_VALUE JSON 必须是数组');
    }

    return cookies
      .filter(c => c && c.name && c.value !== undefined)
      .map(c => ({
        name: String(c.name),
        value: String(c.value),
        domain: c.domain || '.xserver.ne.jp',
        path: c.path || '/',
        secure:
          c.secure !== undefined
            ? Boolean(c.secure)
            : true,
        httpOnly: Boolean(c.httpOnly),
        sameSite: c.sameSite || 'Lax'
      }));
  }

  // 支持 name=value; name2=value2 格式
  return value
    .split(';')
    .map(s => s.trim())
    .filter(Boolean)
    .map(item => {
      const i = item.indexOf('=');

      if (i <= 0) {
        return null;
      }

      return {
        name: item.slice(0, i).trim(),
        value: item.slice(i + 1).trim(),
        domain: '.xserver.ne.jp',
        path: '/',
        secure: true,
        httpOnly: false,
        sameSite: 'Lax'
      };
    })
    .filter(Boolean);
}

// ==============================
// 账号解析
// ==============================

function parseAccounts(value) {
  if (!value || !value.trim()) {
    return [];
  }

  const input = value.trim();

  // JSON 数组格式
  if (input.startsWith('[')) {
    const accounts = JSON.parse(input);

    if (!Array.isArray(accounts)) {
      throw new Error('ACCOUNTS 必须是 JSON 数组');
    }

    return accounts
      .filter(
        a =>
          a &&
          (a.username || a.email) &&
          a.password !== undefined
      )
      .map(a => ({
        username: String(a.username || a.email),
        password: String(a.password)
      }));
  }

  // 单账号格式：username|password
  // 兼容 username:password
  const separator = input.includes('|') ? '|' : ':';
  const i = input.indexOf(separator);

  if (i <= 0) {
    throw new Error(
      '账号格式应为 username|password 或 JSON 数组'
    );
  }

  return [
    {
      username: input.slice(0, i).trim(),
      password: input.slice(i + 1)
    }
  ];
}

// ==============================
// 截图
// ==============================

async function saveScreenshot(page, prefix, username) {
  const file = path.join(
    SCREENSHOT_DIR,
    `${prefix}_${safeFilename(username)}_${Date.now()}.png`
  );

  await page
    .screenshot({
      path: file,
      fullPage: true
    })
    .catch(() => {});

  return file;
}

// ==============================
// 检测出口 IP
// ==============================

async function getCurrentIP() {
  try {
    const options = {};

    if (IS_PROXY && PROXY_SERVER) {
      options.dispatcher = new ProxyAgent(PROXY_SERVER);
    }

    const response = await fetch(
      'https://api.ipify.org?format=json',
      options
    );

    if (!response.ok) {
      return 'unknown';
    }

    const data = await response.json();

    return data.ip || 'unknown';
  } catch {
    return 'unknown';
  }
}

// ==============================
// 启动浏览器
// ==============================

async function launchBrowser() {
  const options = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu'
    ]
  };

  if (BROWSER_PATH) {
    options.executablePath = BROWSER_PATH;
  }

  if (IS_PROXY && PROXY_SERVER) {
    options.proxy = {
      server: PROXY_SERVER
    };

    console.log(`🌐 浏览器代理已启用: ${PROXY_SERVER}`);
  } else {
    console.log('ℹ️ 浏览器直连模式');
  }

  return chromium.launch(options);
}

// ==============================
// 浏览器上下文
// ==============================

async function createContext(browser) {
  return browser.newContext({
    viewport: {
      width: 1365,
      height: 900
    },
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo'
  });
}

// ==============================
// 检测 Cloudflare Turnstile
// ==============================

async function getTurnstileInfo(page) {
  return page.evaluate(() => {
    const frames = [
      ...document.querySelectorAll('iframe')
    ].map(f => ({
      src: f.src || '',
      title: f.title || '',
      visible: Boolean(
        f.offsetWidth ||
        f.offsetHeight ||
        f.getClientRects().length
      )
    }));

    const turnstileFrames = frames.filter(f =>
      /challenges\.cloudflare\.com|turnstile/i.test(
        `${f.src} ${f.title}`
      )
    );

    const container = Boolean(
      document.querySelector(
        '.cf-turnstile, [data-sitekey]'
      )
    );

    const responseInputs = [
      ...document.querySelectorAll(
        'input[name="cf-turnstile-response"], ' +
        'textarea[name="cf-turnstile-response"]'
      )
    ];

    return {
      detected:
        turnstileFrames.length > 0 ||
        container ||
        responseInputs.length > 0,

      frames: turnstileFrames,
      container,

      responseInputExists:
        responseInputs.length > 0,

      responsePresent: responseInputs.some(
        el => Boolean(el.value && el.value.trim())
      )
    };
  }).catch(() => ({
    detected: false,
    frames: [],
    container: false,
    responseInputExists: false,
    responsePresent: false
  }));
}

async function waitForTurnstileToResolve(page, username) {
  const initial = await getTurnstileInfo(page);

  if (!initial.detected) {
    console.log('ℹ️ 未检测到 Turnstile iframe/容器');

    return {
      ok: true,
      detected: false
    };
  }

  console.log(
    '🛡️ 检测到 Cloudflare Turnstile。'
  );

  console.log(
    '脚本不会伪造 token 或绕过验证。'
  );

  console.log(
    '🔎 Turnstile 信息:',
    JSON.stringify(initial.frames)
  );

  // 等待网站正常完成验证，或组件自行消失
  const deadline = Date.now() + TURNSTILE_WAIT_MS;

  while (Date.now() < deadline) {
    await sleep(1000);

    const current = await getTurnstileInfo(page);

    if (!current.detected) {
      console.log(
        '✅ 验证组件已从页面消失，继续检查登录流程'
      );

      return {
        ok: true,
        detected: true
      };
    }
  }

  const screenshot = await saveScreenshot(
    page,
    'turnstile_required',
    username
  );

  await sendTelegramMessage(
    `⚠️ XServer 需要完成 Cloudflare 人机验证\n` +
    `账号: ${username}\n` +
    `当前为无头自动化环境，脚本未绕过验证。` +
    `请检查截图并通过网站正常流程完成人工验证。`,
    screenshot
  );

  return {
    ok: false,
    detected: true,
    screenshot
  };
}

// ==============================
// 检查是否登录成功
// ==============================

async function isLoggedIn(page) {
  await sleep(1500);

  const url = page.url();

  if (/\/login(?:\/|\?|$)|\/auth\/login/i.test(url)) {
    return false;
  }

  const body = await page
    .locator('body')
    .innerText()
    .catch(() => '');

  if (
    body.includes(
      'XServerアカウントID または メールアドレス'
    ) ||
    body.includes('パスワードを入力してください') ||
    body.includes('ログインしてください')
  ) {
    return false;
  }

  return /ゲーム管理|マイページ|アップグレード・期限延長|期限を延長する/.test(
    body
  );
}

// ==============================
// Cookie 登录
// ==============================

async function loginWithCookie(browser) {
  if (!COOKIE_VALUE) {
    console.log(
      'ℹ️ 未配置 COOKIE_VALUE，跳过 Cookie 登录'
    );

    return null;
  }

  let cookies;

  try {
    cookies = parseCookies(COOKIE_VALUE);
  } catch (error) {
    console.error(
      '❌ Cookie 解析失败:',
      error.message
    );

    return null;
  }

  if (!cookies.length) {
    return null;
  }

  const context = await createContext(browser);

  try {
    await context.addCookies(cookies);

    const page = await context.newPage();

    await page.goto(LOGIN_URL, {
      waitUntil: 'domcontentloaded',
      timeout: PAGE_TIMEOUT
    });

    if (!(await isLoggedIn(page))) {
      console.log(
        '⚠️ Cookie 登录未通过，改用账号密码登录'
      );

      const shot = await saveScreenshot(
        page,
        'cookie_login_failed',
        'cookie'
      );

      await sendTelegramMessage(
        '⚠️ XServer Cookie 登录失败或 Cookie 已失效',
        shot
      );

      await context.close();

      return null;
    }

    console.log('✅ Cookie 登录成功');

    return {
      context,
      page,
      method: 'COOKIE',
      username: 'cookie'
    };
  } catch (error) {
    console.error(
      '❌ Cookie 登录异常:',
      error.message
    );

    await context.close().catch(() => {});

    return null;
  }
}

// ==============================
// 账号密码登录
// ==============================

async function loginWithAccount(browser, account) {
  const context = await createContext(browser);

  try {
    const page = await context.newPage();

    page.setDefaultTimeout(20000);

    console.log(
      `👤 正在处理账户: ${account.username}`
    );

    await page.goto(LOGIN_URL, {
      waitUntil: 'domcontentloaded',
      timeout: PAGE_TIMEOUT
    });

    const usernameInput = page.getByRole('textbox', {
      name: 'XServerアカウントID または メールアドレス'
    });

    await usernameInput.waitFor({
      state: 'visible',
      timeout: 20000
    });

    await usernameInput.fill(account.username);

    await page
      .locator('#user_password')
      .fill(account.password);

    const turnstile = await waitForTurnstileToResolve(
      page,
      account.username
    );

    if (!turnstile.ok) {
      await context.close();

      return null;
    }

    const submit = page.locator(
      '#login-submit, ' +
      'input[type="submit"][value="ログインする"], ' +
      'button[type="submit"]'
    ).first();

    if (await submit.isVisible().catch(() => false)) {
      await submit.click();
    } else {
      console.log('⚠️ 未找到登录按钮');
    }

    await page
      .waitForLoadState('domcontentloaded', {
        timeout: 30000
      })
      .catch(() => {});

    await sleep(4000);

    if (!(await isLoggedIn(page))) {
      const shot = await saveScreenshot(
        page,
        'login_failed',
        account.username
      );

      await sendTelegramMessage(
        `❌ XServer 登录失败\n` +
        `账号: ${account.username}\n` +
        `URL: ${page.url()}`,
        shot
      );

      await context.close();

      return null;
    }

    console.log('✅ 账号登录成功');

    return {
      context,
      page,
      method: 'ACCOUNT',
      username: account.username
    };
  } catch (error) {
    console.error(
      `❌ 账号 ${account.username} 登录异常:`,
      error.message
    );

    const page = context.pages()[0];

    if (page) {
      const shot = await saveScreenshot(
        page,
        'login_error',
        account.username
      );

      await sendTelegramMessage(
        `❌ XServer 登录异常\n` +
        `账号: ${account.username}\n` +
        `错误: ${error.message}`,
        shot
      );
    }

    await context.close().catch(() => {});

    return null;
  }
}

// ==============================
// XServer GAMEs 续期流程
// ==============================

async function processGamePanel(page, username) {
  console.log('🎮 开始处理 XServer GAMEs 续期流程');

  await page
    .waitForLoadState('networkidle', {
      timeout: 30000
    })
    .catch(() => {});

  await sleep(2000);

  // 第一步：进入游戏管理
  const gameLink = page
    .getByRole('link', { name: 'ゲーム管理' })
    .first();

  if (await gameLink.isVisible().catch(() => false)) {
    await gameLink.click();

    await page
      .waitForLoadState('networkidle', {
        timeout: 30000
      })
      .catch(() => {});
  } else {
    const body = await page
      .locator('body')
      .innerText()
      .catch(() => '');

    if (!body.includes('ゲーム管理')) {
      throw new Error('未找到「ゲーム管理」入口');
    }
  }

  // 第二步：打开升级与期限延长页面
  try {
    await page
      .getByRole('link', {
        name: 'アップグレード・期限延長'
      })
      .click({
        timeout: 15000
      });
  } catch (error) {
    const body = await page
      .locator('body')
      .innerText()
      .catch(() => '');

    const match = body.match(
      /更新をご希望の場合は、(.+?)以降にお試しください。/
    );

    const shot = await saveScreenshot(
      page,
      'renew_unavailable',
      username
    );

    const message = match
      ? `⏳ XServer 暂时无法续期\n` +
        `账号: ${username}\n` +
        `下次可尝试时间：${match[1]}`
      : `⚠️ XServer 未找到「アップグレード・期限延長」入口\n` +
        `账号: ${username}`;

    await sendTelegramMessage(message, shot);

    return {
      renewed: false,
      reason: 'RENEWAL_UNAVAILABLE'
    };
  }

  // 第三步：进入期限延长页面
  try {
    const renewLink = page.getByRole('link', {
      name: '期限を延長する'
    });

    await renewLink.waitFor({
      state: 'visible',
      timeout: 15000
    });

    await renewLink.click();
  } catch (error) {
    const body = await page
      .locator('body')
      .innerText()
      .catch(() => '');

    const match = body.match(
      /更新をご希望の場合は、(.+?)以降にお試しください。/
    );

    const shot = await saveScreenshot(
      page,
      'renew_link_missing',
      username
    );

    await sendTelegramMessage(
      match
        ? `⏳ XServer 暂时无法续期\n` +
          `账号: ${username}\n` +
          `下次可尝试时间：${match[1]}`
        : `⚠️ XServer 未找到「期限を延長する」链接\n` +
          `账号: ${username}`,
      shot
    );

    return {
      renewed: false,
      reason: 'RENEWAL_LINK_UNAVAILABLE'
    };
  }

  // 第四步：进入确认页面
  await page
    .getByRole('button', {
      name: '確認画面に進む',
      exact: true
    })
    .click();

  // 第五步：最终确认
  const finalButton = page.getByRole('button', {
    name: '期限を延長する',
    exact: true
  });

  await finalButton.waitFor({
    state: 'visible',
    timeout: 120000
  });

  console.log(
    `🖱️ 正在提交 ${username} 的最终续期确认`
  );

  await finalButton.click();

  await page
    .waitForLoadState('domcontentloaded', {
      timeout: 30000
    })
    .catch(() => {});

  await sleep(2500);

  // 第六步：检查结果
  const bodyAfter = await page
    .locator('body')
    .innerText()
    .catch(() => '');

  const success =
    /延長しました|延長が完了|期限.*延長|完了しました|受付.*完了/.test(
      bodyAfter
    );

  const shot = await saveScreenshot(
    page,
    success ? 'renew_success' : 'renew_result',
    username
  );

  if (success) {
    await sendTelegramMessage(
      `✅ XServer 续期流程已完成\n账号: ${username}`,
      shot
    );

    return {
      renewed: true
    };
  }

  await sendTelegramMessage(
    `⚠️ XServer 已提交续期，但未能从页面文字确认成功\n` +
    `账号: ${username}\n` +
    `请检查截图及面板中的实际到期时间。`,
    shot
  );

  return {
    renewed: false,
    reason: 'SUCCESS_NOT_CONFIRMED'
  };
}

// ==============================
// 主程序
// ==============================

async function main() {
  console.log('========================================');
  console.log('XServer GAMEs 自动登录 / 续期');

  console.log(
    '上海时间:',
    new Date().toLocaleString('zh-CN', {
      timeZone: 'Asia/Shanghai',
      hour12: false
    })
  );

  console.log('========================================');

  let accounts = [];

  try {
    accounts = parseAccounts(ACCOUNT_VALUE);
  } catch (error) {
    console.error(
      '❌ 账号配置错误:',
      error.message
    );

    process.exitCode = 1;

    return;
  }

  if (!COOKIE_VALUE && !accounts.length) {
    console.error(
      '❌ 请配置 COOKIE_VALUE 或 ACCOUNT/ACCOUNTS'
    );

    process.exitCode = 1;

    return;
  }

  console.log(
    'Cookie 主登录:',
    COOKIE_VALUE
      ? `已配置 (${maskValue(COOKIE_VALUE)})`
      : '未配置'
  );

  console.log('备用账号数量:', accounts.length);

  const ip = await getCurrentIP();

  console.log('出口 IP:', ip);

  await sendTelegramMessage(
    `🚀 XServer 自动续期任务开始\n` +
    `出口 IP: ${ip}\n` +
    `备用账号数量: ${accounts.length}`
  );

  const browser = await launchBrowser();

  let session = null;

  try {
    // 优先 Cookie 登录
    session = await loginWithCookie(browser);

    // Cookie 失败时使用账号密码
    if (!session) {
      for (const account of accounts) {
        session = await loginWithAccount(
          browser,
          account
        );

        if (session) {
          break;
        }
      }
    }

    if (!session) {
      console.error('❌ 所有登录方式均失败');

      await sendTelegramMessage(
        '❌ XServer 自动续期失败：所有登录方式均失败'
      );

      process.exitCode = 1;

      return;
    }

    await sendTelegramMessage(
      `✅ XServer 登录成功\n` +
      `登录方式: ${session.method}\n` +
      `账号: ${session.username}`
    );

    const result = await processGamePanel(
      session.page,
      session.username
    );

    if (result.renewed) {
      console.log('✅ 续期流程完成');
    } else {
      console.log(
        '⚠️ 本次未确认续期成功:',
        result.reason
      );
    }
  } catch (error) {
    console.error(
      '❌ 自动续期流程异常:',
      error.stack || error.message
    );

    if (session?.page) {
      const shot = await saveScreenshot(
        session.page,
        'process_error',
        session.username || 'unknown'
      );

      await sendTelegramMessage(
        `❌ XServer 自动续期异常\n${error.message}`,
        shot
      );
    } else {
      await sendTelegramMessage(
        `❌ XServer 自动续期异常\n${error.message}`
      );
    }

    process.exitCode = 1;
  } finally {
    if (session?.context) {
      await session.context.close().catch(() => {});
    }

    await browser.close().catch(() => {});
  }

  console.log('任务结束');
}

main().catch(error => {
  console.error(
    '❌ 未捕获异常:',
    error
  );

  process.exitCode = 1;
});
