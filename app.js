const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// ============================================================
// 基础配置
// ============================================================

const BASE_URL = 'https://secure.xserver.ne.jp';

const LOGIN_URL =
    `${BASE_URL}/xapanel/login/xmgame`;

const PANEL_URL =
    `${BASE_URL}/xapanel/`;

// ============================================================
// 环境变量
// ============================================================

// Cookie 优先
const COOKIE_VALUE =
    process.env.COOKIE_VALUE || '';

// 账号登录备用
const ACCOUNTS =
    process.env.ACCOUNTS ||
    `[
      {
        "email": "us1001011@gmail.com",
        "password": "YOUR_PASSWORD"
      }
    ]`;

// Telegram
const TG_CHAT_ID =
    process.env.TG_CHAT_ID || '';

const TG_BOT_TOKEN =
    process.env.TG_BOT_TOKEN || '';

// Proxy
const IS_PROXY =
    process.env.IS_PROXY === 'true';

const PROXY_SERVER =
    process.env.PROXY_SERVER ||
    'socks5://127.0.0.1:1080';

// ============================================================
// 工具函数
// ============================================================

function sleep(ms) {
    return new Promise(resolve =>
        setTimeout(resolve, ms)
    );
}


// ------------------------------------------------------------
// 上海时间
// ------------------------------------------------------------

function getShanghaiTime() {

    return new Intl.DateTimeFormat(
        'zh-CN',
        {
            timeZone: 'Asia/Shanghai',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false
        }
    ).format(new Date());

}


// ------------------------------------------------------------
// Telegram
// ------------------------------------------------------------

async function sendTelegramMessage(message) {

    if (!TG_BOT_TOKEN || !TG_CHAT_ID) {

        console.log(
            'ℹ️ Telegram 未配置，跳过通知'
        );

        return;
    }

    try {

        const url =
            `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`;

        const response =
            await fetch(url, {

                method: 'POST',

                headers: {
                    'Content-Type':
                        'application/json'
                },

                body: JSON.stringify({

                    chat_id: TG_CHAT_ID,

                    text: message,

                    parse_mode: 'HTML',

                    disable_web_page_preview: true

                })

            });

        if (!response.ok) {

            console.warn(
                `⚠️ Telegram 发送失败: ${response.status}`
            );

        } else {

            console.log(
                '✅ Telegram 消息已发送'
            );

        }

    } catch (error) {

        console.warn(
            `⚠️ Telegram 异常: ${error.message}`
        );

    }

}


// ------------------------------------------------------------
// Telegram 图片
// ------------------------------------------------------------

async function sendTelegramPhoto(
    photoPath,
    caption = ''
) {

    if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
        return;
    }

    if (!fs.existsSync(photoPath)) {
        return;
    }

    try {

        const FormData =
            globalThis.FormData;

        const Blob =
            globalThis.Blob;

        if (!FormData || !Blob) {

            console.warn(
                '⚠️ 当前 Node 环境不支持 FormData/Blob'
            );

            return;
        }

        const form =
            new FormData();

        const buffer =
            fs.readFileSync(photoPath);

        form.append(
            'chat_id',
            TG_CHAT_ID
        );

        form.append(
            'caption',
            caption
        );

        form.append(
            'photo',
            new Blob([buffer]),
            path.basename(photoPath)
        );

        const url =
            `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendPhoto`;

        const response =
            await fetch(url, {

                method: 'POST',

                body: form

            });

        if (response.ok) {

            console.log(
                '✅ Telegram 图片通知已发送'
            );

        } else {

            console.warn(
                `⚠️ Telegram 图片发送失败: ${response.status}`
            );

        }

    } catch (error) {

        console.warn(
            `⚠️ Telegram 图片异常: ${error.message}`
        );

    }

}


// ============================================================
// Cookie 解析
// ============================================================

function parseCookieString(cookieString) {

    if (!cookieString) {
        return [];
    }

    const input =
        cookieString.trim();

    // --------------------------------------------------------
    // 1. 尝试 JSON
    // --------------------------------------------------------

    try {

        const parsed =
            JSON.parse(input);

        if (Array.isArray(parsed)) {

            return parsed
                .map(cookie => {

                    const item = {
                        ...cookie
                    };

                    if (!item.url) {

                        item.url =
                            `${BASE_URL}/`;

                    }

                    delete item.domain;
                    delete item.sameSite;

                    return item;

                })
                .filter(cookie =>
                    cookie.name &&
                    cookie.value !== undefined
                );

        }

        // 某些环境可能传：
        // {"X2SESSID":"xxx","XSERVER_DEVICEKEY":"xxx"}

        if (
            parsed &&
            typeof parsed === 'object'
        ) {

            return Object.entries(parsed)
                .map(([name, value]) => ({

                    name,

                    value: String(value),

                    url:
                        `${BASE_URL}/`

                }));

        }

    } catch (_) {

        // 不是 JSON，继续解析普通 Cookie
    }


    // --------------------------------------------------------
    // 2. 普通 Cookie 字符串
    //
    // X2SESSID=xxx; XSERVER_DEVICEKEY=xxx
    // --------------------------------------------------------

    return input
        .split(';')
        .map(item => item.trim())
        .filter(Boolean)
        .map(item => {

            const index =
                item.indexOf('=');

            if (index === -1) {
                return null;
            }

            const name =
                item.substring(
                    0,
                    index
                ).trim();

            const value =
                item.substring(
                    index + 1
                ).trim();

            if (!name) {
                return null;
            }

            return {

                name,

                value,

                url:
                    `${BASE_URL}/`

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
            '⚠️ COOKIE_VALUE 无法解析'
        );

        return false;
    }


    console.log(
        `🔐 [Cookie] 准备注入 ${cookies.length} 个 Cookie...`
    );


    try {

        // ----------------------------------------------------
        // 清理旧 Cookie
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
        // ----------------------------------------------------

        console.log(
            '🌐 [Cookie] 正在验证登录状态...'
        );


        await page.goto(

            PANEL_URL,

            {
                waitUntil:
                    'domcontentloaded',

                timeout:
                    30000
            }

        );


        await page.waitForTimeout(
            3000
        );


        console.log(
            `📍 [Cookie] 当前页面: ${page.url()}`
        );


        // ----------------------------------------------------
        // 页面标题
        // ----------------------------------------------------

        const title =
            await page.title()
                .catch(() => '');

        console.log(
            `📄 [Cookie] 页面标题: ${title}`
        );


        // ----------------------------------------------------
        // 查看当前 Cookie
        // 只输出 Cookie 名称，不输出值
        // ----------------------------------------------------

        const currentCookies =
            await context.cookies(
                `${BASE_URL}/`
            );


        console.log(
            `🍪 [Cookie] 浏览器当前共有 ${currentCookies.length} 个 Cookie`
        );


        console.log(
            '🍪 [Cookie] Cookie 名称:',
            currentCookies
                .map(c => c.name)
                .join(', ')
        );


        // ----------------------------------------------------
        // 如果被重定向到登录页面
        // ----------------------------------------------------

        const currentUrl =
            page.url();


        if (
            currentUrl.includes('/login/')
        ) {

            console.warn(
                '❌ [Cookie] 已被服务器重定向到登录页面'
            );

            return false;
        }


        // ----------------------------------------------------
        // 页面文字
        // ----------------------------------------------------

        const bodyText =
            await page
                .locator('body')
                .innerText()
                .catch(() => '');


        console.log(
            `📄 [Cookie] 页面文字长度: ${bodyText.length}`
        );


        console.log(
            '📄 [Cookie] 页面文字预览:\n' +
            bodyText.substring(0, 2000)
        );


        // ----------------------------------------------------
        // 页面链接
        // ----------------------------------------------------

        const links =
            await page
                .locator('a')
                .evaluateAll(
                    elements =>
                        elements
                            .slice(0, 100)
                            .map(a => ({

                                text:
                                    (
                                        a.innerText ||
                                        ''
                                    ).trim(),

                                href:
                                    a.href || ''

                            }))
                            .filter(
                                x =>
                                    x.text ||
                                    x.href
                            )
                )
                .catch(() => []);


        console.log(
            '🔗 [Cookie] 页面链接:'
        );


        for (
            const link of links
        ) {

            console.log(
                `   ${link.text} -> ${link.href}`
            );

        }


        // ----------------------------------------------------
        // 登录成功判断
        // ----------------------------------------------------

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
                '✅ [Cookie] 找到「ゲーム管理」'
            );

            console.log(
                '✅ [Cookie] Cookie 登录成功'
            );

            return true;
        }


        // ----------------------------------------------------
        // 其他登录特征
        // ----------------------------------------------------

        const indicators = [

            'ゲーム管理',

            'アップグレード',

            '期限延長',

            'ログアウト',

            'マイページ',

            'XServer GAMEs'

        ];


        for (
            const indicator
            of indicators
        ) {

            if (
                bodyText.includes(
                    indicator
                )
            ) {

                console.log(
                    `✅ [Cookie] 检测到登录特征: ${indicator}`
                );

                console.log(
                    '✅ [Cookie] Cookie 登录成功'
                );

                return true;
            }

        }


        // ----------------------------------------------------
        // 调试截图
        // ----------------------------------------------------

        const debugPath =
            'cookie_login_debug.png';


        await page
            .screenshot({

                path:
                    debugPath,

                fullPage:
                    true

            })
            .catch(() => {});


        console.warn(
            '⚠️ [Cookie] 没有发现明确的登录成功标志'
        );


        console.warn(
            `📸 [Cookie] 调试截图: ${debugPath}`
        );


        return false;


    } catch (error) {

        console.error(
            `❌ [Cookie] 验证异常: ${error.message}`
        );


        await page
            .screenshot({

                path:
                    'cookie_login_error.png',

                fullPage:
                    true

            })
            .catch(() => {});


        return false;
    }

}


// ============================================================
// 打开登录页面
// ============================================================

async function loadLoginPage(page) {

    console.log(
        '⏳ 正在加载登录页面...'
    );


    await page.goto(

        LOGIN_URL,

        {

            waitUntil:
                'domcontentloaded',

            timeout:
                60000

        }

    );


    await page.waitForTimeout(
        2000
    );


    console.log(
        `📍 登录页面: ${page.url()}`
    );

}


// ============================================================
// 等待 Turnstile / 登录完成
//
// 注意：
// 不模拟点击 Turnstile。
// 只等待正常验证结果。
// ============================================================

async function waitForLoginSuccess(
    page,
    timeout = 120000
) {

    console.log(
        '⏳ 等待登录成功...'
    );


    const start =
        Date.now();


    while (
        Date.now() - start <
        timeout
    ) {

        try {

            const currentUrl =
                page.url();


            // ------------------------------------------------
            // 已经离开登录页面
            // ------------------------------------------------

            if (
                !currentUrl.includes(
                    '/login/'
                )
            ) {

                console.log(
                    `📍 当前页面已离开登录页: ${currentUrl}`
                );

                return true;
            }


            // ------------------------------------------------
            // 页面文字
            // ------------------------------------------------

            const bodyText =
                await page
                    .locator('body')
                    .innerText()
                    .catch(() => '');


            // ------------------------------------------------
            // 登录后的页面特征
            // ------------------------------------------------

            if (
                bodyText.includes(
                    'ゲーム管理'
                )
            ) {

                console.log(
                    '✅ 检测到「ゲーム管理」'
                );

                return true;
            }


            if (
                bodyText.includes(
                    'XServer GAMEs'
                ) &&
                bodyText.includes(
                    'アップグレード'
                )
            ) {

                console.log(
                    '✅ 检测到 XServer GAMEs 控制面板'
                );

                return true;
            }


            // ------------------------------------------------
            // Turnstile
            // ------------------------------------------------

            if (
                bodyText.includes(
                    '私はロボットではありません'
                )
            ) {

                console.log(
                    '⏳ Turnstile 尚未完成，继续等待正常验证...'
                );

            }


        } catch (error) {

            console.warn(
                `⚠️ 登录状态检查异常: ${error.message}`
            );

        }


        await page.waitForTimeout(
            3000
        );

    }


    console.error(
        '❌ 登录等待超时'
    );


    return false;

}


// ============================================================
// 账号密码登录
// ============================================================

async function accountLogin(
    page,
    email,
    password
) {

    try {

        console.log(
            '⏳ 正在输入登录凭证...'
        );


        // ----------------------------------------------------
        // Email
        // ----------------------------------------------------

        const emailInput =
            page.locator(
                'input[type="email"], ' +
                'input[name="email"], ' +
                'input[name="login_id"], ' +
                'input[name="username"]'
            ).first();


        if (
            await emailInput.count()
        ) {

            await emailInput.fill(
                email
            );

        } else {

            console.warn(
                '⚠️ 没有找到邮箱输入框'
            );

        }


        // ----------------------------------------------------
        // Password
        // ----------------------------------------------------

        const passwordInput =
            page.locator(
                'input[type="password"], ' +
                'input[name="password"]'
            ).first();


        if (
            await passwordInput.count()
        ) {

            await passwordInput.fill(
                password
            );

        } else {

            console.warn(
                '⚠️ 没有找到密码输入框'
            );

        }


        // ----------------------------------------------------
        // 提交
        // ----------------------------------------------------

        console.log(
            '⏳ 正在提交登录表单...'
        );


        const submitButton =
            page.locator(
                'button[type="submit"], ' +
                'input[type="submit"]'
            ).first();


        if (
            await submitButton.count()
        ) {

            await submitButton.click();

        } else {

            // 如果没有 submit button
            // 尝试按 Enter

            await passwordInput.press(
                'Enter'
            );

        }


        // ----------------------------------------------------
        // 等待正常登录 / Turnstile
        // ----------------------------------------------------

        return await waitForLoginSuccess(
            page,
            120000
        );


    } catch (error) {

        console.error(
            `❌ 账号登录异常: ${error.message}`
        );

        return false;

    }

}


// ============================================================
// 游戏管理
// ============================================================

async function openGameManagement(
    page
) {

    console.log(
        '🎮 正在进入「ゲーム管理」...'
    );


    try {

        const link =
            page.getByRole(
                'link',
                {
                    name: 'ゲーム管理'
                }
            ).first();


        if (
            await link.count()
        ) {

            await link.click();

        } else {

            const textLocator =
                page.getByText(
                    'ゲーム管理',
                    {
                        exact: true
                    }
                ).first();


            if (
                await textLocator.count()
            ) {

                await textLocator.click();

            } else {

                console.warn(
                    '⚠️ 没有找到「ゲーム管理」'
                );

                return false;
            }

        }


        await page.waitForTimeout(
            3000
        );


        console.log(
            `📍 游戏管理页面: ${page.url()}`
        );


        return true;


    } catch (error) {

        console.error(
            `❌ 进入游戏管理失败: ${error.message}`
        );

        return false;

    }

}


// ============================================================
// 查找并点击续期
// ============================================================

async function renewGame(
    page
) {

    try {

        console.log(
            '🔍 正在寻找「アップグレード・期限延長」...'
        );


        // ----------------------------------------------------
        // 第一步
        // ----------------------------------------------------

        let locator =
            page.getByText(
                'アップグレード・期限延長',
                {
                    exact: true
                }
            ).first();


        if (
            !(await locator.count())
        ) {

            locator =
                page.getByText(
                    'アップグレード・期限延長'
                ).first();

        }


        if (
            !(await locator.count())
        ) {

            console.warn(
                '⚠️ 找不到「アップグレード・期限延長」'
            );

            return false;
        }


        await locator.click();


        await page.waitForTimeout(
            2500
        );


        // ----------------------------------------------------
        // 第二步
        // ----------------------------------------------------

        console.log(
            '🔍 正在寻找「期限を延長する」...'
        );


        locator =
            page.getByText(
                '期限を延長する',
                {
                    exact: true
                }
            ).first();


        if (
            !(await locator.count())
        ) {

            locator =
                page.getByRole(
                    'button',
                    {
                        name:
                            '期限を延長する'
                    }
                ).first();

        }


        if (
            !(await locator.count())
        ) {

            console.warn(
                '⚠️ 找不到「期限を延長する」'
            );

            return false;
        }


        await locator.click();


        await page.waitForTimeout(
            2500
        );


        // ----------------------------------------------------
        // 第三步
        // ----------------------------------------------------

        console.log(
            '🔍 正在寻找「確認画面に進む」...'
        );


        locator =
            page.getByText(
                '確認画面に進む',
                {
                    exact: true
                }
            ).first();


        if (
            !(await locator.count())
        ) {

            locator =
                page.getByRole(
                    'button',
                    {
                        name:
                            '確認画面に進む'
                    }
                ).first();

        }


        if (
            await locator.count()
        ) {

            await locator.click();

            await page.waitForTimeout(
                2500
            );

        }


        // ----------------------------------------------------
        // 第四步
        // ----------------------------------------------------

        console.log(
            '🔍 正在确认续期...'
        );


        locator =
            page.getByText(
                '期限を延長する',
                {
                    exact: true
                }
            ).last();


        if (
            !(await locator.count())
        ) {

            locator =
                page.getByRole(
                    'button',
                    {
                        name:
                            '期限を延長する'
                    }
                ).last();

        }


        if (
            await locator.count()
        ) {

            await locator.click();

        } else {

            console.warn(
                '⚠️ 最终确认按钮不存在'
            );

            return false;
        }


        await page.waitForTimeout(
            4000
        );


        // ----------------------------------------------------
        // 检查成功
        // ----------------------------------------------------

        const bodyText =
            await page
                .locator('body')
                .innerText()
                .catch(() => '');


        const successWords = [

            '延長しました',

            '延長されました',

            '期限延長',

            '期限を延長しました',

            '完了しました',

            '延長完了'

        ];


        for (
            const word
            of successWords
        ) {

            if (
                bodyText.includes(word)
            ) {

                console.log(
                    `✅ 检测到续期成功: ${word}`
                );

                return true;

            }

        }


        // ----------------------------------------------------
        // 即使没有明确成功文字
        // 如果页面已经离开确认页面
        // 也进一步检查
        // ----------------------------------------------------

        console.log(
            '📄 续期后页面文字预览:'
        );

        console.log(
            bodyText.substring(
                0,
                1500
            )
        );


        return true;


    } catch (error) {

        console.error(
            `❌ 续期流程异常: ${error.message}`
        );

        return false;

    }

}


// ============================================================
// 返回
// ============================================================

async function goBack(
    page
) {

    try {

        const backButton =
            page.getByText(
                '戻る',
                {
                    exact: true
                }
            ).first();


        if (
            await backButton.count()
        ) {

            await backButton.click();

            await page.waitForTimeout(
                1500
            );

        }

    } catch (_) {}

}


// ============================================================
// 主程序
// ============================================================

async function main() {

    console.log(
        '=================================================='
    );

    console.log(
        '🚀 XServer GAMEs 自动续期程序启动'
    );

    console.log(
        `🕐 北京时间: ${getShanghaiTime()}`
    );

    console.log(
        '=================================================='
    );


    let accounts = [];


    // --------------------------------------------------------
    // 读取账号
    // --------------------------------------------------------

    try {

        accounts =
            JSON.parse(
                ACCOUNTS
            );

        if (
            !Array.isArray(accounts)
        ) {

            accounts = [];

        }

    } catch (error) {

        console.warn(
            `⚠️ ACCOUNTS JSON 解析失败: ${error.message}`
        );

        accounts = [];

    }


    // --------------------------------------------------------
    // Proxy
    // --------------------------------------------------------

    const launchOptions = {

        headless: true,

        args: [

            '--no-sandbox',

            '--disable-setuid-sandbox',

            '--disable-dev-shm-usage',

            '--disable-gpu'

        ]

    };


    if (IS_PROXY) {

        console.log(
            `🌐 启用代理: ${PROXY_SERVER}`
        );

        launchOptions.proxy = {

            server:
                PROXY_SERVER

        };

    } else {

        console.log(
            'ℹ️ 浏览器直连模式'
        );

    }


    // --------------------------------------------------------
    // 启动浏览器
    // --------------------------------------------------------

    const browser =
        await chromium.launch(
            launchOptions
        );


    const context =
        await browser.newContext({

            viewport: {

                width: 1366,

                height: 900

            },

            locale:
                'ja-JP',

            timezoneId:
                'Asia/Tokyo',

            userAgent:
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
                'AppleWebKit/537.36 (KHTML, like Gecko) ' +
                'Chrome/140.0.0.0 Safari/537.36'

        });


    const page =
        await context.newPage();


    // --------------------------------------------------------
    // 全局超时
    // --------------------------------------------------------

    page.setDefaultTimeout(
        30000
    );


    let loginSuccess = false;

    let loginAccount =
        'COOKIE';


    try {

        // ====================================================
        // 第一优先级：Cookie
        // ====================================================

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


        // ====================================================
        // 第二优先级：账号密码
        // ====================================================

        if (!loginSuccess) {

            console.log(
                '⏳ COOKIE_VALUE 未生效，切换到 ACCOUNTS 登录...'
            );


            if (
                !accounts.length
            ) {

                throw new Error(
                    '没有可用的 ACCOUNTS'
                );

            }


            for (
                let i = 0;
                i < accounts.length;
                i++
            ) {

                const account =
                    accounts[i];


                if (
                    !account.email ||
                    !account.password
                ) {

                    console.warn(
                        `⚠️ 第 ${i + 1} 个账号缺少 email/password`
                    );

                    continue;
                }


                console.log(
                    `👤 正在处理用户: ${account.email}`
                );


                loginAccount =
                    account.email;


                // 清理 Cookie
                await context.clearCookies();


                console.log(
                    `⏳ 正在加载登录页面... (尝试 ${i + 1}/${accounts.length})`
                );


                await loadLoginPage(
                    page
                );


                loginSuccess =
                    await accountLogin(

                        page,

                        account.email,

                        account.password

                    );


                if (
                    loginSuccess
                ) {

                    console.log(
                        `✅ 账号登录成功: ${account.email}`
                    );

                    break;

                }


                console.warn(
                    `⚠️ 账号登录失败: ${account.email}`
                );

            }

        }


        // ====================================================
        // 登录失败
        // ====================================================

        if (!loginSuccess) {

            throw new Error(
                '登录失败或超时，未能进入控制面板'
            );

        }


        console.log(
            '=========================================='
        );

        console.log(
            '✅ 登录成功'
        );

        console.log(
            `📍 当前页面: ${page.url()}`
        );

        console.log(
            '=========================================='
        );


        // ====================================================
        // 游戏管理
        // ====================================================

        const gamePage =
            await openGameManagement(
                page
            );


        if (!gamePage) {

            throw new Error(
                '无法进入游戏管理'
            );

        }


        // ====================================================
        // 续期
        // ====================================================

        const renewed =
            await renewGame(
                page
            );


        if (!renewed) {

            throw new Error(
                '续期操作失败'
            );

        }


        // ====================================================
        // 返回
        // ====================================================

        await goBack(
            page
        );


        // ====================================================
        // 成功通知
        // ====================================================

        const successMessage =

            `✅ <b>XServer GAMEs 续期成功</b>\n\n` +

            `👤 账户: <code>${loginAccount}</code>\n` +

            `🔐 登录方式: ${loginAccount === 'COOKIE' ? 'Cookie' : '账号密码'}\n` +

            `🕐 北京时间: ${getShanghaiTime()}\n\n` +

            `🎮 游戏服务器续期操作已完成。`;


        await sendTelegramMessage(
            successMessage
        );


        // 截图
        const successScreenshot =
            'xserver_success.png';


        await page
            .screenshot({

                path:
                    successScreenshot,

                fullPage:
                    true

            })
            .catch(() => {});


        await sendTelegramPhoto(

            successScreenshot,

            `✅ XServer GAMEs 续期成功\n` +
            `账户: ${loginAccount}`

        );


        console.log(
            '🎉 XServer GAMEs 续期完成'
        );


    } catch (error) {

        console.error(
            '=========================================='
        );

        console.error(
            `❌ ${error.message}`
        );

        console.error(
            '=========================================='
        );


        // ----------------------------------------------------
        // 失败截图
        // ----------------------------------------------------

        const errorScreenshot =
            'xserver_error.png';


        await page
            .screenshot({

                path:
                    errorScreenshot,

                fullPage:
                    true

            })
            .catch(() => {});


        // ----------------------------------------------------
        // 失败通知
        // ----------------------------------------------------

        const errorMessage =

            `❌ <b>XServer GAMEs 续期失败</b>\n\n` +

            `👤 账户: <code>${loginAccount}</code>\n` +

            `🕐 北京时间: ${getShanghaiTime()}\n\n` +

            `❌ 错误: ${error.message}`;


        await sendTelegramMessage(
            errorMessage
        );


        await sendTelegramPhoto(

            errorScreenshot,

            `❌ XServer GAMEs 续期失败\n` +
            `账户: ${loginAccount}`

        );


    } finally {

        // ----------------------------------------------------
        // 浏览器关闭
        // ----------------------------------------------------

        await browser.close();

        console.log(
            '🔚 浏览器已关闭'
        );

    }

}


// ============================================================
// 启动
// ============================================================

main()
    .catch(error => {

        console.error(
            '❌ 程序未捕获异常:',
            error
        );

        process.exitCode = 1;

    });
