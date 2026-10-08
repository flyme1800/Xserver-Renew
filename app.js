const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

// ==============================
// XServer 账户配置
// ==============================
const ACCOUNTS = process.env.ACCOUNTS || `
[
    {
        "username": "",
        "password": ""
    }
]`;

// ==============================
// Telegram 配置
// ==============================
const TG_CHAT_ID = process.env.TG_CHAT_ID || '';
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || '';

// ==============================
// 代理配置
// ==============================
const IS_PROXY = process.env.IS_PROXY === 'true';
const PROXY_SERVER =
    process.env.PROXY_SERVER || 'socks5://127.0.0.1:1080';

// ==============================
// 全局超时
// ==============================
const DEFAULT_TIMEOUT = 30000;
const LOGIN_TIMEOUT = 60000;

// ==============================
// Shanghai 时间
// ==============================
function getShanghaiTime() {
    return new Date().toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    });
}

// ==============================
// 清理文件名
// ==============================
function safeFileName(name) {
    return String(name).replace(/[^a-zA-Z0-9._-]/g, '_');
}

// ==============================
// Telegram 通知
// ==============================
async function sendTelegramNotification(message, imagePath = null) {
    if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
        console.log(
            '⚠️ 未设置 Telegram Bot Token 或 Chat ID，跳过通知。'
        );
        return;
    }

    try {
        // ==========================
        // 发送截图
        // ==========================
        if (imagePath && fs.existsSync(imagePath)) {
            const formData = new FormData();

            formData.append('chat_id', TG_CHAT_ID);
            formData.append('caption', message);

            const fileBuffer = fs.readFileSync(imagePath);
            const blob = new Blob([fileBuffer]);

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
                    '❌ Telegram 图片发送失败:',
                    await response.text()
                );
            } else {
                console.log(
                    '✅ Telegram 通知(含图片)已发送'
                );
            }

            return;
        }

        // ==========================
        // 发送文字
        // ==========================
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
            '❌ 发送 Telegram 通知时出错:',
            error.message
        );
    }
}

// ==============================
// 获取页面信息
// ==============================
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
        bodyText = await page.locator('body').innerText({
            timeout: 5000
        });
    } catch (_) {}

    return {
        title,
        url,
        bodyText
    };
}

// ==============================
// 保存截图
// ==============================
async function saveScreenshot(page, prefix, username) {
    const fileName =
        `${prefix}_${safeFileName(username)}_${Date.now()}.png`;

    try {
        await page.screenshot({
            path: fileName,
            fullPage: true
        });

        console.log(`📸 截图已保存: ${fileName}`);

        return fileName;

    } catch (error) {
        console.error(
            `⚠️ 截图失败: ${error.message}`
        );

        return null;
    }
}

// ==============================
// 解析账户
// ==============================
function loadAccounts() {
    let users = [];

    try {
        if (process.env.ACCOUNTS) {

            users = JSON.parse(process.env.ACCOUNTS);

            if (!Array.isArray(users)) {
                throw new Error(
                    'ACCOUNTS 必须是 JSON 对象数组'
                );
            }

        } else {

            console.log(
                '⚠️ 未找到 ACCOUNTS 环境变量，使用默认配置。'
            );

            users = JSON.parse(ACCOUNTS);
        }

    } catch (error) {

        console.error(
            '❌ 解析 ACCOUNTS 出错:',
            error.message
        );

        process.exit(1);
    }

    return users;
}

// ==============================
// 主程序
// ==============================
(async () => {

    console.log('');
    console.log('======================================');
    console.log('🇯🇵 XServer 自动续期程序');
    console.log('======================================');
    console.log(`🕐 上海时间: ${getShanghaiTime()}`);
    console.log('');

    // ==========================
    // 读取账户
    // ==========================
    const users = loadAccounts();

    if (!users.length) {
        console.error('❌ 没有找到任何账户。');
        process.exit(1);
    }

    console.log(
        `👥 共发现 ${users.length} 个账户`
    );

    // ==========================
    // Playwright 启动配置
    // ==========================
    const launchOptions = {
        headless: true,
        channel: 'chrome',

        // 避免部分 CI 环境资源问题
        args: [
            '--disable-dev-shm-usage',
            '--no-sandbox',
            '--disable-setuid-sandbox'
        ]
    };

    // ==========================
    // 浏览器代理
    // ==========================
    if (IS_PROXY && PROXY_SERVER) {

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

    // ==========================
    // 启动浏览器
    // ==========================
    let browser;

    try {

        browser = await chromium.launch(
            launchOptions
        );

        console.log(
            '✅ Chrome 浏览器启动成功'
        );

    } catch (error) {

        console.error(
            '❌ 浏览器启动失败:',
            error
        );

        process.exit(1);
    }

    // ==========================
    // 获取出口 IP
    // ==========================
    try {

        console.log(
            '🌐 正在检测当前出口 IP...'
        );

        const ipRes = await fetch(
            'https://api.ip.sb/ip'
        );

        if (ipRes.ok) {

            const ip =
                (await ipRes.text()).trim();

            console.log(
                `📍 当前出口IP: ${ip}${IS_PROXY ? ' (代理)' : ' (直连)'}`
            );

        } else {

            console.warn(
                `⚠️ 获取出口 IP 失败: HTTP ${ipRes.status}`
            );
        }

    } catch (error) {

        console.warn(
            `⚠️ 获取出口 IP 出错: ${error.message}`
        );
    }

    // ==========================
    // 逐个处理账户
    // ==========================
    for (const user of users) {

        console.log('');
        console.log('======================================');
        console.log(
            `👤 正在处理用户: ${user.username}`
        );
        console.log('======================================');

        let context;
        let page;

        try {

            // ==========================
            // 参数检查
            // ==========================
            if (!user.username || !user.password) {

                throw new Error(
                    '账户 username 或 password 为空'
                );
            }

            // ==========================
            // 创建独立浏览器环境
            // ==========================
            context = await browser.newContext({
                viewport: {
                    width: 1366,
                    height: 768
                },

                locale: 'ja-JP',

                timezoneId:
                    'Asia/Tokyo'
            });

            page = await context.newPage();

            // 默认超时
            page.setDefaultTimeout(
                DEFAULT_TIMEOUT
            );

            page.setDefaultNavigationTimeout(
                LOGIN_TIMEOUT
            );

            // ==========================
            // 监听页面错误
            // ==========================
            page.on('pageerror', error => {
                console.warn(
                    `⚠️ 页面 JS 错误: ${error.message}`
                );
            });

            // ==========================
            // 监听页面崩溃
            // ==========================
            page.on('crash', () => {
                console.error(
                    '❌ 页面发生崩溃'
                );
            });

            // ==================================================
            // 1. 打开 XServer 登录页面
            // ==================================================
            console.log(
                '🌐 访问 XServer 登录页面...'
            );

            await page.goto(
                'https://secure.xserver.ne.jp/xapanel/login/xmgame',
                {
                    waitUntil: 'domcontentloaded',
                    timeout: LOGIN_TIMEOUT
                }
            );

            console.log(
                `🔗 登录页面: ${page.url()}`
            );

            console.log(
                `📄 页面标题: ${await page.title()}`
            );

            // ==================================================
            // 2. 等待用户名输入框
            // ==================================================
            console.log(
                '⏳ 等待登录表单...'
            );

            const usernameInput =
                page.getByRole('textbox', {
                    name:
                        'XServerアカウントID または メールアドレス',
                    exact: true
                });

            await usernameInput.waitFor({
                state: 'visible',
                timeout: 30000
            });

            // ==================================================
            // 3. 填写用户名
            // ==================================================
            console.log(
                '🔑 填写账号...'
            );

            await usernameInput.fill(
                user.username
            );

            // ==================================================
            // 4. 填写密码
            // ==================================================
            await page.locator(
                '#user_password'
            ).waitFor({
                state: 'visible',
                timeout: 30000
            });

            await page.locator(
                '#user_password'
            ).fill(user.password);

            console.log(
                '✅ 账号密码填写完成'
            );

            // ==================================================
            // 5. 查找真正的登录按钮
            //
            // 重要：
            // 不再使用：
            //
            // getByRole('button', { name: 'ログインする' })
            //
            // 因为它会同时匹配 Google 登录按钮。
            //
            // 使用 XServer 明确的 #login-submit
            // ==================================================
            const loginButton =
                page.locator('#login-submit');

            await loginButton.waitFor({
                state: 'visible',
                timeout: 30000
            });

            console.log(
                '🖱️ 点击 XServer 登录按钮...'
            );

            await loginButton.click();

            console.log(
                '✅ 登录按钮已点击'
            );

            // ==================================================
            // 6. 等待 Cloudflare / Turnstile / 登录处理
            // ==================================================
            console.log(
                '⏳ 等待登录验证...'
            );

            await page.waitForTimeout(3000);

            // ==================================================
            // 检查 Turnstile iframe
            // ==================================================
            const turnstileFrame =
                page.locator(
                    'iframe[src*="challenges.cloudflare.com"]'
                );

            if (
                await turnstileFrame.count() > 0
            ) {

                console.log(
                    '🛡️ 检测到 Cloudflare Turnstile'
                );

                console.log(
                    '⏳ 等待验证结果...'
                );

                // 不操作 Turnstile，只等待登录页面状态改变
                await page.waitForTimeout(
                    10000
                );
            }

            // ==================================================
            // 7. 等待登录完成
            // ==================================================
            console.log(
                '⏳ 检查 XServer 登录状态...'
            );

            let loginSuccess = false;

            // 最长等待 60 秒
            for (
                let i = 0;
                i < 30;
                i++
            ) {

                const currentUrl =
                    page.url();

                // 如果出现游戏管理
                const gameLink =
                    page.getByRole('link', {
                        name: 'ゲーム管理',
                        exact: true
                    });

                if (
                    await gameLink.count() > 0
                ) {

                    try {

                        if (
                            await gameLink.isVisible()
                        ) {

                            loginSuccess = true;

                            console.log(
                                '✅ 检测到「ゲーム管理」'
                            );

                            break;
                        }

                    } catch (_) {}
                }

                // 如果已经离开 login 页面
                if (
                    !currentUrl.includes('/login/')
                ) {

                    console.log(
                        `✅ 已离开登录页面: ${currentUrl}`
                    );

                    // 再给页面一点加载时间
                    await page.waitForTimeout(
                        2000
                    );

                    // 再确认游戏管理
                    if (
                        await gameLink.count() > 0
                    ) {

                        try {

                            if (
                                await gameLink.isVisible()
                            ) {

                                loginSuccess = true;
                                break;

                            }

                        } catch (_) {}
                    }
                }

                await page.waitForTimeout(
                    2000
                );
            }

            // ==================================================
            // 8. 登录失败
            // ==================================================
            if (!loginSuccess) {

                const info =
                    await getPageInfo(page);

                console.error(
                    '❌ 登录没有成功'
                );

                console.error(
                    `🔗 URL: ${info.url}`
                );

                console.error(
                    `📄 标题: ${info.title}`
                );

                console.error(
                    '📋 页面内容:'
                );

                console.error(
                    info.bodyText.substring(
                        0,
                        3000
                    )
                );

                const screenshotPath =
                    await saveScreenshot(
                        page,
                        'login_failed',
                        user.username
                    );

                const loginFailMsg =
                    `🇯🇵 XServer 续期通知

❌ 登录失败

👤 账户：
${user.username}

🔗 当前页面：
${info.url}

📄 页面标题：
${info.title}

🛡️ 可能原因：
• Cloudflare Turnstile 未完成
• 登录信息错误
• XServer 登录限制
• 页面加载超时

🕐 运行时间：
${getShanghaiTime()}`;

                await sendTelegramNotification(
                    loginFailMsg,
                    screenshotPath
                );

                continue;
            }

            // ==================================================
            // 9. 点击游戏管理
            // ==================================================
            console.log(
                '🎮 进入「ゲーム管理」...'
            );

            const gameManagement =
                page.getByRole('link', {
                    name: 'ゲーム管理',
                    exact: true
                });

            await gameManagement.waitFor({
                state: 'visible',
                timeout: 30000
            });

            await gameManagement.click();

            await page.waitForLoadState(
                'domcontentloaded',
                {
                    timeout: 30000
                }
            ).catch(() => {});

            console.log(
                `✅ 游戏管理页面: ${page.url()}`
            );

            await page.waitForTimeout(2000);

            // ==================================================
            // 10. 进入「升级・期限延长」
            // ==================================================
            console.log(
                '📅 查找「アップグレード・期限延長」...'
            );

            const upgradeLink =
                page.getByRole('link', {
                    name:
                        'アップグレード・期限延長',
                    exact: true
                });

            await upgradeLink.waitFor({
                state: 'visible',
                timeout: 30000
            });

            await upgradeLink.click();

            await page.waitForLoadState(
                'domcontentloaded',
                {
                    timeout: 30000
                }
            ).catch(() => {});

            console.log(
                `✅ 已进入期限延长页面: ${page.url()}`
            );

            await page.waitForTimeout(2000);

            // ==================================================
            // 11. 检查「期限を延長する」
            // ==================================================
            const extendLink =
                page.getByRole('link', {
                    name: '期限を延長する',
                    exact: true
                });

            let extendAvailable = false;

            try {

                await extendLink.waitFor({
                    state: 'visible',
                    timeout: 10000
                });

                extendAvailable = true;

            } catch (_) {

                extendAvailable = false;
            }

            // ==================================================
            // 12. 尚未到续期时间
            // ==================================================
            if (!extendAvailable) {

                const bodyText =
                    await page.locator('body')
                        .innerText()
                        .catch(() => '');

                console.log(
                    '⚠️ 当前没有找到「期限を延長する」'
                );

                // XServer 原页面提示
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
                        `🇯🇵 XServer 续期通知

⚠️ 尚未到续期时间

👤 账户：
${user.username}

📅 可续期时间：
${match[1]}

🕐 运行时间：
${getShanghaiTime()}`;

                } else {

                    msg =
                        `🇯🇵 XServer 续期通知

⚠️ 未找到「期限を延長する」按钮

👤 账户：
${user.username}

可能原因：
• 尚未到续期时间
• 当前服务不支持续期
• XServer 页面发生变化

🕐 运行时间：
${getShanghaiTime()}`;
                }

                console.log(msg);

                const screenshotPath =
                    await saveScreenshot(
                        page,
                        'skip',
                        user.username
                    );

                await sendTelegramNotification(
                    msg,
                    screenshotPath
                );

                continue;
            }

            // ==================================================
            // 13. 点击「期限を延長する」
            // ==================================================
            console.log(
                '📅 已到续期时间'
            );

            console.log(
                '🖱️ 点击「期限を延長する」...'
            );

            await extendLink.click();

            await page.waitForTimeout(1500);

            // ==================================================
            // 14. 点击确认画面
            // ==================================================
            const confirmButton =
                page.getByRole('button', {
                    name:
                        '確認画面に進む',
                    exact: true
                });

            await confirmButton.waitFor({
                state: 'visible',
                timeout: 30000
            });

            console.log(
                '🖱️ 点击「確認画面に進む」...'
            );

            await confirmButton.click();

            await page.waitForTimeout(1500);

            // ==================================================
            // 15. 最终确认续期
            // ==================================================
            const finalExtendButton =
                page.getByRole('button', {
                    name:
                        '期限を延長する',
                    exact: true
                });

            await finalExtendButton.waitFor({
                state: 'visible',
                timeout: 30000
            });

            console.log(
                `🖱️ 正在执行用户 ${user.username} 的最终续期...`
            );

            await finalExtendButton.click();

            console.log(
                '✅ 已点击最终续期按钮'
            );

            await page.waitForTimeout(3000);

            // ==================================================
            // 16. 检查续期结果
            // ==================================================
            const resultInfo =
                await getPageInfo(page);

            console.log(
                `📄 续期后页面: ${resultInfo.url}`
            );

            // 页面文本中寻找成功提示
            const successKeywords = [
                '延長しました',
                '延長されました',
                '期限を延長しました',
                '更新しました',
                '完了しました'
            ];

            const successDetected =
                successKeywords.some(keyword =>
                    resultInfo.bodyText.includes(
                        keyword
                    )
                );

            // ==================================================
            // 17. 返回
            // ==================================================
            try {

                const backLink =
                    page.getByRole('link', {
                        name: '戻る',
                        exact: true
                    });

                if (
                    await backLink.count() > 0 &&
                    await backLink.isVisible()
                ) {

                    await backLink.click();

                    console.log(
                        '↩️ 已返回'
                    );
                }

            } catch (_) {}

            // ==================================================
            // 18. 成功通知
            // ==================================================
            const successMsg =
                `🇯🇵 XServer 续期通知

${successDetected ? '✅ 续期成功' : '✅ 已执行续期操作'}

👤 账户：
${user.username}

🕐 运行时间：
${getShanghaiTime()}`;

            console.log(successMsg);

            const successPath =
                await saveScreenshot(
                    page,
                    'success',
                    user.username
                );

            await sendTelegramNotification(
                successMsg,
                successPath
            );

        } catch (error) {

            // ==================================================
            // 错误处理
            // ==================================================
            console.error('');
            console.error(
                '======================================'
            );
            console.error(
                '❌ XServer 操作失败'
            );
            console.error(
                '======================================'
            );

            console.error(
                error
            );

            let currentUrl = '';

            try {
                currentUrl = page
                    ? page.url()
                    : '';
            } catch (_) {}

            const errorMsg =
                `❌ XServer 续期通知

❌ 续期失败

👤 账户：
${user.username}

❌ 错误信息：
${error.message || error}

🔗 当前页面：
${currentUrl || '未知'}

🕐 运行时间：
${getShanghaiTime()}`;

            console.error(errorMsg);

            let errorPath = null;

            if (page) {

                errorPath =
                    await saveScreenshot(
                        page,
                        'error',
                        user.username
                    );
            }

            await sendTelegramNotification(
                errorMsg,
                errorPath
            );

        } finally {

            // ==========================
            // 关闭当前账户 context
            // ==========================
            try {

                if (context) {
                    await context.close();
                }

            } catch (_) {}
        }
    }

    // ==============================
    // 关闭浏览器
    // ==============================
    try {

        await browser.close();

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

    } catch (_) {}

})();
