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

/**
 * 注入脚本以隐藏浏览器自动化特征
 */
async function injectStealthScripts(page) {
    await page.addInitScript(() => {
        // 隐藏 webdriver 标志
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
        
        // 隐藏 chrome 属性
        window.chrome = { runtime: {} };
        
        // 伪造 plugins
        Object.defineProperty(navigator, 'plugins', {
            get: () => [1, 2, 3],
        });
        
        // 伪造 languages
        Object.defineProperty(navigator, 'languages', {
            get: () => ['ja-JP', 'ja', 'en'],
        });

        // 防止检测 setTimeout hook
        const originalSetTimeout = window.setTimeout;
        window.setTimeout = function(...args) {
            return originalSetTimeout.apply(this, args);
        };
    });
}

/**
 * 等待 Turnstile 生成 token
 */
async function ensureTurnstileReady(page, { timeoutMs = 60000 } = {}) {
    console.log('🔐 [Turnstile] 初始化验证处理...');

    const hasTurnstile = await page.locator('[data-sitekey], .cf-turnstile, iframe[src*="challenges.cloudflare.com"]').first().count().then(v => v > 0).catch(() => false);
    if (!hasTurnstile) {
        console.log('ℹ️ [Turnstile] 页面不存在 Turnstile 挑战');
        return true;
    }

    console.log('✅ [Turnstile] 检测到 Turnstile 挑战容器');

    // 多轮次点击尝试
    console.log('🖱️ [Turnstile] 执行多轮点击和交互...');
    for (let round = 0; round < 4; round++) {
        try {
            await page.evaluate(() => {
                const container = document.querySelector('[data-sitekey]') || 
                                 document.querySelector('.cf-turnstile') ||
                                 document.querySelector('[class*="turnstile"]');
                if (container) {
                    const events = ['mousedown', 'mouseup', 'click'];
                    for (const eventName of events) {
                        container.dispatchEvent(new MouseEvent(eventName, {
                            bubbles: true, 
                            cancelable: true,
                            view: window
                        }));
                    }
                    return true;
                }
                return false;
            });
            console.log(`✅ 第 ${round + 1} 轮：已触发 Turnstile 点击事件`);
        } catch (e) {
            console.warn(`⚠️ 第 ${round + 1} 轮点击失败`);
        }

        // 等待 Cloudflare 处理
        await page.waitForTimeout(3000 + round * 1500);

        // 检查是否已生成 token
        const tokenGenerated = await page.evaluate(() => {
            const field = document.querySelector('input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"]');
            if (field && field.value && field.value.length > 20) return true;
            
            if (window.turnstile && typeof window.turnstile.getResponse === 'function') {
                const token = window.turnstile.getResponse();
                if (token && token.length > 20) return true;
            }
            return false;
        }).catch(() => false);

        if (tokenGenerated) {
            console.log(`✅ Token 已生成（第 ${round + 1} 轮成功）`);
            await page.waitForTimeout(1500);
            return true;
        }
    }

    console.warn('⚠️ [Turnstile] Token 生成未确认，但继续尝试提交');
    return true;
}

/**
 * 等待登录成功
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
                console.warn('⚠️ 页面显示需要再次验证 Turnstile');
                return false;
            }

            if (bodyText.includes('エラーが発生') || bodyText.includes('ログイン失敗')) {
                console.warn('⚠️ 检测到登录错误提示');
                return false;
            }

            await page.waitForTimeout(1000);
        } catch (e) {
            await page.waitForTimeout(1000);
        }
    }

    console.error('❌ 登录等待超时');
    return false;
}

/**
 * 加载登录页面（带重试）
 */
async function loadLoginPage(page, maxRetries = 2) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const startTime = Date.now();
            console.log(`⏳ 正在加载登录页面... (尝试 ${attempt + 1}/${maxRetries + 1})`);
            
            await page.goto('https://secure.xserver.ne.jp/xapanel/login/xmgame', {
                waitUntil: 'domcontentloaded',
                timeout: 25000
            });
            
            const loadTime = Date.now() - startTime;
            console.log(`✅ 登录页面加载成功 (耗时: ${loadTime}ms)`);
            return true;
        } catch (error) {
            console.warn(`⚠️ 第 ${attempt + 1} 次加载失败: ${error.message}`);
            if (attempt < maxRetries) {
                await page.waitForTimeout(3000);
            }
        }
    }
    
    throw new Error('登录页面加载失败，已尝试 ' + (maxRetries + 1) + ' 次');
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
            '--disable-features=IsolateOrigins,site-per-process',
            '--disable-extensions',
            '--disable-default-apps',
            '--disable-sync',
            '--disable-translate'
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
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
            locale: 'ja-JP',
            timezoneId: 'Asia/Tokyo',
            viewport: { width: 1920, height: 1080 },
            ignoreHTTPSErrors: true
        });

        const page = await context.newPage();
        
        // 注入隐藏脚本
        await injectStealthScripts(page);

        try {
            // 加载登录页面（带重试）
            await loadLoginPage(page, 2);

            // 处理 Turnstile
            await ensureTurnstileReady(page);

            console.log('⏳ 正在输入登录凭证...');
            
            // 输入邮箱
            const emailInput = page.getByRole('textbox', { name: /XServer|メール/ }).first();
            await emailInput.click();
            await emailInput.fill('');
            for (const char of user.username) {
                await page.keyboard.type(char, { delay: 40 });
            }

            // 输入密码
            const passwordInput = page.locator('#user_password, input[type="password"]').first();
            await passwordInput.click();
            await passwordInput.fill('');
            for (const char of user.password) {
                await page.keyboard.type(char, { delay: 35 });
            }

            // 提交前再检查一次 Turnstile
            console.log('⏳ 提交前再次检查 Turnstile...');
            await ensureTurnstileReady(page);

            console.log('⏳ 正在提交登录表单...');
            await page.locator('button:has-text("ログイン"), button[type="submit"], #login-submit').first().click();

            const loginSuccess = await waitForLoginSuccess(page, 90000);
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
                    const gameLink = page.getByRole('link', { name: 'ゲーム管理' }).first();
                    await gameLink.waitFor({ state: 'visible', timeout: 10000 });
                    console.log(`✅ 第 ${attempt + 1} 次尝试：找到 ゲーム管理 链接`);
                    await gameLink.click();
                    gameManagementFound = true;
                    break;
                } catch (e) {
                    console.warn(`⚠️ 第 ${attempt + 1} 次尝试失败: ${e.message}`);
                    const debugPath = `debug_game_link_${user.username}_attempt${attempt + 1}.png`;
                    await page.screenshot({ path: debugPath, fullPage: true });
                    console.log(`💾 已保存调试截图: ${debugPath}`);
                    if (attempt < 2) {
                        await page.waitForTimeout(2000);
                    }
                }
            }

            if (!gameManagementFound) {
                throw new Error('无法找到 ゲーム管理 链接，已尝试3次');
            }

            await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});

            console.log('⏳ 正在查找 アップグレード・期限延長 链接...');
            await page.getByRole('link', { name: 'アップグレード・期限延長' }).first().click();

            try {
                console.log('⏳ 正在查找 期限を延長する 按钮...');
                await page.getByRole('link', { name: '期限を延長する' }).first().waitFor({ state: 'visible', timeout: 10000 });
                await page.getByRole('link', { name: '期限を延長する' }).first().click();
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
                await page.screenshot({ path: screenshotPath, fullPage: true });
                await sendTelegramNotification(msg, screenshotPath);
                continue;
            }

            console.log('⏳ 正在点击确认按钮...');
            await page.getByRole('button', { name: '確認画面に進む' }).first().click();

            console.log(`🖱️ 正在执行续期操作 (${user.username})...`);
            await page.getByRole('button', { name: '期限を延長する' }).first().click();
            await page.getByRole('link', { name: '戻る' }).first().click();

            const successMsg = `🇯🇵 Xserver 续期通知\n\n✅ 续期成功\n👤 账户 ${user.username}\n🕐 运行时间：${getShanghaiTime()}`;
            console.log(successMsg);
            console.log('═'.repeat(60));

            const successPath = `success_${user.username}.png`;
            await page.screenshot({ path: successPath, fullPage: true });
            await sendTelegramNotification(successMsg, successPath);

        } catch (error) {
            const errorMsg = `❌ Xserver 续期通知\n\n❌ 续期失败\n👤 账户 ${user.username}\n❌ 错误：${error.message || error}\n🕐 运行时间：${getShanghaiTime()}`;
            console.error(errorMsg);
            console.log('═'.repeat(60));

            const errorPath = `error_${user.username}.png`;
            await page.screenshot({ path: errorPath, fullPage: true }).catch(() => {});
            await sendTelegramNotification(errorMsg, errorPath);

        } finally {
            await context.close();
        }
    }

    await browser.close();
})();
