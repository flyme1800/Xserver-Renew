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

async function tryClickTurnstile(page) {
    console.log('🔐 [Turnstile] 尝试真实点击 Cloudflare 验证控件...');

    const selectors = [
        '[data-sitekey]',
        '.cf-turnstile',
        '[class*="turnstile"]',
        'input[type="checkbox"]',
        '[role="checkbox"]',
        '.cf-checkbox'
    ];

    for (const selector of selectors) {
        try {
            const locator = page.locator(selector).first();
            await locator.waitFor({ state: 'visible', timeout: 5000 });
            await locator.click({ force: true, timeout: 5000 });
            console.log(`✅ [Turnstile] 已点击页面元素: ${selector}`);
            return true;
        } catch (e) {
            // continue
        }
    }

    // fallback: DOM-level click via JS, useful for hidden or shadow-dominated widgets
    try {
        const clicked = await page.evaluate(() => {
            const selectors = [
                '.cf-turnstile',
                '[data-sitekey]',
                '[class*="turnstile"]',
                'input[type="checkbox"]',
                '[role="checkbox"]',
                '.cf-checkbox'
            ];

            const doClick = (node) => {
                if (!node) return false;
                const events = ['mousedown', 'mouseup', 'click'];
                for (const eventName of events) {
                    node.dispatchEvent(new MouseEvent(eventName, {
                        bubbles: true,
                        cancelable: true,
                        view: window
                    }));
                }
                return true;
            };

            for (const selector of selectors) {
                const element = document.querySelector(selector);
                if (element) {
                    return doClick(element);
                }
            }

            return false;
        });

        if (clicked) {
            console.log('✅ [Turnstile] 已通过页面 DOM 事件触发点击');
            return true;
        }
    } catch (e) {
        console.warn(`⚠️ [Turnstile] JS click fallback 失败: ${e.message}`);
    }

    // fallback: click iframe container itself
    try {
        const frame = page.frames().find(f => /challenges\.cloudflare\.com|turnstile/i.test(f.url()));
        if (frame) {
            const candidates = ['input[type="checkbox"]', '.cf-turnstile', '[role="checkbox"]', 'label'];
            for (const selector of candidates) {
                try {
                    await frame.locator(selector).first().click({ force: true, timeout: 5000 });
                    console.log(`✅ [Turnstile] 已点击 iframe 内元素: ${selector}`);
                    return true;
                } catch (e) {
                    // continue
                }
            }
        }
    } catch (e) {
        console.warn(`⚠️ [Turnstile] iframe fallback 失败: ${e.message}`);
    }

    console.warn('⚠️ [Turnstile] 没有成功点击验证控件');
    return false;
}

async function waitForTurnstileToken(page, timeoutMs = 30000) {
    console.log('⏳ [Turnstile] 等待真实 token 生成...');
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
        try {
            const result = await page.evaluate(() => {
                const hidden = document.querySelector('input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"]');
                return hidden ? hidden.value : '';
            });

            if (result && result.length > 0) {
                console.log('✅ [Turnstile] 已生成真实 response token');
                return true;
            }

            await page.waitForTimeout(500);
        } catch (e) {
            await page.waitForTimeout(500);
        }
    }

    console.warn('⚠️ [Turnstile] 在规定时间内未生成真实 token');
    return false;
}

/**
 * 🔐 处理 Turnstile，确保页面真正完成验证后再提交表单
 */
async function ensureTurnstileReady(page) {
    console.log('🔐 [Turnstile] 初始化校验...');

    const challengeFound = await page.$('iframe[src*="challenges.cloudflare.com"], [data-sitekey], .cf-turnstile, [class*="turnstile"]').catch(() => null);
    if (!challengeFound) {
        console.log('ℹ️ [Turnstile] 当前页面没有检测到 Cloudflare challenge');
        return true;
    }

    await tryClickTurnstile(page);

    const tokenReady = await waitForTurnstileToken(page, 25000);
    if (!tokenReady) {
        console.warn('⚠️ [Turnstile] token 未生成，说明 Cloudflare 验证未完成');
        return false;
    }

    console.log('✅ [Turnstile] 验证已完成');
    return true;
}

/**
 * 🔄 等待登录成功的关键函数
 * 不依赖 networkidle（容易超时），改为检查实际页面状态
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
            if (bodyText.includes('私はロボットではありません') || bodyText.includes('cf-turnstile') || bodyText.includes('Check the box')) {
                console.warn('⚠️ 页面仍停留在 Turnstile 验证状态');
                return false;
            }

            if (bodyText.includes('エラーが発生') || bodyText.includes('ログイン失敗')) {
                console.warn('⚠️ 检测到登录错误提示');
                return false;
            }

            await page.waitForTimeout(500);
        } catch (e) {
            console.log(`ℹ️ 检查登录状态时出错: ${e.message}`);
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
            '--disable-web-resources'
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
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        });
        const page = await context.newPage();

        try {
            console.log('⏳ 正在加载登录页面...');
            await page.goto('https://secure.xserver.ne.jp/xapanel/login/xmgame', {
                waitUntil: 'domcontentloaded',
                timeout: 30000
            });

            const turnstileOk = await ensureTurnstileReady(page);
            if (!turnstileOk) {
                throw new Error('Cloudflare Turnstile 验证未完成，无法提交登录');
            }

            console.log('⏳ 正在输入登录凭证...');
            const emailInput = page.getByRole('textbox', { name: 'XServerアカウントID または メールアドレス' });
            await emailInput.click();
            await emailInput.fill(user.username);

            const passwordInput = page.locator('#user_password');
            await passwordInput.fill(user.password);

            console.log('⏳ 正在提交登录表单...');
            await page.locator('#login-submit').click();

            const loginSuccess = await waitForLoginSuccess(page, 60000);
            if (!loginSuccess) {
                throw new Error('登录失败或超时，未能进入控制面板');
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
