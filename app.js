'use strict';

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

// ============================================================
// 基础配置
// ============================================================

const LOGIN_URL =
    'https://secure.xserver.ne.jp/xapanel/login/xmgame';

const DEFAULT_TIMEOUT = 30000;
const NAVIGATION_TIMEOUT = 60000;
const TURNSTILE_TIMEOUT = 60000;

// ============================================================
// 账户配置
//
// 推荐通过 GitHub Actions Secrets 设置 ACCOUNTS。
// ACCOUNTS 必须是 JSON 数组。
// ============================================================

const DEFAULT_ACCOUNTS = [
    {
        username: '',
        password: ''
    }
];

function loadAccounts() {
    let accounts;

    try {
        const raw = process.env.ACCOUNTS;

        accounts = raw
            ? JSON.parse(raw)
            : DEFAULT_ACCOUNTS;

        if (!Array.isArray(accounts)) {
            throw new Error('ACCOUNTS 必须是 JSON 数组');
        }

        if (accounts.length === 0) {
            throw new Error('没有配置任何账户');
        }

        for (const account of accounts) {
            if (
                !account ||
                typeof account.username !== 'string' ||
                typeof account.password !== 'string' ||
                !account.username.trim() ||
                !account.password
            ) {
                throw new Error(
                    '每个账户都必须提供有效的 username 和 password'
                );
            }
        }

        return accounts;

    } catch (error) {
        throw new Error(`账户配置错误：${error.message}`);
    }
}

// ============================================================
// Telegram
// ============================================================

const TG_CHAT_ID = process.env.TG_CHAT_ID || '';
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || '';

async function sendTelegramNotification(message, imagePath = null) {
    if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
        console.log('⚠️ 未配置 Telegram，跳过通知');
        return;
    }

    const endpoint = imagePath && fs.existsSync(imagePath)
        ? `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendPhoto`
        : `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`;

    try {
        const form = new FormData();

        form.append('chat_id', TG_CHAT_ID);

        if (endpoint.endsWith('/sendPhoto')) {
            form.append('caption', message);

            const buffer = fs.readFileSync(imagePath);

            form.append(
                'photo',
                new Blob([buffer], { type: 'image/png' }),
                path.basename(imagePath)
            );
        } else {
            form.append('text', message);
        }

        const controller = new AbortController();

        const timer = setTimeout(
            () => controller.abort(),
            20000
        );

        let response;

        try {
            response = await fetch(endpoint, {
                method: 'POST',
                body: form,
                signal: controller.signal
            });
        } finally {
            clearTimeout(timer);
        }

        const result = await response.json().catch(() => null);

        if (!response.ok || !result?.ok) {
            console.error(
                '❌ Telegram 发送失败：',
                result?.description || `HTTP ${response.status}`
            );
            return;
        }

        console.log('✅ Telegram 通知已发送');

    } catch (error) {
        console.error(
            '❌ Telegram 通知异常：',
            error.message
        );
    }
}

// ============================================================
// 上海时间
// ============================================================

function getShanghaiTime() {
    return new Date().toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    });
}

// ============================================================
// 文件名
// ============================================================

function safeFileName(value) {
    return String(value)
        .replace(/[^a-zA-Z0-9._-]/g, '_');
}

// ============================================================
// 截图
// ============================================================

async function saveScreenshot(page, prefix, username) {
    if (!page || page.isClosed()) {
        return null;
    }

    const directory = path.join(process.cwd(), 'screenshots');

    fs.mkdirSync(directory, {
        recursive: true
    });

    const filename = [
        prefix,
        safeFileName(username),
        Date.now()
    ].join('_') + '.png';

    const filePath = path.join(directory, filename);

    try {
        await page.screenshot({
            path: filePath,
            fullPage: true,
            animations: 'disabled',
            timeout: 15000
        });

        console.log(`📸 截图已保存：${filePath}`);

        return filePath;

    } catch (error) {
        console.error('⚠️ 截图失败：', error.message);
        return null;
    }
}

// ============================================================
// 页面信息
// ============================================================

async function getPageInfo(page) {
    const info = {
        title: '',
        url: '',
        bodyText: ''
    };

    if (!page || page.isClosed()) {
        return info;
    }

    info.url = page.url();

    try {
        info.title = await page.title();
    } catch (_) {}

    try {
        info.bodyText = await page.locator('body').innerText({
            timeout: 5000
        });
    } catch (_) {}

    return info;
}

// ============================================================
// Turnstile 检测
//
// 这里只检测页面状态，不自动点击验证框、不伪造 Token。
// ============================================================

async function detectTurnstile(page) {
    try {
        const iframe = page.locator(
            'iframe[src*="challenges.cloudflare.com"]'
        );

        if (await iframe.count() > 0) {
            return true;
        }

        const container = page.locator('.cf-turnstile');

        if (await container.count() > 0) {
            return true;
        }

        const responseInput = page.locator(
            'input[name="cf-turnstile-response"],' +
            'textarea[name="cf-turnstile-response"]'
        );

        if (await responseInput.count() > 0) {
            return true;
        }

        return false;

    } catch (_) {
        return false;
    }
}

// ============================================================
// 检查验证响应
//
// 注意：响应字段非空不等于服务器已经接受验证。
// ============================================================

async function getTurnstileState(page) {
    try {
        return await page.evaluate(() => {
            const inputs = Array.from(
                document.querySelectorAll(
                    'input[name="cf-turnstile-response"],' +
                    'textarea[name="cf-turnstile-response"]'
                )
            );

            const values = inputs
                .map(input => input.value || '')
                .filter(Boolean);

            return {
                inputExists: inputs.length > 0,
                responsePresent: values.length > 0
            };
        });

    } catch (_) {
        return {
            inputExists: false,
            responsePresent: false
        };
    }
}

// ============================================================
// 等待 Turnstile
// ============================================================

async function waitForTurnstile(page, timeout = TURNSTILE_TIMEOUT) {
    const detected = await detectTurnstile(page);

    if (!detected) {
        console.log('ℹ️ 未检测到 Turnstile 组件');

        return {
            detected: false,
            passed: true
        };
    }

    console.log('🛡️ 检测到 Cloudflare Turnstile');
    console.log(
        `⏳ 等待验证状态更新，最多 ${timeout / 1000} 秒`
    );

    const start = Date.now();
    let previousState = '';

    while (Date.now() - start < timeout) {
        if (page.isClosed()) {
            return {
                detected: true,
                passed: false,
                reason: 'PAGE_CLOSED'
            };
        }

        const info = await getPageInfo(page);

        // 页面已经离开登录路径时，交给后续登录检查判断。
        if (!info.url.includes('/login/')) {
            console.log('ℹ️ 页面已离开登录路径');

            return {
                detected: true,
                passed: true,
                reason: 'PAGE_NAVIGATED'
            };
        }

        const state = await getTurnstileState(page);

        const stateText = state.responsePresent
            ? '检测到验证响应，仍需由站点确认'
            : state.inputExists
                ? '验证组件存在，尚未检测到响应'
                : '等待验证组件更新';

        if (stateText !== previousState) {
            console.log(`ℹ️ ${stateText}`);
            previousState = stateText;
        }

        await page.waitForTimeout(1000);
    }

    console.log('⚠️ Turnstile 等待超时');

    return {
        detected: true,
        passed: false,
        reason: 'TURNSTILE_TIMEOUT'
    };
}

// ============================================================
// 登录错误判断
// ============================================================

function getLoginError(bodyText) {
    const patterns = [
        {
            reason: 'TURNSTILE_REQUIRED',
            keywords: [
                '「私はロボットではありません」にチェックを入れてください',
                '私はロボットではありません',
                'ロボットではありません'
            ]
        },
        {
            reason: 'LOGIN_FAILED',
            keywords: [
                'ログインできません',
                'メールアドレスまたはパスワード',
                'パスワードが正しくありません',
                'アカウントIDまたはパスワード'
            ]
        }
    ];

    for (const item of patterns) {
        if (item.keywords.some(keyword => bodyText.includes(keyword))) {
            return item.reason;
        }
    }

    return null;
}

// ============================================================
// 登录状态检查
// ============================================================

async function isLoggedIn(page) {
    if (!page || page.isClosed()) {
        return false;
    }

    const currentUrl = page.url();

    // 登录页面不能仅凭 URL 变化以外的状态判断为已登录。
    if (currentUrl.includes('/login/')) {
        return false;
    }

    const gameLink = page.getByRole('link', {
        name: 'ゲーム管理',
        exact: true
    });

    try {
        if (
            await gameLink.count() > 0 &&
            await gameLink.first().isVisible()
        ) {
            return true;
        }
    } catch (_) {}

    return false;
}

// ============================================================
// XServer 登录
// ============================================================

async function loginXServer(page, username, password) {
    console.log('🌐 访问 XServer 登录页面');

    await page.goto(LOGIN_URL, {
        waitUntil: 'domcontentloaded',
        timeout: NAVIGATION_TIMEOUT
    });

    console.log(`🔗 URL：${page.url()}`);
    console.log(`📄 标题：${await page.title()}`);

    // --------------------------------------------------------
    // 用户名
    // --------------------------------------------------------

    const usernameInput = page.getByRole('textbox', {
        name: 'XServerアカウントID または メールアドレス',
        exact: true
    });

    await usernameInput.waitFor({
        state: 'visible',
        timeout: DEFAULT_TIMEOUT
    });

    await usernameInput.fill(username);

    // --------------------------------------------------------
    // 密码
    // --------------------------------------------------------

    const passwordInput = page.locator('#user_password');

    await passwordInput.waitFor({
        state: 'visible',
        timeout: DEFAULT_TIMEOUT
    });

    await passwordInput.fill(password);

    console.log('✅ 账号密码填写完成');

    // --------------------------------------------------------
    // Turnstile
    // --------------------------------------------------------

    const turnstile = await waitForTurnstile(
        page,
        TURNSTILE_TIMEOUT
    );

    if (turnstile.detected && !turnstile.passed) {
        return {
            success: false,
            reason: 'TURNSTILE_REQUIRED'
        };
    }

    // --------------------------------------------------------
    // 登录按钮
    // --------------------------------------------------------

    const loginButton = page.locator('#login-submit');

    await loginButton.waitFor({
        state: 'visible',
        timeout: DEFAULT_TIMEOUT
    });

    console.log('🖱️ 提交登录表单');

    await loginButton.click();

    // --------------------------------------------------------
    // 检查登录结果
    // --------------------------------------------------------

    console.log('⏳ 等待登录结果');

    const deadline = Date.now() + 60000;

    while (Date.now() < deadline) {
        if (page.isClosed()) {
            return {
                success: false,
                reason: 'PAGE_CLOSED'
            };
        }

        if (await isLoggedIn(page)) {
            console.log('✅ 已检测到游戏管理页面');

            return {
                success: true
            };
        }

        const info = await getPageInfo(page);
        const errorReason = getLoginError(info.bodyText);

        if (errorReason) {
            return {
                success: false,
                reason: errorReason
            };
        }

        await page.waitForTimeout(1500);
    }

    return {
        success: false,
        reason: 'LOGIN_TIMEOUT'
    };
}

// ============================================================
// 查找页面链接
// ============================================================

async function clickLinkByExactText(page, text) {
    const link = page.getByRole('link', {
        name: text,
        exact: true
    });

    await link.waitFor({
        state: 'visible',
        timeout: DEFAULT_TIMEOUT
    });

    await link.click();

    await page.waitForLoadState('domcontentloaded', {
        timeout: DEFAULT_TIMEOUT
    }).catch(() => {});

    await page.waitForTimeout(1200);
}

// ============================================================
// 续期
// ============================================================

async function renewXServer(page) {
    console.log('🎮 进入游戏管理');

    await clickLinkByExactText(page, 'ゲーム管理');

    console.log('📅 进入升级 / 期限延长');

    await clickLinkByExactText(
        page,
        'アップグレード・期限延長'
    );

    // --------------------------------------------------------
    // 查找续期入口
    // --------------------------------------------------------

    const extendLink = page.getByRole('link', {
        name: '期限を延長する',
        exact: true
    });

    try {
        await extendLink.waitFor({
            state: 'visible',
            timeout: 10000
        });
    } catch (_) {
        const info = await getPageInfo(page);

        const match = info.bodyText.match(
            /更新をご希望の場合は、(.+?)以降にお試しください。/
        );

        if (match && match[1]) {
            return {
                success: false,
                notYet: true,
                availableTime: match[1]
            };
        }

        return {
            success: false,
            notYet: true
        };
    }

    // --------------------------------------------------------
    // 点击续期
    // --------------------------------------------------------

    console.log('🖱️ 点击期限延长入口');

    await extendLink.click();

    await page.waitForLoadState('domcontentloaded', {
        timeout: DEFAULT_TIMEOUT
    }).catch(() => {});

    await page.waitForTimeout(1000);

    // --------------------------------------------------------
    // 确认页面
    // --------------------------------------------------------

    const confirmButton = page.getByRole('button', {
        name: '確認画面に進む',
        exact: true
    });

    await confirmButton.waitFor({
        state: 'visible',
        timeout: DEFAULT_TIMEOUT
    });

    console.log('🖱️ 点击确认页面按钮');

    await confirmButton.click();

    await page.waitForLoadState('domcontentloaded', {
        timeout: DEFAULT_TIMEOUT
    }).catch(() => {});

    await page.waitForTimeout(1000);

    // --------------------------------------------------------
    // 最终续期
    // --------------------------------------------------------

    const finalButton = page.getByRole('button', {
        name: '期限を延長する',
        exact: true
    });

    await finalButton.waitFor({
        state: 'visible',
        timeout: DEFAULT_TIMEOUT
    });

    console.log('🖱️ 提交最终续期操作');

    await finalButton.click();

    await page.waitForLoadState('domcontentloaded', {
        timeout: DEFAULT_TIMEOUT
    }).catch(() => {});

    await page.waitForTimeout(2500);

    // --------------------------------------------------------
    // 检查续期结果
    // --------------------------------------------------------

    const info = await getPageInfo(page);

    const successKeywords = [
        '延長しました',
        '延長されました',
        '期限を延長しました',
        '更新しました',
        '完了しました'
    ];

    const confirmed = successKeywords.some(
        keyword => info.bodyText.includes(keyword)
    );

    if (confirmed) {
        console.log('✅ 页面显示续期完成提示');
    } else {
        console.log('⚠️ 尚未确认续期成功');
    }

    return {
        success: confirmed,
        confirmed,
        url: info.url
    };
}

// ============================================================
// 获取出口 IP
// ============================================================

async function getExitIP() {
    try {
        const controller = new AbortController();

        const timer = setTimeout(
            () => controller.abort(),
            10000
        );

        let response;

        try {
            response = await fetch('https://api.ip.sb/ip', {
                signal: controller.signal
            });
        } finally {
            clearTimeout(timer);
        }

        if (!response.ok) {
            return `HTTP ${response.status}`;
        }

        return (await response.text()).trim();

    } catch (error) {
        return `检测失败：${error.message}`;
    }
}

// ============================================================
// 单账户处理
// ============================================================

async function processAccount(browser, user, index) {
    let context = null;
    let page = null;

    const username = user.username;

    console.log('');
    console.log('======================================');
    console.log(`👤 处理账户 ${index}：${username}`);
    console.log('======================================');

    try {
        context = await browser.newContext({
            viewport: {
                width: 1366,
                height: 768
            },
            locale: 'ja-JP',
            timezoneId: 'Asia/Tokyo'
        });

        page = await context.newPage();

        page.setDefaultTimeout(DEFAULT_TIMEOUT);
        page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT);

        // ----------------------------------------------------
        // 登录
        // ----------------------------------------------------

        const login = await loginXServer(
            page,
            username,
            user.password
        );

        if (!login.success) {
            const info = await getPageInfo(page);

            const reasonMap = {
                TURNSTILE_REQUIRED:
                    'Cloudflare Turnstile 尚未完成验证',
                LOGIN_FAILED:
                    'XServer 登录失败，请检查账号、密码或页面提示',
                LOGIN_TIMEOUT:
                    '登录等待超时',
                PAGE_CLOSED:
                    '浏览器页面意外关闭'
            };

            const reason = reasonMap[login.reason] ||
                login.reason ||
                '未知原因';

            console.error(`❌ 登录失败：${reason}`);

            const screenshot = await saveScreenshot(
                page,
                'login_failed',
                username
            );

            await sendTelegramNotification(
                [
                    '🇯🇵 XServer 自动续期通知',
                    '',
                    '❌ 登录失败',
                    `账户：${username}`,
                    `原因：${reason}`,
                    `页面：${info.url}`,
                    `标题：${info.title}`,
                    '',
                    `页面提示：${info.bodyText.slice(0, 700)}`,
                    '',
                    `上海时间：${getShanghaiTime()}`
                ].join('\n'),
                screenshot
            );

            return false;
        }

        // ----------------------------------------------------
        // 续期
        // ----------------------------------------------------

        const renew = await renewXServer(page);

        if (renew.notYet) {
            const message = [
                '🇯🇵 XServer 自动续期通知',
                '',
                '⚠️ 当前尚无法续期',
                `账户：${username}`,
                renew.availableTime
                    ? `可续期时间：${renew.availableTime}`
                    : '未找到续期入口，请检查页面截图',
                '',
                `上海时间：${getShanghaiTime()}`
            ].join('\n');

            console.log(message);

            const screenshot = await saveScreenshot(
                page,
                'not_yet',
                username
            );

            await sendTelegramNotification(
                message,
                screenshot
            );

            return true;
        }

        // ----------------------------------------------------
        // 续期结果
        // ----------------------------------------------------

        const screenshot = await saveScreenshot(
            page,
            renew.confirmed ? 'renewed' : 'renew_uncertain',
            username
        );

        const message = [
            '🇯🇵 XServer 自动续期通知',
            '',
            renew.confirmed
                ? '✅ 页面确认续期完成'
                : '⚠️ 已执行续期操作，但无法确认最终结果',
            `账户：${username}`,
            `页面：${renew.url || page.url()}`,
            '',
            `上海时间：${getShanghaiTime()}`
        ].join('\n');

        console.log(message);

        await sendTelegramNotification(
            message,
            screenshot
        );

        return renew.confirmed;

    } catch (error) {
        console.error('❌ 账户处理异常：', error);

        const info = await getPageInfo(page);

        const screenshot = await saveScreenshot(
            page,
            'error',
            username
        );

        await sendTelegramNotification(
            [
                '🇯🇵 XServer 自动续期通知',
                '',
                '❌ 操作异常',
                `账户：${username}`,
                `错误：${error.message}`,
                `页面：${info.url || '未知'}`,
                '',
                `上海时间：${getShanghaiTime()}`
            ].join('\n'),
            screenshot
        );

        return false;

    } finally {
        if (context) {
            await context.close().catch(() => {});
        }
    }
}

// ============================================================
// 主程序
// ============================================================

async function main() {
    console.log('');
    console.log('======================================');
    console.log('🇯🇵 XServer 自动续期程序');
    console.log('======================================');
    console.log(`🕐 上海时间：${getShanghaiTime()}`);
    console.log('');

    const accounts = loadAccounts();

    console.log(`👥 共发现 ${accounts.length} 个账户`);

    // --------------------------------------------------------
    // 代理配置
    // --------------------------------------------------------

    const isProxy = process.env.IS_PROXY === 'true';

    const proxyServer =
        process.env.PROXY_SERVER ||
        'socks5://127.0.0.1:1080';

    const launchOptions = {
        headless: true,
        channel: 'chrome',
        args: [
            '--disable-dev-shm-usage',
            '--no-sandbox',
            '--disable-setuid-sandbox'
        ]
    };

    if (isProxy) {
        launchOptions.proxy = {
            server: proxyServer
        };

        console.log(`✅ 浏览器代理已启用：${proxyServer}`);
    } else {
        console.log('ℹ️ 浏览器直连模式');
    }

    // --------------------------------------------------------
    // 启动浏览器
    // --------------------------------------------------------

    let browser;

    try {
        browser = await chromium.launch(launchOptions);

        console.log('✅ Chrome 浏览器启动成功');

    } catch (error) {
        console.error('❌ Chrome 启动失败：', error.message);
        process.exitCode = 1;
        return;
    }

    let failedCount = 0;

    try {
        console.log('🌐 正在检测当前出口 IP...');

        const ip = await getExitIP();

        console.log(
            `📍 当前出口 IP：${ip}${isProxy ? '（代理）' : '（直连）'}`
        );

        // ----------------------------------------------------
        // 逐个账户处理
        // ----------------------------------------------------

        for (let i = 0; i < accounts.length; i++) {
            const success = await processAccount(
                browser,
                accounts[i],
                i + 1
            );

            if (!success) {
                failedCount++;
            }
        }

    } finally {
        await browser.close().catch(() => {});
    }

    console.log('');
    console.log('======================================');
    console.log('🏁 所有账户处理完成');
    console.log(`账户总数：${accounts.length}`);
    console.log(`处理失败或未确认：${failedCount}`);
    console.log('======================================');

    if (failedCount > 0) {
        process.exitCode = 1;
    }
}

// ============================================================
// 入口
// ============================================================

main().catch(async error => {
    console.error('❌ 程序异常退出：', error);

    await sendTelegramNotification(
        [
            '🇯🇵 XServer 自动续期程序异常退出',
            '',
            `错误：${error.message}`,
            `上海时间：${getShanghaiTime()}`
        ].join('\n')
    );

    process.exitCode = 1;
});
