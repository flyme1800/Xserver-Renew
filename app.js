const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

// ============================================================
// 环境变量
// ============================================================

// Cookie 主登录
const COOKIE_VALUE = process.env.COOKIE_VALUE || '';

// 账号密码备用登录
const ACCOUNTS = process.env.ACCOUNTS || `
[
    {
        "username": "",
        "password": ""
    }
]
`;

// ============================================================
// Telegram
// ============================================================

const TG_CHAT_ID = process.env.TG_CHAT_ID || '';
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || '';

// ============================================================
// 代理
// ============================================================

const IS_PROXY = process.env.IS_PROXY === 'true';
const PROXY_SERVER =
    process.env.PROXY_SERVER || 'socks5://127.0.0.1:1080';

// 如果启用代理，让 Node.js fetch 也使用代理
if (IS_PROXY && PROXY_SERVER) {
    try {
        const {
            ProxyAgent,
            setGlobalDispatcher
        } = require('undici');

        setGlobalDispatcher(
            new ProxyAgent(PROXY_SERVER)
        );

        console.log(`✅ Node.js fetch 代理已启用: ${PROXY_SERVER}`);

    } catch (e) {
        console.warn(
            `⚠️ 无法加载 undici 代理模块，fetch 将直连: ${e.message}`
        );
    }
}

// ============================================================
// 时间
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
// Telegram 通知
// ============================================================

async function sendTelegramNotification(
    message,
    imagePath = null
) {
    if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
        console.log(
            '未设置 Telegram Bot Token 或 Chat ID，跳过通知。'
        );
        return;
    }

    try {
        // 发送图片
        if (imagePath && fs.existsSync(imagePath)) {
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

            const response = await fetch(
                `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendPhoto`,
                {
                    method: 'POST',
                    body: formData
                }
            );

            if (!response.ok) {
                console.error(
                    'Telegram 图片发送失败:',
                    await response.text()
                );
            } else {
                console.log(
                    '✅ Telegram 图片通知已发送'
                );
            }

            return;
        }

        // 发送文字
        const response = await fetch(
            `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    chat_id: TG_CHAT_ID,
                    text: message
                })
            }
        );

        if (!response.ok) {
            console.error(
                'Telegram 消息发送失败:',
                await response.text()
            );
        } else {
            console.log(
                '✅ Telegram 文字通知已发送'
            );
        }

    } catch (error) {
        console.error(
            '发送 Telegram 通知时出错:',
            error
        );
    }
}

// ============================================================
// Cookie 解析
// ============================================================

function parseCookieString(rawCookieValue) {

    if (
        !rawCookieValue ||
        !rawCookieValue.trim()
    ) {
        return [];
    }

    let cookieText =
        rawCookieValue.trim();

    // 支持：
    // Cookie: xxx=xxx; yyy=yyy
    cookieText =
        cookieText.replace(
            /^Cookie\s*:\s*/i,
            ''
        );

    // --------------------------------------------------------
    // Playwright JSON Cookie
    // --------------------------------------------------------

    if (
        cookieText.startsWith('[') ||
        cookieText.startsWith('{')
    ) {
        try {
            const parsed =
                JSON.parse(cookieText);

            if (Array.isArray(parsed)) {

                return parsed
                    .filter(
                        item =>
                            item &&
                            item.name &&
                            item.value
                    )
                    .map(item => {

                        const cookie = {
                            name: String(item.name),
                            value: String(item.value),
                            url:
                                item.url ||
                                'https://secure.xserver.ne.jp/'
                        };

                        // 如果原始 JSON 中存在这些属性，则保留
                        if (item.domain)
                            cookie.domain = item.domain;

                        if (item.path)
                            cookie.path = item.path;

                        if (item.expires)
                            cookie.expires = item.expires;

                        if (
                            item.httpOnly !== undefined
                        ) {
                            cookie.httpOnly =
                                item.httpOnly;
                        }

                        if (
                            item.secure !== undefined
                        ) {
                            cookie.secure =
                                item.secure;
                        }

                        if (item.sameSite)
                            cookie.sameSite =
                                item.sameSite;

                        return cookie;
                    });
            }

        } catch (e) {
            console.warn(
                '⚠️ Cookie JSON 解析失败，改用普通 Cookie 格式'
            );
        }
    }

    // --------------------------------------------------------
    // 普通 Cookie 格式
    //
    // name=value; name2=value2
    // --------------------------------------------------------

    return cookieText
        .split(';')
        .map(part => part.trim())
        .filter(Boolean)
        .map(part => {

            const equalIndex =
                part.indexOf('=');

            if (equalIndex <= 0) {
                return null;
            }

            const name =
                part
                    .slice(0, equalIndex)
                    .trim();

            const value =
                part
                    .slice(equalIndex + 1)
                    .trim();

            if (!name || !value) {
                return null;
            }

            return {
                name,
                value,
                url:
                    'https://secure.xserver.ne.jp/'
            };
        })
        .filter(Boolean);
}

// ============================================================
// Cookie 登录
// ============================================================

async function tryCookieLogin(
    page,
    context
) {

    if (
        !COOKIE_VALUE ||
        !COOKIE_VALUE.trim()
    ) {
        console.log(
            'ℹ️ 未设置 COOKIE_VALUE'
        );

        return false;
    }

    const cookies =
        parseCookieString(
            COOKIE_VALUE
        );

    if (!cookies.length) {

        console.warn(
            '⚠️ COOKIE_VALUE 存在，但没有解析出有效 Cookie'
        );

        return false;
    }

    console.log(
        `🔐 [Cookie] 准备注入 ${cookies.length} 个 Cookie...`
    );

    try {

        // ----------------------------------------------------
        // 清理当前浏览器 Cookie
        // ----------------------------------------------------

        await context.clearCookies();

        // ----------------------------------------------------
        // 注入 Cookie
        // ----------------------------------------------------

        await context.addCookies(
            cookies
        );

        console.log(
            '✅ [Cookie] Cookie 已注入'
        );

        // ----------------------------------------------------
        // 直接访问控制面板
        //
        // 不访问登录页面判断 Cookie
        // ----------------------------------------------------

        console.log(
            '🌐 [Cookie] 正在验证登录状态...'
        );

        await page.goto(
            'https://secure.xserver.ne.jp/xapanel/',
            {
                waitUntil:
                    'domcontentloaded',
                timeout: 30000
            }
        );

        await page.waitForTimeout(
            3000
        );

        const currentUrl =
            page.url();

        console.log(
            `📍 [Cookie] 当前页面: ${currentUrl}`
        );

        // ----------------------------------------------------
        // 如果被重定向到登录页面
        // ----------------------------------------------------

        if (
            currentUrl.includes(
                '/xapanel/login/'
            ) ||
            currentUrl.includes(
                '/login/'
            )
        ) {

            console.warn(
                '⚠️ [Cookie] 服务器将请求重定向到登录页'
            );

            return false;
        }

        // ----------------------------------------------------
        // 获取页面文本
        // ----------------------------------------------------

        const bodyText =
            await page
                .locator('body')
                .innerText()
                .catch(() => '');

        // ----------------------------------------------------
        // 直接检查「ゲーム管理」
        // ----------------------------------------------------

        const gameManagementCount =
            await page
                .getByRole(
                    'link',
                    {
                        name: 'ゲーム管理'
                    }
                )
                .count()
                .catch(() => 0);

        if (
            gameManagementCount > 0
        ) {

            console.log(
                '✅ [Cookie] Cookie 登录成功'
            );

            console.log(
                '✅ [Cookie] 已检测到「ゲーム管理」'
            );

            return true;
        }

        // ----------------------------------------------------
        // 检查其他登录成功特征
        // ----------------------------------------------------

        const loggedInIndicators = [
            'ゲーム管理',
            'アップグレード',
            '期限延長',
            'ログアウト',
            'マイページ',
            'XServer GAMEs'
        ];

        const hasLoggedInIndicator =
            loggedInIndicators.some(
                text =>
                    bodyText.includes(text)
            );

        if (
            hasLoggedInIndicator
        ) {

            console.log(
                '✅ [Cookie] 检测到登录后页面特征'
            );

            return true;
        }

        // ----------------------------------------------------
        // Cookie 登录无法确认
        // ----------------------------------------------------

        console.warn(
            '⚠️ [Cookie] 未能确认登录状态'
        );

        await page
            .screenshot({
                path:
                    'cookie_login_debug.png',
                fullPage: true
            })
            .catch(() => {});

        return false;

    } catch (error) {

        console.warn(
            `⚠️ [Cookie] 登录验证失败: ${error.message}`
        );

        await page
            .screenshot({
                path:
                    'cookie_login_error.png',
                fullPage: true
            })
            .catch(() => {});

        return false;
    }
}

// ============================================================
// 加载登录页面
// ============================================================

async function loadLoginPage(page) {

    for (
        let attempt = 0;
        attempt < 3;
        attempt++
    ) {

        try {

            console.log(
                `⏳ 正在加载登录页面... (尝试 ${attempt + 1}/3)`
            );

            await page.goto(
                'https://secure.xserver.ne.jp/xapanel/login/xmgame',
                {
                    waitUntil:
                        'domcontentloaded',
                    timeout: 25000
                }
            );

            return true;

        } catch (error) {

            console.warn(
                `⚠️ 第 ${attempt + 1} 次加载失败: ${error.message}`
            );

            if (attempt < 2) {
                await page.waitForTimeout(
                    3000
                );
            }
        }
    }

    throw new Error(
        '无法加载 Xserver 登录页面，已尝试 3 次'
    );
}

// ============================================================
// 等待账号登录结果
// ============================================================

async function waitForLoginSuccess(
    page,
    timeout = 60000
) {

    console.log(
        '⏳ 等待登录成功...'
    );

    const startTime =
        Date.now();

    while (
        Date.now() - startTime <
        timeout
    ) {

        try {

            const currentUrl =
                page.url();

            // -----------------------------------------------
            // 已经离开登录页面
            // -----------------------------------------------

            if (
                currentUrl.includes(
                    'xapanel'
                ) &&
                !currentUrl.includes(
                    '/login/'
                )
            ) {

                console.log(
                    '✅ 成功导航到控制面板'
                );

                return true;
            }

            const bodyText =
                await page
                    .locator('body')
                    .innerText()
                    .catch(() => '');

            // -----------------------------------------------
            // Cloudflare Turnstile 还没有完成
            //
            // 不进行自动模拟点击。
            // -----------------------------------------------

            if (
                bodyText.includes(
                    '私はロボットではありません'
                )
            ) {

                console.log(
                    '⏳ Turnstile 尚未完成，继续等待正常验证...'
                );

            }

            // -----------------------------------------------
            // 登录错误
            // -----------------------------------------------

            if (
                bodyText.includes(
                    'エラーが発生'
                ) ||
                bodyText.includes(
                    'ログイン失敗'
                )
            ) {

                console.warn(
                    '⚠️ 检测到登录错误提示'
                );

                return false;
            }

            // -----------------------------------------------
            // 检查登录后页面
            // -----------------------------------------------

            const gameManagement =
                await page
                    .getByRole(
                        'link',
                        {
                            name: 'ゲーム管理'
                        }
                    )
                    .count()
                    .catch(() => 0);

            if (
                gameManagement > 0
            ) {

                console.log(
                    '✅ 检测到「ゲーム管理」，登录成功'
                );

                return true;
            }

            await page.waitForTimeout(
                1000
            );

        } catch (e) {

            await page.waitForTimeout(
                1000
            );
        }
    }

    console.error(
        '❌ 登录等待超时'
    );

    return false;
}

// ============================================================
// 主程序
// ============================================================

(async () => {

    // ========================================================
    // 解析 ACCOUNTS
    // ========================================================

    let users = [];

    try {

        if (
            process.env.ACCOUNTS
        ) {

            users =
                JSON.parse(
                    process.env.ACCOUNTS
                );

            if (
                !Array.isArray(users)
            ) {

                console.error(
                    'ACCOUNTS 必须是对象数组。'
                );

                process.exit(1);
            }

        } else {

            console.log(
                '未找到 ACCOUNTS 环境变量，使用默认配置。'
            );

            users =
                JSON.parse(
                    ACCOUNTS
                );
        }

    } catch (err) {

        console.error(
            '解析 ACCOUNTS 出错:',
            err
        );

        process.exit(1);
    }

    // ========================================================
    // 浏览器启动配置
    // ========================================================

    const launchOptions = {

        headless: true,

        channel: 'chrome',

        args: [
            '--disable-dev-shm-usage'
        ]
    };

    // ========================================================
    // 浏览器代理
    // ========================================================

    if (
        IS_PROXY &&
        PROXY_SERVER
    ) {

        launchOptions.proxy = {
            server: PROXY_SERVER
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
    // 启动浏览器
    // ========================================================

    const browser =
        await chromium.launch(
            launchOptions
        );

    try {

        // ====================================================
        // 获取出口 IP
        // ====================================================

        try {

            const ipRes =
                await fetch(
                    'https://api.ip.sb/ip'
                );

            if (
                ipRes.ok
            ) {

                const ip =
                    (
                        await ipRes.text()
                    ).trim();

                console.log(
                    `📍 当前出口IP: ${ip}${
                        IS_PROXY
                            ? ' (代理)'
                            : ' (直连)'
                    }`
                );
            }

        } catch (e) {

            console.warn(
                `⚠️ 获取出站 IP 出错: ${e.message}`
            );
        }

        // ====================================================
        // 处理账户
        // ====================================================

        for (
            const user of users
        ) {

            console.log(
                `\n👤 正在处理用户: ${user.username}`
            );

            console.log(
                '═'.repeat(60)
            );

            const context =
                await browser.newContext({

                    userAgent:
                        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',

                    locale: 'ja-JP',

                    timezoneId:
                        'Asia/Tokyo',

                    viewport: {
                        width: 1920,
                        height: 1080
                    }
                });

            const page =
                await context.newPage();

            try {

                let loginSuccess =
                    false;

                // =================================================
                // 第一优先级：COOKIE_VALUE
                // =================================================

                if (
                    COOKIE_VALUE &&
                    COOKIE_VALUE.trim()
                ) {

                    loginSuccess =
                        await tryCookieLogin(
                            page,
                            context
                        );
                }

                // =================================================
                // 第二优先级：ACCOUNTS
                // =================================================

                if (
                    !loginSuccess
                ) {

                    console.log(
                        '⏳ COOKIE_VALUE 未生效，切换到 ACCOUNTS 登录...'
                    );

                    // ---------------------------------------------
                    // 加载登录页面
                    // ---------------------------------------------

                    await loadLoginPage(
                        page
                    );

                    // ---------------------------------------------
                    // 等待页面正常加载
                    //
                    // 不模拟 Turnstile 点击。
                    // Cloudflare 如果需要验证，
                    // 让浏览器正常处理。
                    // ---------------------------------------------

                    await page.waitForTimeout(
                        3000
                    );

                    console.log(
                        '⏳ 正在检查登录页面...'
                    );

                    // ---------------------------------------------
                    // 邮箱
                    // ---------------------------------------------

                    const emailInput =
                        page
                            .getByRole(
                                'textbox',
                                {
                                    name:
                                        /XServer|メール/i
                                }
                            )
                            .first();

                    await emailInput.waitFor({
                        state: 'visible',
                        timeout: 15000
                    });

                    console.log(
                        '⏳ 正在输入登录凭证...'
                    );

                    await emailInput.click();

                    await emailInput.fill(
                        user.username
                    );

                    // ---------------------------------------------
                    // 密码
                    // ---------------------------------------------

                    const passwordInput =
                        page
                            .locator(
                                '#user_password, input[type="password"]'
                            )
                            .first();

                    await passwordInput.waitFor({
                        state: 'visible',
                        timeout: 10000
                    });

                    await passwordInput.fill(
                        user.password
                    );

                    // ---------------------------------------------
                    // 提交
                    // ---------------------------------------------

                    console.log(
                        '⏳ 正在提交登录表单...'
                    );

                    await page
                        .locator(
                            '#login-submit, button[type="submit"], button:has-text("ログイン")'
                        )
                        .first()
                        .click();

                    // ---------------------------------------------
                    // 等待登录
                    // ---------------------------------------------

                    loginSuccess =
                        await waitForLoginSuccess(
                            page,
                            60000
                        );
                }

                // =================================================
                // 登录失败
                // =================================================

                if (
                    !loginSuccess
                ) {

                    throw new Error(
                        '登录失败或超时，未能进入控制面板'
                    );
                }

                // =================================================
                // 登录成功
                // =================================================

                console.log(
                    '✅ 登录成功'
                );

                console.log(
                    '⏳ 等待页面完全加载...'
                );

                await page
                    .waitForLoadState(
                        'domcontentloaded',
                        {
                            timeout: 15000
                        }
                    )
                    .catch(() => {});

                await page.waitForTimeout(
                    2000
                );

                // =================================================
                // 游戏管理
                // =================================================

                console.log(
                    '⏳ 正在查找并点击 ゲーム管理 链接...'
                );

                let gameManagementFound =
                    false;

                for (
                    let attempt = 0;
                    attempt < 3;
                    attempt++
                ) {

                    try {

                        const gameLink =
                            page
                                .getByRole(
                                    'link',
                                    {
                                        name:
                                            'ゲーム管理'
                                    }
                                )
                                .first();

                        await gameLink.waitFor({
                            state: 'visible',
                            timeout: 15000
                        });

                        await gameLink.click();

                        gameManagementFound =
                            true;

                        break;

                    } catch (e) {

                        console.warn(
                            `⚠️ 第 ${
                                attempt + 1
                            } 次尝试失败: ${e.message}`
                        );

                        const debugPath =
                            `debug_game_link_${user.username}_attempt${
                                attempt + 1
                            }.png`;

                        await page
                            .screenshot({
                                path:
                                    debugPath,
                                fullPage: true
                            })
                            .catch(() => {});

                        if (
                            attempt < 2
                        ) {

                            await page.waitForTimeout(
                                2000
                            );
                        }
                    }
                }

                if (
                    !gameManagementFound
                ) {

                    throw new Error(
                        '无法找到 ゲーム管理 链接，已尝试3次'
                    );
                }

                await page
                    .waitForLoadState(
                        'domcontentloaded',
                        {
                            timeout: 15000
                        }
                    )
                    .catch(() => {});

                // =================================================
                // 升级 / 期限延长
                // =================================================

                console.log(
                    '⏳ 正在查找 アップグレード・期限延長 链接...'
                );

                await page
                    .getByRole(
                        'link',
                        {
                            name:
                                'アップグレード・期限延長'
                        }
                    )
                    .first()
                    .click();

                // =================================================
                // 期限延长
                // =================================================

                try {

                    console.log(
                        '⏳ 正在查找 期限を延長する 按钮...'
                    );

                    const extendLink =
                        page
                            .getByRole(
                                'link',
                                {
                                    name:
                                        '期限を延長する'
                                }
                            )
                            .first();

                    await extendLink.waitFor({
                        state: 'visible',
                        timeout: 10000
                    });

                    await extendLink.click();

                } catch (e) {

                    const bodyText =
                        await page
                            .locator('body')
                            .innerText()
                            .catch(() => '');

                    const match =
                        bodyText.match(
                            /更新をご希望の場合は、(.+?)以降にお試しください。/
                        );

                    let msg;

                    if (
                        match &&
                        match[1]
                    ) {

                        msg =
                            `🇯🇵 Xserver 续期通知\n\n` +
                            `⚠️ 未到续期时间\n` +
                            `👤 账户 ${user.username}\n` +
                            `📅 可续期：${match[1]}\n` +
                            `🕐 运行时间：${getShanghaiTime()}`;

                    } else {

                        msg =
                            `🇯🇵 Xserver 续期通知\n\n` +
                            `⚠️ ${user.username}\n` +
                            `❌ 未找到续期按钮\n` +
                            `🕐 运行时间：${getShanghaiTime()}`;
                    }

                    console.log(msg);

                    const screenshotPath =
                        `skip_${user.username}.png`;

                    await page
                        .screenshot({
                            path:
                                screenshotPath,
                            fullPage: true
                        })
                        .catch(() => {});

                    await sendTelegramNotification(
                        msg,
                        screenshotPath
                    );

                    continue;
                }

                // =================================================
                // 确认页面
                // =================================================

                console.log(
                    '⏳ 正在点击确认按钮...'
                );

                await page
                    .getByRole(
                        'button',
                        {
                            name:
                                '確認画面に進む'
                        }
                    )
                    .first()
                    .click();

                // =================================================
                // 执行续期
                // =================================================

                console.log(
                    `🖱️ 正在执行续期操作 (${user.username})...`
                );

                await page
                    .getByRole(
                        'button',
                        {
                            name:
                                '期限を延長する'
                        }
                    )
                    .first()
                    .click();

                // =================================================
                // 返回
                // =================================================

                await page
                    .getByRole(
                        'link',
                        {
                            name:
                                '戻る'
                        }
                    )
                    .first()
                    .click();

                // =================================================
                // 成功通知
                // =================================================

                const successMsg =
                    `🇯🇵 Xserver 续期通知\n\n` +
                    `✅ 续期成功\n` +
                    `👤 账户 ${user.username}\n` +
                    `🕐 运行时间：${getShanghaiTime()}`;

                console.log(
                    successMsg
                );

                console.log(
                    '═'.repeat(60)
                );

                const successPath =
                    `success_${user.username}.png`;

                await page
                    .screenshot({
                        path:
                            successPath,
                        fullPage: true
                    })
                    .catch(() => {});

                await sendTelegramNotification(
                    successMsg,
                    successPath
                );

            } catch (error) {

                // =================================================
                // 错误通知
                // =================================================

                const errorMsg =
                    `❌ Xserver 续期通知\n\n` +
                    `❌ 续期失败\n` +
                    `👤 账户 ${user.username}\n` +
                    `❌ 错误：${error.message || error}\n` +
                    `🕐 运行时间：${getShanghaiTime()}`;

                console.error(
                    errorMsg
                );

                console.log(
                    '═'.repeat(60)
                );

                const errorPath =
                    `error_${user.username}.png`;

                await page
                    .screenshot({
                        path:
                            errorPath,
                        fullPage: true
                    })
                    .catch(() => {});

                await sendTelegramNotification(
                    errorMsg,
                    errorPath
                );

            } finally {

                await context.close();
            }
        }

    } finally {

        await browser.close();
    }

})();
