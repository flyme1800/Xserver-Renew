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
 * 🔐 核心：处理 Cloudflare Turnstile 验证
 * 这个函数确保在登录提交前，Turnstile widget 已加载并可交互
 */
async function ensureTurnstileReady(page, timeout = 45000) {
    console.log('🔐 [Turnstile] 检查并等待 Turnstile widget 加载完成...');
    
    const startTime = Date.now();
    let turnstileLoaded = false;

    try {
        // ========== 第一步：等待 Turnstile iframe 加载 ==========
        console.log('⏳ [Turnstile] 等待 Turnstile iframe 加载...');
        
        try {
            await page.waitForSelector(
                'iframe[src*="challenges.cloudflare.com"], iframe[data-sitekey], [data-sitekey]',
                { timeout: 15000 }
            );
            console.log('✅ [Turnstile] 检测到 Turnstile widget');
            turnstileLoaded = true;
        } catch (e) {
            console.log('ℹ️ [Turnstile] 页面上未发现 Turnstile iframe - 可能不需要验证或已预加载');
        }

        // ========== 第二步：等待 Turnstile 脚本加载到 window.turnstile ==========
        console.log('⏳ [Turnstile] 等待 Cloudflare Turnstile 脚本初始化...');
        
        try {
            await page.waitForFunction(
                () => typeof window.turnstile !== 'undefined',
                { timeout: 20000 }
            );
            console.log('✅ [Turnstile] Turnstile 脚本已加载');
        } catch (e) {
            console.log('⚠️ [Turnstile] Turnstile 脚本未加载，尝试继续');
        }

        // ========== 第三步：等待复选框出现并可见 ==========
        console.log('⏳ [Turnstile] 等待复选框元素加载...');
        
        const checkboxSelectors = [
            'input[type="checkbox"]',
            '[role="checkbox"]',
            '.cf-checkbox',
            'label input[type="checkbox"]'
        ];

        let checkboxFound = false;
        for (const selector of checkboxSelectors) {
            try {
                await page.waitForSelector(selector, { timeout: 8000 });
                console.log(`✅ [Turnstile] 找到复选框 (选择器: ${selector})`);
                checkboxFound = true;
                break;
            } catch (e) {
                // 继续尝试下一个选择器
            }
        }

        if (!checkboxFound) {
            console.log('⚠️ [Turnstile] 未能定位复选框，可能已自动验证或页面结构不同');
        }

        // ========== 第四步：模拟真实用户行为 - 点击复选框 ==========
        if (checkboxFound) {
            console.log('🖱️ [Turnstile] 模拟用户点击复选框...');
            
            try {
                // 先滚动到元素位置
                await page.locator('input[type="checkbox"]').first().scrollIntoViewIfNeeded();
                await page.waitForTimeout(500);
                
                // 使用真实点击（模拟鼠标移动）
                const checkbox = await page.$('input[type="checkbox"]');
                if (checkbox) {
                    const box = await checkbox.boundingBox();
                    if (box) {
                        // 移动鼠标到元素
                        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
                        await page.waitForTimeout(300);
                        // 点击
                        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
                        console.log('✅ [Turnstile] 已点击复选框');
                    }
                }
            } catch (e) {
                console.warn(`⚠️ [Turnstile] 点击复选框失败: ${e.message}`);
            }
        }

        // ========== 第五步：等待 Cloudflare 挑战完成 ==========
        console.log('⏳ [Turnstile] 等待 Cloudflare 验证完成...');
        
        const waitForVerification = await page.waitForFunction(
            () => {
                // 检查多个验证完成的信号
                const hasToken = window.turnstile && typeof window.turnstile.getResponse === 'function';
                const tokenValue = hasToken ? window.turnstile.getResponse() : null;
                const inputFound = document.querySelector('input[name="cf_clearance"], input[name="token"]');
                
                return hasToken || inputFound || (tokenValue && tokenValue.length > 0);
            },
            { timeout: 30000 }
        ).catch(() => {
            console.log('ℹ️ [Turnstile] 验证状态检查超时，继续进行');
            return false;
        });

        if (waitForVerification) {
            console.log('✅ [Turnstile] 验证已完成');
        }

        // ========== 第六步：等待页面稳定 ==========
        console.log('⏳ [Turnstile] 等待页面稳定...');
        await page.waitForTimeout(1500);

        const elapsedTime = Date.now() - startTime;
        console.log(`✅ [Turnstile] 处理完成 (耗时: ${elapsedTime}ms)`);
        return true;

    } catch (error) {
        console.error(`❌ [Turnstile] 验证处理出错: ${error.message}`);
        return false;
    }
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
            // 检查是否已导航到控制面板
            const currentUrl = page.url();
            if (currentUrl.includes('xapanel') && !currentUrl.includes('login')) {
                console.log('✅ 成功导航到控制面板');
                return true;
            }

            // 检查是否显示错误提示
            const errorElements = await page.locator('[class*="error"], [class*="alert"], .alert-danger').all();
            for (const elem of errorElements) {
                const text = await elem.innerText().catch(() => '');
                if (text && text.length > 0) {
                    console.warn(`⚠️ 检测到错误提示: ${text.substring(0, 100)}`);
                    return false;
                }
            }

            // 检查是否有红色的"エラー"（错误）提示
            const bodyText = await page.locator('body').innerText().catch(() => '');
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
        console.log(`\n👤 正在处理用户: ${user.username}`);
        console.log('═'.repeat(60));
        
        const context = await browser.newContext();
        const page = await context.newPage();

        // 设置真实 User-Agent
        await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        );

        try {
            // ========== 第1步：加载登录页面 ==========
            console.log('⏳ 正在加载登录页面...');
            await page.goto('https://secure.xserver.ne.jp/xapanel/login/xmgame', { 
                waitUntil: 'domcontentloaded', 
                timeout: 30000 
            });

            // ========== 第2步：检测并等待 Turnstile 加载 ==========
            await ensureTurnstileReady(page, 45000);

            // ========== 第3步：填写登录信息 ==========
            console.log('⏳ 正在输入登录凭证...');
            
            const emailInput = page.getByRole('textbox', { 
                name: 'XServerアカウントID または メールアドレス' 
            });
            await emailInput.click();
            await emailInput.fill(user.username);
            
            const passwordInput = page.locator('#user_password');
            await passwordInput.fill(user.password);

            // ========== 第4步：提交登录 ==========
            console.log('⏳ 正在提交登录表单...');
            const loginButton = page.locator('#login-submit');
            await loginButton.click();

            // ========== 第5步：等待登录成功（核心逻辑） ==========
            const loginSuccess = await waitForLoginSuccess(page, 60000);

            if (!loginSuccess) {
                throw new Error('登录失败或超时，未能进入控制面板');
            }

            // ========== 第6步：页面稳定等待 ==========
            console.log('⏳ 等待页面完全加载...');
            await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
            await page.waitForTimeout(2000);

            // ========== 第7步：点击"ゲーム管理" ==========
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

                    // 保存调试截图
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

            // 等待页面加载
            await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});

            // ========== 第8步：升级/延长 ==========
            console.log('⏳ 正在查找 アップグレード・期限延長 链接...');
            await page.getByRole('link', { name: 'アップグレード・期限延長' }).click();

            // ========== 第9步：选择延长期间 ==========
            try {
                console.log('⏳ 正在查找 期限を延長する 按钮...');
                await page.getByRole('link', { name: '期限を延長する' }).waitFor({ state: 'visible', timeout: 10000 });
                await page.getByRole('link', { name: '期限を延長する' }).click();

            } catch (e) {
                // 检查是否有续期时间限制
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

            // ========== 第10步：确认 ==========
            console.log('⏳ 正在点击确认按钮...');
            await page.getByRole('button', { name: '確認画面に進む' }).click();

            // ========== 第11步：最终执行延长 ==========
            console.log(`🖱️ 正在执行续期操作 (${user.username})...`);
            await page.getByRole('button', { name: '期限を延長する' }).click();

            // ========== 第12步：返回首页 ==========
            await page.getByRole('link', { name: '戻る' }).click();

            // ========== 成功 ==========
            const successMsg = `🇯🇵 Xserver 续期通知\n\n✅ 续期成功\n👤 账户 ${user.username}\n🕐 运行时间：${getShanghaiTime()}`;
            console.log(successMsg);
            console.log('═'.repeat(60));

            const successPath = `success_${user.username}.png`;
            await page.screenshot({ path: successPath });
            await sendTelegramNotification(successMsg, successPath);

        } catch (error) {
            // ========== 失败处理 ==========
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
