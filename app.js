const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const ACCOUNTS = process.env.ACCOUNTS || `
[
    {
        "username": "", 
        "password": ""  
    }
]`; // 双引号内填写你的邮箱和密码,可以是多账户但不建议,会封号

// Telegram API 配置
const TG_CHAT_ID = process.env.TG_CHAT_ID || '';
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || '';

// 代理配置（socks5 代理，Playwright 和 fetch 共用）
const IS_PROXY = process.env.IS_PROXY === 'true';
const PROXY_SERVER = process.env.PROXY_SERVER || 'socks5://127.0.0.1:1080';

// 如果启用了代理，为全局 fetch 设置代理
if (IS_PROXY && PROXY_SERVER) {
    try {
        const { ProxyAgent, setGlobalDispatcher } = require('undici');
        setGlobalDispatcher(new ProxyAgent(PROXY_SERVER));
    } catch (e) {
        console.warn(`⚠️ 无法加载 undici 代理模块，fetch 将直连: ${e.message}`);
    }
}

// 获取当前上海时间
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

// 发送tg通知
async function sendTelegramNotification(message, imagePath = null) {
    if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
        console.log('未设置 Telegram Bot Token 或 Chat ID，跳过通知。');
        return;
    }

    try {
        if (imagePath) {
            const formData = new FormData();
            formData.append('chat_id', TG_CHAT_ID);
            formData.append('caption', message);

            const fileBuffer = fs.readFileSync(imagePath);
            const blob = new Blob([fileBuffer]);
            formData.append('photo', blob, path.basename(imagePath));

            const response = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendPhoto`, {
                method: 'POST',
                body: formData
            });

            if (!response.ok) {
                console.error('Telegram 图片发送失败:', await response.text());
            } else {
                console.log('Telegram 通知(含图片)已发送');
            }
        } else {
            const response = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: TG_CHAT_ID,
                    text: message
                })
            });

            if (!response.ok) {
                console.error('Telegram 消息发送失败:', await response.text());
            } else {
                console.log('✅ Telegram 文字通知已发送');
            }
        }
    } catch (error) {
        console.error('发送 Telegram 通知时出错:', error);
    }
}

async function isTurnstileSolved(page) {
    return await page.evaluate(() => {
        const responseField = document.querySelector('input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"]');
        if (responseField && responseField.value && responseField.value.length > 0) {
            return true;
        }

        if (window.turnstile && typeof window.turnstile.getResponse === 'function') {
            const response = window.turnstile.getResponse();
            if (response && response.length > 0) {
                return true;
            }
        }

        const widget = document.querySelector('[data-sitekey]');
        return widget && widget.getAttribute('data-state') === 'solved';
    }).catch(() => false);
}

/**
 * 🔐 更稳妥地处理 Cloudflare Turnstile
 * 重点：支持 iframe内点击、重复检测、在提交前再次验证
 */
async function ensureTurnstileReady(page, { timeoutMs = 60000, allowContinueOnTimeout = true } = {}) {
    console.log('🔐 [Turnstile] 初始化校验...');

    const challengeSelector = 'iframe[src*="challenges.cloudflare.com"], [data-sitekey], .cf-turnstile, [class*="turnstile"]';
    const challengeFound = await page.locator(challengeSelector).first().count().then(v => v > 0).catch(() => false);
    if (!challengeFound) {
        console.log('ℹ️ [Turnstile] 当前页面没有检测到 Cloudflare challenge');
        return true;
    }

    console.log('✅ [Turnstile] 检测到 Cloudflare challenge 容器');

    const clickAttempts = [
        async () => {
            const iframe = page.locator('iframe[src*="challenges.cloudflare.com"]').first();
            if (await iframe.count()) {
                await iframe.click({ force: true, timeout: 5000 });
                console.log('✅ [Turnstile] 已点击 iframe challenge 容器');
                return true;
            }
            return false;
        },
        async () => {
            const widget = page.locator('[data-sitekey]').first();
            if (await widget.count()) {
                await widget.click({ force: true, timeout: 5000 });
                console.log('✅ [Turnstile] 已点击 [data-sitekey] 控件');
                return true;
            }
            return false;
        },
        async () => {
            const widget = page.locator('.cf-turnstile, [class*="turnstile"]').first();
            if (await widget.count()) {
                await widget.click({ force: true, timeout: 5000 });
                console.log('✅ [Turnstile] 已点击 .cf-turnstile 控件');
                return true;
            }
            return false;
        },
        async () => {
            await page.evaluate(() => {
                const selectors = ['[data-sitekey]', '.cf-turnstile', '[class*="turnstile"]', 'input[type="checkbox"]', '[role="checkbox"]', '.cf-checkbox'];
                for (const selector of selectors) {
                    const element = document.querySelector(selector);
                    if (!element) continue;
                    const events = ['mousedown', 'mouseup', 'click'];
                    for (const eventName of events) {
                        element.dispatchEvent(new MouseEvent(eventName, {
                            bubbles: true,
                            cancelable: true,
                            view: window
                        }));
                    }
                    return true;
                }
                return false;
            });
            console.log('✅ [Turnstile] 已通过 JS 事件触发点击');
            return true;
        }
    ];

    for (const clickAttempt of clickAttempts) {
        try {
            const result = await clickAttempt();
            if (result) break;
        } catch (e) {
            // continue
        }
    }

    console.log('⏳ [Turnstile] 等待 Cloudflare 处理验证...');
    await page.waitForTimeout(4000);

    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (await isTurnstileSolved(page)) {
            console.log('✅ [Turnstile] 验证已完成，token 已生成');
            await page.waitForTimeout(1500);
            return true;
        }

        const rawBody = await page.locator('body').innerText().catch(() => '');
        if (rawBody.includes('私はロボットではありません') || rawBody.includes('robot')) {
            console.warn('⚠️ 页面提示 Turnstile 尚未通过验证');
            if (!allowContinueOnTimeout) return false;
            break;
        }

        await page.waitForTimeout(1000);
    }

    if (allowContinueOnTimeout) {
        console.log('⚠️ [Turnstile] token 未在规定时间内生成，但尝试继续提交');
        console.log('ℹ️ [Turnstile] 可能是 Cloudflare 会在登录时动态验证');
        return true;
    }

    return false;
}

/**
 * 🔄 等待登录成功的关键函数
 */
async function waitForLoginSuccess(page, timeout = 60000) {
    console.log('⏳ 等待登录成功...');
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
        try {
            const currentUrl = page.url();
            
            if (currentUrl.includes('xapanel') && !currentUrl.includes('login')) {
                console.log('✅ 成功导航到控制面板');
                return true;
            }

            const bodyText = await page.locator('body').innerText().catch(() => '');
            
            if (bodyText.includes('私はロボットではありません')) {
                console.warn('⚠️ 页面显示 Turnstile 仍未通过');
                return false;
            }

            if (bodyText.includes('エラーが発生') || bodyText.includes('ログイン失敗')) {
                console.warn('⚠️ 检测到登录错误提示');
                return false;
            }

            await page.waitForTimeout(500);
        } catch (e) {
            await page.waitForTimeout(500);
        }
    }

    console.error('❌ 登录等待超时');
    return false;
}

// 续期流程
(async () => {
    let users = [];
    try {
        if (process.env.ACCOUNTS) {
            users = JSON.parse(process.env.ACCOUNTS);
            if (!Array.isArray(users)) {
                console.error('ACCOUNTS 必须是对象数组。');
                process.exit(1);
            }
        } else {
            console.log('未找到 ACCOUNTS 环境变量，使用默认配置。');
            users = JSON.parse(ACCOUNTS);
        }
    } catch (err) {
        console.error('解析 ACCOUNTS 出错:', err);
        process.exit(1);
    }

    const launchOptions = {
        headless: true,
        channel: 'chrome',
        args: [
            '--disable-blink-features=AutomationControlled',
            '--disable-dev-shm-usage',
            '--enable-automation=false',
            '--disable-web-resources',
            '--disable-features=IsolateOrigins,site-per-process'
        ]
    };

    if (IS_PROXY && PROXY_SERVER) {
        launchOptions.proxy = { server: PROXY_SERVER };
        console.log(`✅ 浏览器代理已启用: ${PROXY_SERVER}`);
    } else {
        console.log('ℹ️ 浏览器直连模式');
    }

    const browser = await chromium.launch(launchOptions);

    try {
        const ipRes = await fetch('https://api.ip.sb/ip');
        if (ipRes.ok) {
            const ip = (await ipRes.text()).trim();
            console.log(`📍 当前出口IP: ${ip}${IS_PROXY ? ' (代理)' : ' (直连)'}`);
        } else {
            console.warn(`⚠️ 获取出站 IP 失败: HTTP ${ipRes.status}`);
        }
    } catch (e) {
        console.warn(`⚠️ 获取出站 IP 出错: ${e.message}`);
    }

    for (const user of users) {
        console.log(`\n👤 正在处理用户: ${user.username}`);
        console.log('═'.repeat(60));

        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            locale: 'ja-JP',
            timezoneId: 'Asia/Tokyo',
            viewport: { width: 1440, height: 1200 }
        });
        const page = await context.newPage();

        try {
            console.log('⏳ 正在加载登录页面...');
            await page.goto('https://secure.xserver.ne.jp/xapanel/login/xmgame', {
                waitUntil: 'domcontentloaded',
                timeout: 30000
            });

            await ensureTurnstileReady(page);

            console.log('⏳ 正在输入登录凭证...');
            const emailInput = page.getByRole('textbox', { name: 'XServerアカウントID または メールアドレス' });
            await emailInput.click();
            await emailInput.fill(user.username);

            const passwordInput = page.locator('#user_password');
            await passwordInput.fill(user.password);

            await ensureTurnstileReady(page, { timeoutMs: 20000, allowContinueOnTimeout: true });

            console.log('⏳ 正在提交登录表单...');
            await page.locator('#login-submit').click();

            const loginSuccess = await waitForLoginSuccess(page, 60000);
            if (!loginSuccess) {
                const pageText = await page.locator('body').innerText().catch(() => '');
                if (pageText.includes('私はロボットではありません') || pageText.includes('cf-turnstile')) {
                    await ensureTurnstileReady(page, { timeoutMs: 30000, allowContinueOnTimeout: true });
                    await page.locator('#login-submit').click();
                    const secondAttempt = await waitForLoginSuccess(page, 30000);
                    if (!secondAttempt) {
                        throw new Error('登录失败或超时，未能进入控制面板');
                    }
                } else {
                    throw new Error('登录失败或超时，未能进入控制面板');
                }
            }

            console.log('⏳ 等待页面完全加载...');
            await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
            await page.waitForTimeout(2000);

            console.log('⏳ 正在查找并点击 ゲーム管理 链接...');
            let gameManagementFound = false;
            for (let attempt = 0; attempt < 3; attempt++) {
                try {
                    const gameLink = page.getByRole('link', { name: 'ゲーム管理' });
                    await gameLink.waitFor({ state: 'visible', timeout: 15000 });
                    console.log(`✅ 第 ${attempt + 1} 次尝试：找到 ゲーム管理 链接`);
                    await gameLink.click();
                    gameManagementFound = true;
                    break;
                } catch (e) {
                    console.warn(`⚠️ 第 ${attempt + 1} 次尝试失败: ${e.message}`);
                    const debugPath = `debug_game_link_${user.username}_attempt${attempt + 1}.png`;
                    await page.screenshot({ path: debugPath });
                    console.log(`💾 已保存调试截图: ${debugPath}`);
                    if (attempt < 2) {
                        await page.waitForTimeout(2000);
                    }
                }
            }

            if (!gameManagementFound) {
                throw new Error('无法找到 ゲーム管理 链接，已尝试3次');
            }

            await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});

            console.log('⏳ 正在查找 アップグレード・期限延長 链接...');
            await page.getByRole('link', { name: 'アップグレード・期限延長' }).click();

            try {
                console.log('⏳ 正在查找 期限を延長する 按钮...');
                await page.getByRole('link', { name: '期限を延長する' }).waitFor({ state: 'visible', timeout: 10000 });
                await page.getByRole('link', { name: '期限を延長する' }).click();
            } catch (e) {
                const bodyText = await page.locator('body').innerText();
                const match = bodyText.match(/更新をご希望の場合は、(.+?)以降にお試しください。/);

                let msg;
                if (match && match[1]) {
                    msg = `🇯🇵 Xserver 续期通知\n\n⚠️ 未到续期时间\n👤 账户 ${user.username}\n📅 可续期：${match[1]}\n🕐 运行时间：${getShanghaiTime()}`;
                } else {
                    msg = `🇯🇵 Xserver 续期通知\n\n⚠️ ${user.username}\n❌ 未找到续期按钮\n🕐 运行时间：${getShanghaiTime()}`;
                }

                console.log(msg);
                const screenshotPath = `skip_${user.username}.png`;
                await page.screenshot({ path: screenshotPath });
                await sendTelegramNotification(msg, screenshotPath);
                continue;
            }

            console.log('⏳ 正在点击确认按钮...');
            await page.getByRole('button', { name: '確認画面に進む' }).click();

            console.log(`🖱️ 正在执行续期操作 (${user.username})...`);
            await page.getByRole('button', { name: '期限を延長する' }).click();
            await page.getByRole('link', { name: '戻る' }).click();

            const successMsg = `🇯🇵 Xserver 续期通知\n\n✅ 续期成功\n👤 账户 ${user.username}\n🕐 运行时间：${getShanghaiTime()}`;
            console.log(successMsg);
            console.log('═'.repeat(60));

            const successPath = `success_${user.username}.png`;
            await page.screenshot({ path: successPath });
            await sendTelegramNotification(successMsg, successPath);

        } catch (error) {
            const errorMsg = `❌ Xserver 续期通知\n\n❌ 续期失败\n👤 账户 ${user.username}\n❌ 错误：${error.message || error}\n🕐 运行时间：${getShanghaiTime()}`;
            console.error(errorMsg);
            console.log('═'.repeat(60));

            const errorPath = `error_${user.username}.png`;
            await page.screenshot({ path: errorPath });
            await sendTelegramNotification(errorMsg, errorPath);

        } finally {
            await context.close();
        }
    }

    await browser.close();
})();
