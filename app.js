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
        // console.log(`✅ fetch 代理已启用: ${PROXY_SERVER}`);
    } catch (e) {
        console.warn(`⚠️ 无法加载 undici 代理模块，fetch 将直连: ${e.message}`);
    }
} else {
    // console.log('ℹ️ 未启用代理，fetch 直连模式');
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

// ✨ 新增：处理 Cloudflare Turnstile 验证
async function handleTurnstileVerification(page, timeout = 60000) {
    console.log('🔐 正在处理 Cloudflare Turnstile 验证...');
    
    try {
        // 1. 等待 Turnstile iframe 出现
        console.log('⏳ 等待 Turnstile iframe 加载...');
        const turnstileFrame = await page.waitForSelector('iframe[src*="challenges.cloudflare.com"]', { 
            timeout: 10000 
        }).catch(() => null);

        if (!turnstileFrame) {
            console.log('ℹ️ 未检测到 Turnstile iframe，可能页面无需验证或已验证');
            return true;
        }

        console.log('✅ 检测到 Turnstile iframe');
        
        // 2. 等待复选框出现
        console.log('⏳ 等待 Turnstile 复选框加载...');
        await page.waitForSelector('input[type="checkbox"][data-sitekey], .cf-checkbox', { 
            timeout: 15000 
        }).catch(() => null);

        // 3. 点击 Turnstile 复选框 - "私はロボットではありません"
        console.log('🖱️ 点击 Turnstile 验证复选框...');
        
        // 尝试多种选择器
        const checkboxSelectors = [
            'input[type="checkbox"]',
            '.cf-checkbox',
            '[data-sitekey] input',
            'div[role="presentation"] input'
        ];

        let clicked = false;
        for (const selector of checkboxSelectors) {
            try {
                const element = await page.$(selector);
                if (element) {
                    await page.locator(selector).first().click({ timeout: 5000 });
                    console.log(`✅ 已点击复选框 (选择器: ${selector})`);
                    clicked = true;
                    break;
                }
            } catch (e) {
                console.log(`⚠️ 尝试选择器 ${selector} 失败: ${e.message}`);
            }
        }

        if (!clicked) {
            console.warn('⚠️ 未能点击 Turnstile 复选框，尝试继续...');
        }

        // 4. 等待验证完成（Cloudflare 处理验证）
        console.log('⏳ 等待 Turnstile 验证完成...');
        
        // 检查是否有验证成功的信号
        await page.waitForFunction(() => {
            // 方法1: 检查 Turnstile token 是否生成
            return window.turnstile && window.turnstile.isRendered && window.turnstile.isRendered();
        }, { timeout: 20000 }).catch(() => {
            console.log('ℹ️ Turnstile 验证状态检查超时，继续进行');
        });

        console.log('✅ Turnstile 验证处理完成');
        await page.waitForTimeout(1000); // 给予额外缓冲时间
        return true;

    } catch (error) {
        console.warn(`⚠️ Turnstile 处理异常: ${error.message}`);
        return false;
    }
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
            '--disable-dev-shm-usage'
        ]
    };

    // 为 Playwright 浏览器配置代理
    if (IS_PROXY && PROXY_SERVER) {
        launchOptions.proxy = { server: PROXY_SERVER };
        console.log(`✅ 浏览器代理已启用: ${PROXY_SERVER}`);
    } else {
        console.log('ℹ️ 浏览器直连模式');
    }

    const browser = await chromium.launch(launchOptions);

    // 获取出站真实 IP
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
        console.log(`👤 正在处理用户: ${user.username}`);
        const context = await browser.newContext();
        const page = await context.newPage();

        try {
            // 1. 导航到登录页面
            console.log('⏳ 正在加载登录页面...');
            await page.goto('https://secure.xserver.ne.jp/xapanel/login/xmgame', { 
                waitUntil: 'domcontentloaded', 
                timeout: 30000 
            });

            // 2. 登录
            console.log('⏳ 正在输入登录信息...');
            await page.getByRole('textbox', { name: 'XServerアカウントID または メールアドレス' }).click();
            await page.getByRole('textbox', { name: 'XServerアカウントID または メールアドレス' }).fill(user.username);
            await page.locator('#user_password').fill(user.password);
            
            // Use an ID-based selector for the login button to avoid Playwright strict mode ambiguity
            console.log('⏳ 正在提交登录表单...');
            await page.locator('#login-submit').click();

            // ✨ 处理 Turnstile 验证
            await handleTurnstileVerification(page, 60000);

            // 等待登录成功并导航到首页
            console.log('⏳ 等待登录完成，加载首页...');
            
            // 使用 waitForURL 等待页面导航，但不等待 networkidle（容易超时）
            try {
                await page.waitForURL(/xapanel/, { timeout: 30000 });
            } catch (e) {
                console.warn(`⚠️ URL 等待超时，检查当前页面: ${page.url()}`);
            }
            
            // 只等待 DOM 加载完成
            await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {
                console.log('ℹ️ DOM 加载超时，继续进行');
            });
            
            await page.waitForTimeout(2000);

            // 尝试找到并点击 "ゲーム管理" 链接，增加重试机制
            console.log('⏳ 正在查找 ゲーム管理 链接...');
            let gameManagementFound = false;
            for (let attempt = 0; attempt < 3; attempt++) {
                try {
                    const gameLink = page.getByRole('link', { name: 'ゲーム管理' });
                    await gameLink.waitFor({ state: 'visible', timeout: 20000 });
                    console.log(`✅ 第 ${attempt + 1} 次尝试：找到 ゲーム管理 链接`);
                    await gameLink.click();
                    gameManagementFound = true;
                    break;
                } catch (e) {
                    console.warn(`⚠️ 第 ${attempt + 1} 次尝试失败: ${e.message}`);
                    if (attempt < 2) {
                        console.log('⏳ 等待后重试...');
                        await page.waitForTimeout(3000);
                    }
                }
            }

            if (!gameManagementFound) {
                throw new Error('无法找到 ゲーム管理 链接，已尝试3次');
            }

            // 等待页面加载，但改为 domcontentloaded 而非 networkidle
            await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {
                console.log('ℹ️ DOM 加载超时，继续进行');
            });

            // 3. 升级 / 延长
            console.log('⏳ 正在查找 アップグレード・期限延長 链接...');
            await page.getByRole('link', { name: 'アップグレード・期限延長' }).click();

            // 4. 选择 '延长期间' - 检查是否可用
            try {
                console.log('⏳ 正在查找 期限を延長する 按钮...');
                await page.getByRole('link', { name: '期限を延長する' }).waitFor({ state: 'visible', timeout: 10000 });
                await page.getByRole('link', { name: '期限を延長する' }).click();
            } catch (e) {
                // 检查是否有具体的下一次更新时间提示
                const bodyText = await page.locator('body').innerText();
                const match = bodyText.match(/更新をご希望の場合は、(.+?)以降にお試しください。/);

                let msg;
                if (match && match[1]) {
                    msg = `🇯🇵 Xserver 续期通知\n\n⚠️ 未到续期时间\n👤 账户 ${user.username} 可续期：${match[1]}\n🕐 运行时间：${getShanghaiTime()}`;
                } else {
                    msg = `🇯🇵 Xserver 续期通知\n\n⚠️ 用户 ${user.username} 未找到 '期限延長' 按钮。可能无法延长。\n\n🕐 运行时间：${getShanghaiTime()}`;
                }

                console.log(msg);
                // 保存截图
                const screenshotPath = `skip_${user.username}.png`;
                await page.screenshot({ path: screenshotPath });
                await sendTelegramNotification(msg, screenshotPath);
                continue;
            }

            // 5. 确认
            console.log('⏳ 正在点击确认按钮...');
            await page.getByRole('button', { name: '確認画面に進む' }).click();

            // 6. 执行延长
            console.log(`🖱️ 正在点击用户 ${user.username} 的最终延长按钮...`);
            await page.getByRole('button', { name: '期限を延長する' }).click();

            // 7. 返回
            await page.getByRole('link', { name: '戻る' }).click();

            const successMsg = `🇯🇵 Xserver 续期通知\n\n✅ 续期成功\n👤 账户 ${user.username}\n🕐 运行时间：${getShanghaiTime()}`;
            console.log(successMsg);
            const successPath = `success_${user.username}.png`;
            await page.screenshot({ path: successPath });
            await sendTelegramNotification(successMsg, successPath);

        } catch (error) {
            const errorMsg = `❌ Xserver 续期通知\n\n❌ 续期失败\n👤 账户 ${user.username}\n❌ 错误信息：${error}\n\n🕐 运行时间：${getShanghaiTime()}`;
            console.error(errorMsg);
            const errorPath = `error_${user.username}.png`;
            await page.screenshot({ path: errorPath });
            await sendTelegramNotification(errorMsg, errorPath);
        } finally {
            await context.close();
        }
    }

    await browser.close();
})();
