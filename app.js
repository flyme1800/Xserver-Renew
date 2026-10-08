const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

// ============================================================
// XServer 账户配置
// ============================================================

const ACCOUNTS = process.env.ACCOUNTS || `
[
    {
        "username": "",
        "password": ""
    }
]`;

// ============================================================
// Telegram
// ============================================================

const TG_CHAT_ID = process.env.TG_CHAT_ID || '';
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || '';

// ============================================================
// Proxy
// ============================================================

const IS_PROXY = process.env.IS_PROXY === 'true';

const PROXY_SERVER =
    process.env.PROXY_SERVER ||
    'socks5://127.0.0.1:1080';

// ============================================================
// 时间配置
// ============================================================

const DEFAULT_TIMEOUT = 30000;
const NAVIGATION_TIMEOUT = 60000;

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
// 文件名清理
// ============================================================

function safeFileName(name) {
    return String(name)
        .replace(/[^a-zA-Z0-9._-]/g, '_');
}

// ============================================================
// Telegram
// ============================================================

async function sendTelegramNotification(
    message,
    imagePath = null
) {
    if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
        console.log(
            '⚠️ 未设置 Telegram Bot Token 或 Chat ID，跳过通知。'
        );
        return;
    }

    try {

        // ----------------------------------------------------
        // 图片
        // ----------------------------------------------------

        if (
            imagePath &&
            fs.existsSync(imagePath)
        ) {

            const formData = new FormData();

            formData.append(
                'chat_id',
                TG_CHAT_ID
            );

            formData.append(
                'caption',
                message
            );

            const fileBuffer =
                fs.readFileSync(imagePath);

            const blob =
                new Blob([fileBuffer]);

            formData.append(
                'photo',
                blob,
                path.basename(imagePath)
            );

            const response =
                await fetch(
                    `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendPhoto`,
                    {
                        method: 'POST',
                        body: formData
                    }
                );

            if (!response.ok) {

                console.error(
                    '❌ Telegram 图片发送失败:',
                    await response.text()
                );

            } else {

                console.log(
                    '✅ Telegram 图片通知已发送'
                );
            }

            return;
        }

        // ----------------------------------------------------
        // 文字
        // ----------------------------------------------------

        const response =
            await fetch(
                `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type':
                            'application/json'
                    },
                    body: JSON.stringify({
                        chat_id: TG_CHAT_ID,
                        text: message
                    })
                }
            );

        if (!response.ok) {

            console.error(
                '❌ Telegram 消息发送失败:',
                await response.text()
            );

        } else {

            console.log(
                '✅ Telegram 文字通知已发送'
            );
        }

    } catch (error) {

        console.error(
            '❌ Telegram 通知异常:',
            error.message
        );
    }
}

// ============================================================
// 页面信息
// ============================================================

async function getPageInfo(page) {

    let title = '';
    let url = '';
    let bodyText = '';

    try {
        title = await page.title();
    } catch (_) {}

    try {
        url = page.url();
    } catch (_) {}

    try {

        bodyText =
            await page.locator('body')
                .innerText({
                    timeout: 5000
                });

    } catch (_) {}

    return {
        title,
        url,
        bodyText
    };
}

// ============================================================
// 截图
// ============================================================

async function saveScreenshot(
    page,
    prefix,
    username
) {

    const fileName =
        `${prefix}_${safeFileName(username)}_${Date.now()}.png`;

    try {

        await page.screenshot({
            path: fileName,
            fullPage: true
        });

        console.log(
            `📸 截图已保存: ${fileName}`
        );

        return fileName;

    } catch (error) {

        console.error(
            `⚠️ 截图失败: ${error.message}`
        );

        return null;
    }
}

// ============================================================
// 读取账户
// ============================================================

function loadAccounts() {

    let users = [];

    try {

        if (process.env.ACCOUNTS) {

            users =
                JSON.parse(
                    process.env.ACCOUNTS
                );

        } else {

            console.log(
                '⚠️ 未找到 ACCOUNTS 环境变量，使用默认配置。'
            );

            users =
                JSON.parse(ACCOUNTS);
        }

        if (!Array.isArray(users)) {
            throw new Error(
                'ACCOUNTS 必须是 JSON 数组'
            );
        }

    } catch (error) {

        console.error(
            '❌ ACCOUNTS 解析失败:',
            error.message
        );

        process.exit(1);
    }

    return users;
}

// ============================================================
// 判断页面是否出现 Turnstile
// ============================================================

async function detectTurnstile(page) {

    try {

        // Cloudflare Turnstile iframe
        const iframe =
            page.locator(
                'iframe[src*="challenges.cloudflare.com"]'
            );

        if (
            await iframe.count() > 0
        ) {
            return true;
        }

        // Turnstile container
        const container =
            page.locator(
                '.cf-turnstile'
            );

        if (
            await container.count() > 0
        ) {
            return true;
        }

        // 页面文字
        const bodyText =
            await page.locator('body')
                .innerText()
                .catch(() => '');

        if (
            bodyText.includes(
                '私はロボットではありません'
            )
        ) {
            return true;
        }

    } catch (_) {}

    return false;
}

// ============================================================
// 判断 Turnstile 是否已经完成
// ============================================================

async function isTurnstilePassed(page) {

    try {

        // ---------------------------------------------
        // cf-turnstile-response
        // ---------------------------------------------

        const responseInput =
            page.locator(
                'input[name="cf-turnstile-response"]'
            );

        if (
            await responseInput.count() > 0
        ) {

            const value =
                await responseInput
                    .first()
                    .inputValue()
                    .catch(() => '');

            if (
                value &&
                value.length > 0
            ) {
                return true;
            }
        }

        // ---------------------------------------------
        // iframe 内 checkbox 状态
        // ---------------------------------------------

        for (
            const frame of page.frames()
        ) {

            if (
                !frame.url().includes(
                    'challenges.cloudflare.com'
                )
            ) {
                continue;
            }

            try {

                const checkbox =
                    frame.getByRole(
                        'checkbox'
                    );

                if (
                    await checkbox.count() > 0
                ) {

                    const ariaChecked =
                        await checkbox
                            .first()
                            .getAttribute(
                                'aria-checked'
                            );

                    if (
                        ariaChecked === 'true'
                    ) {
                        return true;
                    }
                }

            } catch (_) {}
        }

    } catch (_) {}

    return false;
}

// ============================================================
// 等待 Turnstile
//
// 注意：
// 不自动破解、不注入 token、不绕过 Cloudflare。
// 如果已经由正常浏览器环境完成验证，则继续。
// ============================================================

async function waitForTurnstile(
    page,
    maxWait = 15000
) {

    const detected =
        await detectTurnstile(page);

    if (!detected) {

        console.log(
            'ℹ️ 未检测到 Cloudflare Turnstile'
        );

        return {
            detected: false,
            passed: true
        };
    }

    console.log(
        '🛡️ 检测到 Cloudflare Turnstile'
    );

    console.log(
        '⏳ 等待 Turnstile 正常完成验证...'
    );

    const start =
        Date.now();

    while (
        Date.now() - start < maxWait
    ) {

        const passed =
            await isTurnstilePassed(page);

        if (passed) {

            console.log(
                '✅ Turnstile 验证状态已通过'
            );

            return {
                detected: true,
                passed: true
            };
        }

        await page.waitForTimeout(1000);
    }

    console.log(
        '⚠️ Turnstile 尚未完成验证'
    );

    return {
        detected: true,
        passed: false
    };
}

// ============================================================
// 登录
// ============================================================

async function loginXServer(
    page,
    username,
    password
) {

    console.log(
        '🌐 访问 XServer 登录页面...'
    );

    await page.goto(
        'https://secure.xserver.ne.jp/xapanel/login/xmgame',
        {
            waitUntil:
                'domcontentloaded',
            timeout:
                NAVIGATION_TIMEOUT
        }
    );

    console.log(
        `🔗 URL: ${page.url()}`
    );

    console.log(
        `📄 标题: ${await page.title()}`
    );

    // --------------------------------------------------------
    // 用户名
    // --------------------------------------------------------

    console.log(
        '⏳ 等待用户名输入框...'
    );

    const usernameInput =
        page.getByRole(
            'textbox',
            {
                name:
                    'XServerアカウントID または メールアドレス',
                exact: true
            }
        );

    await usernameInput.waitFor({
        state: 'visible',
        timeout: DEFAULT_TIMEOUT
    });

    await usernameInput.fill(
        username
    );

    // --------------------------------------------------------
    // 密码
    // --------------------------------------------------------

    const passwordInput =
        page.locator(
            '#user_password'
        );

    await passwordInput.waitFor({
        state: 'visible',
        timeout: DEFAULT_TIMEOUT
    });

    await passwordInput.fill(
        password
    );

    console.log(
        '✅ 账号密码填写完成'
    );

    // --------------------------------------------------------
    // 检查 Turnstile
    // --------------------------------------------------------

    const turnstile =
        await waitForTurnstile(
            page,
            15000
        );

    // --------------------------------------------------------
    // 如果存在 Turnstile 且没有通过
    // --------------------------------------------------------

    if (
        turnstile.detected &&
        !turnstile.passed
    ) {

        return {
            success: false,
            reason: 'TURNSTILE_REQUIRED'
        };
    }

    // --------------------------------------------------------
    // 登录按钮
    //
    // 使用明确 ID：
    // #login-submit
    //
    // 不使用：
    // getByRole('button', {name:'ログインする'})
    //
    // 因为 Google 登录按钮也可能匹配。
    // --------------------------------------------------------

    const loginButton =
        page.locator(
            '#login-submit'
        );

    await loginButton.waitFor({
        state: 'visible',
        timeout: DEFAULT_TIMEOUT
    });

    console.log(
        '🖱️ 点击「ログインする」...'
    );

    await loginButton.click();

    console.log(
        '✅ 登录按钮已点击'
    );

    // --------------------------------------------------------
    // 等待登录
    // --------------------------------------------------------

    console.log(
        '⏳ 等待 XServer 登录结果...'
    );

    for (
        let i = 0;
        i < 30;
        i++
    ) {

        const currentUrl =
            page.url();

        // ----------------------------------------------
        // 游戏管理
        // ----------------------------------------------

        const gameLink =
            page.getByRole(
                'link',
                {
                    name:
                        'ゲーム管理',
                    exact: true
                }
            );

        if (
            await gameLink.count() > 0
        ) {

            try {

                if (
                    await gameLink.isVisible()
                ) {

                    console.log(
                        '✅ 登录成功'
                    );

                    return {
                        success: true
                    };
                }

            } catch (_) {}
        }

        // ----------------------------------------------
        // 检查登录错误
        // ----------------------------------------------

        const bodyText =
            await page.locator('body')
                .innerText()
                .catch(() => '');

        if (
            bodyText.includes(
                '「私はロボットではありません」にチェックを入れてください'
            )
        ) {

            console.log(
                '❌ XServer 要求完成 Turnstile'
            );

            return {
                success: false,
                reason: 'TURNSTILE_REQUIRED'
            };
        }

        // ----------------------------------------------
        // 常见账号密码错误
        // ----------------------------------------------

        if (
            bodyText.includes(
                'ログインできません'
            ) ||
            bodyText.includes(
                'メールアドレスまたはパスワード'
            )
        ) {

            console.log(
                '❌ XServer 返回登录错误'
            );

            return {
                success: false,
                reason: 'LOGIN_FAILED'
            };
        }

        // ----------------------------------------------
        // URL 已离开 login
        // ----------------------------------------------

        if (
            !currentUrl.includes(
                '/login/'
            )
        ) {

            await page.waitForTimeout(
                2000
            );

            const gameLink2 =
                page.getByRole(
                    'link',
                    {
                        name:
                            'ゲーム管理',
                        exact: true
                    }
                );

            if (
                await gameLink2.count() > 0
            ) {

                try {

                    if (
                        await gameLink2.isVisible()
                    ) {

                        return {
                            success: true
                        };
                    }

                } catch (_) {}
            }
        }

        await page.waitForTimeout(
            2000
        );
    }

    return {
        success: false,
        reason: 'LOGIN_TIMEOUT'
    };
}

// ============================================================
// 续期
// ============================================================

async function renewXServer(
    page,
    username
) {

    // --------------------------------------------------------
    // 游戏管理
    // --------------------------------------------------------

    console.log(
        '🎮 进入「ゲーム管理」...'
    );

    const gameManagement =
        page.getByRole(
            'link',
            {
                name:
                    'ゲーム管理',
                exact: true
            }
        );

    await gameManagement.waitFor({
        state: 'visible',
        timeout: DEFAULT_TIMEOUT
    });

    await gameManagement.click();

    await page.waitForLoadState(
        'domcontentloaded',
        {
            timeout: DEFAULT_TIMEOUT
        }
    ).catch(() => {});

    await page.waitForTimeout(
        1500
    );

    // --------------------------------------------------------
    // 升级 / 延长
    // --------------------------------------------------------

    console.log(
        '📅 进入「アップグレード・期限延長」...'
    );

    const upgradeLink =
        page.getByRole(
            'link',
            {
                name:
                    'アップグレード・期限延長',
                exact: true
            }
        );

    await upgradeLink.waitFor({
        state: 'visible',
        timeout: DEFAULT_TIMEOUT
    });

    await upgradeLink.click();

    await page.waitForLoadState(
        'domcontentloaded',
        {
            timeout: DEFAULT_TIMEOUT
        }
    ).catch(() => {});

    await page.waitForTimeout(
        1500
    );

    // --------------------------------------------------------
    // 查找续期
    // --------------------------------------------------------

    const extendLink =
        page.getByRole(
            'link',
            {
                name:
                    '期限を延長する',
                exact: true
            }
        );

    let available = false;

    try {

        await extendLink.waitFor({
            state: 'visible',
            timeout: 10000
        });

        available = true;

    } catch (_) {

        available = false;
    }

    // --------------------------------------------------------
    // 尚未到续期时间
    // --------------------------------------------------------

    if (!available) {

        const bodyText =
            await page.locator('body')
                .innerText()
                .catch(() => '');

        const match =
            bodyText.match(
                /更新をご希望の場合は、(.+?)以降にお試しください。/
            );

        if (
            match &&
            match[1]
        ) {

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
    // 点击延长
    // --------------------------------------------------------

    console.log(
        '📅 已到续期时间'
    );

    console.log(
        '🖱️ 点击「期限を延長する」...'
    );

    await extendLink.click();

    await page.waitForTimeout(
        1000
    );

    // --------------------------------------------------------
    // 确认
    // --------------------------------------------------------

    const confirmButton =
        page.getByRole(
            'button',
            {
                name:
                    '確認画面に進む',
                exact: true
            }
        );

    await confirmButton.waitFor({
        state: 'visible',
        timeout: DEFAULT_TIMEOUT
    });

    console.log(
        '🖱️ 点击「確認画面に進む」...'
    );

    await confirmButton.click();

    await page.waitForTimeout(
        1500
    );

    // --------------------------------------------------------
    // 最终续期
    // --------------------------------------------------------

    const finalButton =
        page.getByRole(
            'button',
            {
                name:
                    '期限を延長する',
                exact: true
            }
        );

    await finalButton.waitFor({
        state: 'visible',
        timeout: DEFAULT_TIMEOUT
    });

    console.log(
        '🖱️ 点击最终「期限を延長する」...'
    );

    await finalButton.click();

    console.log(
        '✅ 最终续期按钮已点击'
    );

    await page.waitForTimeout(
        3000
    );

    // --------------------------------------------------------
    // 检查结果
    // --------------------------------------------------------

    const bodyText =
        await page.locator('body')
            .innerText()
            .catch(() => '');

    const successKeywords = [
        '延長しました',
        '延長されました',
        '期限を延長しました',
        '更新しました',
        '完了しました'
    ];

    const success =
        successKeywords.some(
            keyword =>
                bodyText.includes(keyword)
        );

    return {
        success: true,
        confirmed: success
    };
}

// ============================================================
// 主程序
// ============================================================

(async () => {

    console.log('');
    console.log(
        '======================================'
    );
    console.log(
        '🇯🇵 XServer 自动续期程序'
    );
    console.log(
        '======================================'
    );

    console.log(
        `🕐 上海时间: ${getShanghaiTime()}`
    );

    console.log('');

    // ========================================================
    // Accounts
    // ========================================================

    const users =
        loadAccounts();

    if (!users.length) {

        console.error(
            '❌ 没有配置任何账户'
        );

        process.exit(1);
    }

    console.log(
        `👥 共发现 ${users.length} 个账户`
    );

    // ========================================================
    // Browser
    // ========================================================

    const launchOptions = {

        headless: true,

        channel: 'chrome',

        args: [
            '--disable-dev-shm-usage',
            '--no-sandbox',
            '--disable-setuid-sandbox'
        ]
    };

    // ========================================================
    // Proxy
    // ========================================================

    if (
        IS_PROXY &&
        PROXY_SERVER
    ) {

        launchOptions.proxy = {
            server:
                PROXY_SERVER
        };

        console.log(
            `✅ 浏览器代理已启用: ${PROXY_SERVER}`
        );

    } else {

        console.log(
            'ℹ️ 浏览器直连模式'
        );
    }

    // ========================================================
    // 启动 Chrome
    // ========================================================

    let browser;

    try {

        browser =
            await chromium.launch(
                launchOptions
            );

        console.log(
            '✅ Chrome 浏览器启动成功'
        );

    } catch (error) {

        console.error(
            '❌ Chrome 启动失败:',
            error
        );

        process.exit(1);
    }

    // ========================================================
    // 出口 IP
    // ========================================================

    try {

        console.log(
            '🌐 正在检测当前出口 IP...'
        );

        const response =
            await fetch(
                'https://api.ip.sb/ip'
            );

        if (response.ok) {

            const ip =
                (await response.text())
                    .trim();

            console.log(
                `📍 当前出口IP: ${ip}${IS_PROXY ? ' (代理)' : ' (直连)'}`
            );

        } else {

            console.log(
                `⚠️ IP 检测失败: HTTP ${response.status}`
            );
        }

    } catch (error) {

        console.log(
            `⚠️ IP 检测异常: ${error.message}`
        );
    }

    // ========================================================
    // 逐个账户
    // ========================================================

    for (
        const user of users
    ) {

        console.log('');
        console.log(
            '======================================'
        );

        console.log(
            `👤 正在处理用户: ${user.username}`
        );

        console.log(
            '======================================'
        );

        let context = null;
        let page = null;

        try {

            // --------------------------------------------------
            // 检查账号
            // --------------------------------------------------

            if (
                !user.username ||
                !user.password
            ) {

                throw new Error(
                    'username 或 password 为空'
                );
            }

            // --------------------------------------------------
            // Context
            // --------------------------------------------------

            context =
                await browser.newContext({

                    viewport: {
                        width: 1366,
                        height: 768
                    },

                    locale: 'ja-JP',

                    timezoneId:
                        'Asia/Tokyo'
                });

            page =
                await context.newPage();

            page.setDefaultTimeout(
                DEFAULT_TIMEOUT
            );

            page.setDefaultNavigationTimeout(
                NAVIGATION_TIMEOUT
            );

            // --------------------------------------------------
            // 登录
            // --------------------------------------------------

            const loginResult =
                await loginXServer(
                    page,
                    user.username,
                    user.password
                );

            // --------------------------------------------------
            // 登录失败
            // --------------------------------------------------

            if (
                !loginResult.success
            ) {

                const info =
                    await getPageInfo(
                        page
                    );

                let reasonText =
                    '未知原因';

                if (
                    loginResult.reason ===
                    'TURNSTILE_REQUIRED'
                ) {

                    reasonText =
                        'Cloudflare Turnstile 未完成';

                } else if (
                    loginResult.reason ===
                    'LOGIN_FAILED'
                ) {

                    reasonText =
                        'XServer 登录失败';

                } else if (
                    loginResult.reason ===
                    'LOGIN_TIMEOUT'
                ) {

                    reasonText =
                        '登录超时';
                }

                console.error(
                    `❌ 登录失败: ${reasonText}`
                );

                console.error(
                    `🔗 ${info.url}`
                );

                const screenshotPath =
                    await saveScreenshot(
                        page,
                        'login_failed',
                        user.username
                    );

                const message =
                    `🇯🇵 XServer 续期通知

❌ 登录失败

👤 账户：
${user.username}

❌ 原因：
${reasonText}

🔗 当前页面：
${info.url}

📄 页面标题：
${info.title}

⚠️ 页面提示：
${info.bodyText.substring(0, 1000)}

🕐 运行时间：
${getShanghaiTime()}`;

                await sendTelegramNotification(
                    message,
                    screenshotPath
                );

                continue;
            }

            // --------------------------------------------------
            // 续期
            // --------------------------------------------------

            const renewResult =
                await renewXServer(
                    page,
                    user.username
                );

            // --------------------------------------------------
            // 尚未到续期时间
            // --------------------------------------------------

            if (
                renewResult.notYet
            ) {

                let message;

                if (
                    renewResult.availableTime
                ) {

                    message =
                        `🇯🇵 XServer 续期通知

⚠️ 尚未到续期时间

👤 账户：
${user.username}

📅 可续期时间：
${renewResult.availableTime}

🕐 运行时间：
${getShanghaiTime()}`;

                } else {

                    message =
                        `🇯🇵 XServer 续期通知

⚠️ 当前无法续期

👤 账户：
${user.username}

可能原因：
• 尚未到续期时间
• 当前服务不支持续期
• XServer 页面结构发生变化

🕐 运行时间：
${getShanghaiTime()}`;
                }

                console.log(
                    message
                );

                const screenshotPath =
                    await saveScreenshot(
                        page,
                        'skip',
                        user.username
                    );

                await sendTelegramNotification(
                    message,
                    screenshotPath
                );

                continue;
            }

            // --------------------------------------------------
            // 续期成功
            // --------------------------------------------------

            const successMessage =
                `🇯🇵 XServer 续期通知

✅ 续期操作已完成

👤 账户：
${user.username}

${renewResult.confirmed
    ? '✅ 页面已检测到完成提示'
    : 'ℹ️ 已执行最终续期操作'}

🕐 运行时间：
${getShanghaiTime()}`;

            console.log(
                successMessage
            );

            const screenshotPath =
                await saveScreenshot(
                    page,
                    'success',
                    user.username
                );

            await sendTelegramNotification(
                successMessage,
                screenshotPath
            );

        } catch (error) {

            // --------------------------------------------------
            // 异常
            // --------------------------------------------------

            console.error('');
            console.error(
                '======================================'
            );

            console.error(
                '❌ XServer 操作异常'
            );

            console.error(
                '======================================'
            );

            console.error(
                error
            );

            let currentUrl =
                '未知';

            try {

                if (page) {
                    currentUrl =
                        page.url();
                }

            } catch (_) {}

            const screenshotPath =
                page
                    ? await saveScreenshot(
                        page,
                        'error',
                        user.username
                    )
                    : null;

            const errorMessage =
                `❌ XServer 续期通知

❌ 操作失败

👤 账户：
${user.username}

❌ 错误：
${error.message || error}

🔗 当前页面：
${currentUrl}

🕐 运行时间：
${getShanghaiTime()}`;

            await sendTelegramNotification(
                errorMessage,
                screenshotPath
            );

        } finally {

            try {

                if (context) {
                    await context.close();
                }

            } catch (_) {}
        }
    }

    // ========================================================
    // 完成
    // ========================================================

    try {

        await browser.close();

    } catch (_) {}

    console.log('');
    console.log(
        '======================================'
    );
    console.log(
        '✅ 所有账户处理完成'
    );
    console.log(
        '======================================'
    );

})();
