require('dotenv').config();
const {Telegraf} = require('telegraf');
const axios = require('axios');
const crypto = require('crypto');
const moment = require('moment-timezone');

// Проверка переменных окружения
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const BYBIT_API_KEY = process.env.BYBIT_API_KEY;
const BYBIT_API_SECRET = process.env.BYBIT_API_SECRET;
const ALLOWED_BALANCE_USER_IDS = process.env.ALLOWED_BALANCE_USER_IDS?.split(',').map(id => id.trim()) || [];
const ALLOWED_POSITION_USER_IDS = process.env.ALLOWED_POSITION_USER_IDS?.split(',').map(id => id.trim()) || [];
const PRIME_ID = process.env.PRIME_ID;

if (!BOT_TOKEN || !BYBIT_API_KEY || !BYBIT_API_SECRET) {
    console.error('❌ Отсутствуют переменные окружения! Проверьте .env файл');
    process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// ========================
// Bybit API функции (полностью переработанные)
// ========================

const hours = moment().tz('Europe/Moscow').hour();

const formaterValue = (balance, value) => {
    if (hours > 18) {
        if (value <= (balance * .2)) {
            return `✅ Объем в $: ${value}`
        } else if (value > (balance * .2)) {
            return `🔴️ Объем в $: ${value}`
        }
    } else {
        if (value <= (balance)) {
            return `✅ Объем в $: ${value}`
        } else if (value > (balance) && value <= (balance * 2)) {
            return `⚠️ Объем в $: ${value}`
        } else if (value > (balance * 2)) {
            return `🔴️ Объем в $: ${value}`
        }
        return `Объем в $: ${value}`
    }
}

/**
 * Генерирует подпись для Bybit API V5
 */
function generateSignatureV5(apiSecret, timestamp, recvWindow, params) {
    const orderedParams = Object.keys(params)
        .sort()
        .reduce((obj, key) => {
            obj[key] = params[key];
            return obj;
        }, {});

    const queryString = new URLSearchParams(orderedParams).toString();
    const signString = timestamp + BYBIT_API_KEY + recvWindow + queryString;

    return crypto
        .createHmac('sha256', apiSecret)
        .update(signString)
        .digest('hex');
}

// Проверка доступа для баланса
function checkAccessBalance(ctx) {
    if (ALLOWED_BALANCE_USER_IDS.length === 0) return false; // если список пустой, доступ закрыт
    return ALLOWED_BALANCE_USER_IDS.includes(String(ctx.from.id));
}

// Проверка доступа для сделок
function checkAccessPosition(ctx) {
    if (ALLOWED_POSITION_USER_IDS.length === 0) return false; // если список пустой, доступ закрыт
    return ALLOWED_POSITION_USER_IDS.includes(String(ctx.from.id));
}

// Функцию получения закрытых сделок
async function getClosedPnl(params = {}) {
    try {
        const data = await callBybitAPI('position/closed-pnl', {
            category: 'linear',
            settleCoin: 'USDT',
            ...params
        });

        if (!Array.isArray(data?.list)) {
            throw new Error('Invalid closed pnl data format');
        }

        return data.list.map(trade => ({
            symbol: trade.symbol || 'N/A',
            side: trade.side || 'N/A',
            qty: parseFloat(trade.size || 0),
            entry: parseFloat(trade.entryPrice || 0),
            exit: parseFloat(trade.exitPrice || 0),
            pnl: parseFloat(trade.closedPnl || 0),
            createdTime: new Date(parseInt(trade.createdTime || 0)),
            updatedTime: new Date(parseInt(trade.updatedTime || 0))
        }));
    } catch (error) {
        console.error('Closed PnL error:', error);
        throw new Error(`Failed to get closed pnl: ${error.message}`);
    }
}

// Функция для формирования сообщения со статистикой
async function generateStatsMessage(period) {
    const now = new Date();
    let startDate, endDate, periodName;

    switch (period) {
        case 'today':
            startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
            periodName = 'Сегодня';
            break;
        case 'yesterday':
            startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
            endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            periodName = 'Вчера';
            break;
        case 'week':
            startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay());
            endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
            periodName = 'Неделя';
            break;
        default:
            throw new Error('Unknown period');
    }

    const allTrades = await getClosedPnl();
    const periodTrades = allTrades.filter(t =>
        t.updatedTime >= startDate && t.updatedTime < endDate
    );

    const totalPnl = periodTrades.reduce((sum, trade) => sum + trade.pnl, 0);
    const pnlIcon = totalPnl >= 0 ? '🟢' : '🔴';

    let message = `📊 <b>Статистика за ${periodName.toLowerCase()}</b>\n\n`;
    message += `${pnlIcon} Суммарный PnL: ${totalPnl.toFixed(2)} USDT\n`;
    message += `🔢 Количество сделок: ${periodTrades.length}\n\n`;

    if (periodTrades.length > 0) {
        message += '<b>Последние сделки:</b>\n';
        periodTrades.slice(0, 5).forEach((trade, i) => {
            const tradeIcon = trade.pnl >= 0 ? '✅' : '❌';
            message += `${i + 1}. ${tradeIcon} ${trade.symbol} ${trade.side} - ${trade.pnl.toFixed(2)} USDT\n`;
        });
    } else {
        message += 'Нет сделок за этот период\n';
    }

    return message;
}

/**
 * Универсальный запрос к Bybit API V5
 */
async function callBybitAPI(endpoint, params = {}) {
    const timestamp = Date.now().toString();
    const recvWindow = '5000';

    // Удаляем пустые параметры
    const cleanParams = Object.fromEntries(
        Object.entries(params).filter(([_, v]) => v !== undefined && v !== null)
    );

    try {
        const response = await axios({
            method: 'get',
            url: `https://api.bybit.com/v5/${endpoint}`,
            params: cleanParams,
            headers: {
                'X-BAPI-API-KEY': BYBIT_API_KEY,
                'X-BAPI-TIMESTAMP': timestamp,
                'X-BAPI-RECV-WINDOW': recvWindow,
                'X-BAPI-SIGN': generateSignatureV5(BYBIT_API_SECRET, timestamp, recvWindow, cleanParams),
                'Content-Type': 'application/json'
            },
            timeout: 10000
        });

        if (response.data.retCode !== 0) {
            throw new Error(response.data.retMsg || `API error: ${JSON.stringify(response.data)}`);
        }

        return response.data.result;
    } catch (error) {
        console.error(`Bybit API Error (${endpoint}):`, {
            params,
            error: error.response?.data || error.message
        });
        throw new Error(`API request failed: ${error.message}`);
    }
}

/**
 * Получает баланс USDT
 */
async function getUSDTBalance() {
    try {
        const data = await callBybitAPI('account/wallet-balance', {
            accountType: 'UNIFIED',
            coin: 'USDT'
        });


        // Глубокая проверка структуры ответа
        const account = data?.list?.[0];

        if (!account) throw new Error('No accounts found');

        const balance = account?.totalEquity;

        return Number(balance);
    } catch (error) {
        console.error('Balance error:', error);
        throw new Error(`Failed to get balance: ${error.message}`);
    }
}

/**
 * Получает открытые позиции
 */
async function getOpenPositions() {
    try {
        const data = await callBybitAPI('position/list', {
            category: 'linear',
            settleCoin: 'USDT'
        });

        if (!Array.isArray(data?.list)) {
            throw new Error('Invalid positions data format');
        }

        return data.list
            .filter(pos => parseFloat(pos?.size || 0) > 0)
            .map(pos => ({
                symbol: pos.symbol || 'N/A',
                side: pos.side || 'N/A',
                size: parseFloat(pos.size || 0),
                entry: parseFloat(pos.avgPrice || 0),
                pnl: parseFloat(pos.unrealisedPnl || 0),
                leverage: parseFloat(pos.leverage || 1),
                liqPrice: parseFloat(pos.liqPrice || 0)
            }));
    } catch (error) {
        console.error('Positions error:', error);
        throw new Error(`Failed to get positions: ${error.message}`);
    }
}

// ========================
// Telegram бот (остается без изменений)
// ========================

const mainKeyboard = {
    reply_markup: {
        keyboard: [
            ['🔄 Просмотр Баланса и позиции'],
            ['💰 Баланс USDT', 'ℹ️ Инфо'],
            ['📊 Мои позиции', '📊 Статистика']
        ],
        resize_keyboard: true
    }
};

// 2. Добавим клавиатуру для статистики
// const statsKeyboard = {
//     reply_markup: {
//         keyboard: [
//             ['📊 Статистика: Сегодня'],
//             ['📊 Статистика: Вчера'],
//             ['📊 Статистика: Неделя'],
//             ['🔙 Назад']
//         ],
//         resize_keyboard: true
//     }
// };

const formateSizeDollars = (size, entry) => (size * entry).toFixed(2);

bot.start(ctx => {
    if (!checkAccessBalance(ctx) && !checkAccessPosition(ctx)) {
        ctx.reply( `Привет господин ${ctx.from.first_name}! Я твой Bybit bot монитор. но пока у тебя нет прав, но ты можешь обратиться за правами к админу @ftwlool`)
    } else {
        if(ctx.from.id == PRIME_ID) {
            ctx.reply( `Привет госпожа и самая милейшая булочка ${ctx.from.first_name}! Я твой Bybit bot монитор.`, mainKeyboard)
        } else {
            ctx.reply( `Привет господин ${ctx.from.first_name}! Я твой Bybit bot монитор.`, mainKeyboard)
        }
    }
});

bot.hears('📊 Статистика', async (ctx) => {
    await ctx.reply('⛔ Нахуй эту функцию');
});

bot.hears('💰 Баланс USDT', async ctx => {
    if (!checkAccessBalance(ctx)) {
        return ctx.reply('⛔ Доступ запрещен');
    }

    try {
        await ctx.reply('💵 Доступно: 282.65 USDT');
        // const balance = await getUSDTBalance();
        // await ctx.reply(`💵 Доступно: ${balance.toFixed(2)} USDT`);
    } catch (error) {
        await ctx.reply('❌ Ошибка при получении баланса');
        console.error('Balance error:', error);
    }
});

bot.hears('📊 Мои позиции', async ctx => {
    if (!checkAccessPosition(ctx)) {
        return ctx.reply('⛔ Доступ запрещен');
    }

    try {
        await ctx.reply('🔎 Нет открытых позиций');
        // const positions = await getOpenPositions();
        //
        // if (positions.length === 0) {
        //     return await ctx.reply('🔎 Нет открытых позиций');
        // }
        //
        // let message = '📈 Ваши позиции:\n\n';
        // positions.forEach(pos => {
        //     const pnlIcon = pos.pnl >= 0 ? '🟢' : '🔴';
        //     message += `▫️ <b><a href="${formateUrl(pos.symbol)}">${pos.symbol}</a></b> (${pos.side})\n` +
        //         `  Объем: ${pos.size.toFixed(4)}\n` +
        //         `  Объем в $: ${formateSizeDollars(pos.size, pos.entry)}\n` +
        //         `  Вход: ${pos.entry}\n` +
        //         `  PnL: ${pnlIcon} ${pos.pnl.toFixed(2)} USDT\n` +
        //         `  Плечо: ${pos.leverage.toFixed(1)}x\n` +
        //         `  Ликвидация: ${pos.liqPrice}\n\n`;
        // });
        //
        // await ctx.reply(message, {parse_mode: 'HTML', disable_web_page_preview: true});
    } catch (error) {
        await ctx.reply('❌ Ошибка при получении позиций');
        console.error('Positions error:', error);
    }
});

bot.hears('ℹ️ Инфо', async ctx => {
    if (!checkAccessPosition(ctx)) {
        return ctx.reply('⛔ Доступ запрещен');
    }

    try {
        const balance = await getUSDTBalance();

    //      📊 *1. Контроль объема позиции*
    //     - ✅ *Норма*:
    //     Объем ≤ 1x баланса (💰${balance.toFixed(1)})
    //
    //     - ⚠️ *Предупреждение*:
    //     Объем > 1x (💰${balance.toFixed(1)}),
    //     до ≤ 2x (💰${(balance * 2).toFixed(1)})
    //
    //     - 🔴 *Стоп-торговля*:
    //     Объем > 2x (💰${(balance * 2).toFixed(1)})
    //
    //
    // 🔻 *2. Лимит убытков*
    //     - При падении баланса на -20%
    //     писать и останавливать торговлю
    //     или переводить в безопасный режим,
    //         как при ночной торговли объем ≤ 0.5x баланса (💰${(balance * 0.2).toFixed(1)}).
    //
    //
    // 🌙 *3. Ночной режим (19:00 – 05:00)*
    //     - ❌ Торговля запрещена.
    //     - *Исключение*: если объем ≤ 0.5x баланса (💰${(balance * 0.2).toFixed(1)}).

        const rulesMessage = `
        🔹 *Правила управления торговлей* 🔹  
            
       📊 *1. Контроль объема позиции*  
          - ✅ *Норма*: 
              Объем ≤ 1x баланса (💰282.7)
                
          - ⚠️ *Предупреждение*: 
              Объем > 1x (💰282.7), 
              до ≤ 2x (💰565.3) 
                
          - 🔴 *Стоп-торговля*: 
              Объем > 2x (💰565.3)
            
                
       🔻 *2. Лимит убытков*  
          - При падении баланса на -20%
            писать и останавливать торговлю 
            или переводить в безопасный режим,
            как при ночной торговли объем ≤ 0.5x баланса (💰56.5).
            
            
       🌙 *3. Ночной режим (19:00 – 05:00)*  
          - ❌ Торговля запрещена.  
          - *Исключение*: если объем ≤ 0.5x баланса (💰56.5).
            
            
       📌 *Доп. правила безопасности*:  
          - 🔸 Трейлинг-стоп (стоп профит) при прибыли *≥3%*.  
          - 🔸 Фиксация части прибыли при *+10%*.  
          - 🔸 Стоп при резких скачках цены (*>5% за 5 мин*).  
          - 🔸 Плечо *>10x* → предупреждение.  
          - 🔸 Если за день сделал плюс больше 20%-30%,
               снижается объем позиции в два раза, 
               чтоб успокоить нервы и эмоции 
                
       ⚠️ Уведомлять и стараться так же контролировать плечо,
          чтоб я ставил стоп лось, 
          тем более если позиция торгуется сильно в минус
          долгое время. 🌸
           `;

        await ctx.reply(rulesMessage);
    } catch (error) {
        await ctx.reply('❌ Ошибка при получении баланса');
        console.error('Balance error:', error);
    }
});

// Обработчики для периодов статистики
// bot.hears('📊 Статистика: Сегодня', async (ctx) => {
//     if (!checkAccessBalance(ctx)) {
//         return ctx.reply('⛔ Доступ запрещен');
//     }
//
//     try {
//         const message = await generateStatsMessage('today');
//         await ctx.reply(message, {
//             parse_mode: 'HTML',
//             reply_markup: statsKeyboard.reply_markup
//         });
//     } catch (error) {
//         await ctx.reply('❌ Ошибка при получении статистики за сегодня');
//         console.error('Today stats error:', error);
//     }
// });

// bot.hears('📊 Статистика: Вчера', async (ctx) => {
//     if (!checkAccessBalance(ctx)) {
//         return ctx.reply('⛔ Доступ запрещен');
//     }
//
//     try {
//         const message = await generateStatsMessage('yesterday');
//         await ctx.reply(message, {
//             parse_mode: 'HTML',
//             reply_markup: statsKeyboard.reply_markup
//         });
//     } catch (error) {
//         await ctx.reply('❌ Ошибка при получении статистики за вчера');
//         console.error('Yesterday stats error:', error);
//     }
// });

// bot.hears('📊 Статистика: Неделя', async (ctx) => {
//     if (!checkAccessBalance(ctx)) {
//         return ctx.reply('⛔ Доступ запрещен');
//     }
//
//     try {
//         const message = await generateStatsMessage('week');
//         await ctx.reply(message, {
//             parse_mode: 'HTML',
//             reply_markup: statsKeyboard.reply_markup
//         });
//     } catch (error) {
//         await ctx.reply('❌ Ошибка при получении недельной статистики');
//         console.error('Week stats error:', error);
//     }
// });

const formateUrl = (name) => {
    return `https://www.bybit.com/trade/usdt/${name}`
}


bot.hears('🔄 Просмотр Баланса и позиции', async ctx => {
    if (!checkAccessBalance(ctx) && !checkAccessPosition(ctx)) {
        return ctx.reply('⛔ Доступ запрещен');
    }

    try {

        const message = `💵 Баланс: 282.63 USDT

🔎 Нет открытых позиций`;

        await ctx.reply(message, {parse_mode: 'HTML', disable_web_page_preview: true});

        // const [balance, positions] = await Promise.all([
        //     getUSDTBalance(),
        //     getOpenPositions()
        // ]);
        //
        // let message = `💵 Баланс: ${balance.toFixed(2)} USDT\n\n`;
        //
        // if (positions.length > 0) {
        //
        //     if (hours > 19) {
        //         message += `🌙 - Режим\n \n 📊 Позиции:\n`;
        //     } else {
        //         message += '📊 Позиции:\n';
        //     }
        //     positions.forEach(pos => {
        //         const pnlIcon = pos.pnl >= 0 ? '🟢' : '🔴';
        //         message += `\n▫️ <b><a href="${formateUrl(pos.symbol)}">${pos.symbol}</a></b> (${pos.side})` +
        //             `\n  PnL: ${pnlIcon} ${pos.pnl.toFixed(2)}` +
        //             `\n  ${formaterValue(balance, formateSizeDollars(pos.size, pos.entry))}\n`
        //     });
        // } else {
        //     message += '🔎 Нет открытых позиций';
        // }
        //
        // await ctx.reply(message, {parse_mode: 'HTML', disable_web_page_preview: true});
    } catch (error) {
        await ctx.reply('❌ Ошибка при обновлении данных');
        console.error('Update error:', error);
    }
});

//  Обработчик кнопки "Назад"
bot.hears('🔙 Назад', async (ctx) => {
    await ctx.reply('Главное меню:', mainKeyboard);
});

bot.launch()
    .then(() => console.log('🤖 Бот запущен'))
    .catch(err => console.error('🚨 Ошибка запуска:', err));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));