const path = require('path');

const CONFIG = {
    // 和风天气配置
    HEFENG_API_HOST: process.env.HEFENG_API_HOST,
    HEFENG_PRIVATE_KEY: process.env.HEFENG_PRIVATE_KEY,
    HEFENG_KEY_ID: process.env.HEFENG_KEY_ID,
    HEFENG_PROJECT_ID: process.env.HEFENG_PROJECT_ID,

    // 其他配置
    WXPUSHER_APP_TOKEN: process.env.WXPUSHER_APP_TOKEN || 'AT_5JhPdnTymxUtSR1sMxRMqSoKPJhXhL56',
    LOCATION: '余杭',
    WEATHER_API_BASE: 'https://60s.viki.moe/v2',
    KFC_API: 'https://60s.viki.moe/v2/kfc',
    LUCK_API: 'https://60s.viki.moe/v2/luck',
    HISTORY_API: 'https://60s.viki.moe/v2/today-in-history',
    EXCHANGE_API: 'https://60s.viki.moe/v2/exchange-rate',
    AI_NEWS_API: 'https://60s.viki.moe/v2/ai-news',
    GOLD_API: 'https://60s.viki.moe/v2/gold-price',
    FUEL_API: 'https://60s.viki.moe/v2/fuel-price',
    MOYU_API: 'https://60s.viki.moe/v2/moyu',
    NEWS_60S_API: 'https://60s.viki.moe/v2/60s',
    REDNOTE_API: 'https://60s.viki.moe/v2/rednote',
    WEIBO_API: 'https://60s.viki.moe/v2/weibo',
    TOUTIAO_API: 'https://60s.viki.moe/v2/toutiao',
    ZHIHU_API: 'https://60s.viki.moe/v2/zhihu',
    MAOYAN_MOVIE_API: 'https://60s.viki.moe/v2/maoyan/realtime/movie',
    MAOYAN_TV_API: 'https://60s.viki.moe/v2/maoyan/realtime/tv',
    MAOYAN_WEB_API: 'https://60s.viki.moe/v2/maoyan/realtime/web',
    DOUYIN_API: 'https://60s.viki.moe/v2/douyin',
    BILI_API: 'https://60s.viki.moe/v2/bili',
    QUARK_API: 'https://60s.viki.moe/v2/quark',
    BAIDU_HOT_API: 'https://60s.viki.moe/v2/baidu/hot',
    BAIDU_TELEPLAY_API: 'https://60s.viki.moe/v2/baidu/teleplay',
    BAIDU_TIEBA_API: 'https://60s.viki.moe/v2/baidu/tieba',
    DONGCHEDI_API: 'https://60s.viki.moe/v2/dongchedi',
    BING_API: 'https://60s.viki.moe/v2/bing',
    UID_API: 'https://eob7gu4tu9r7a8s.m.pipedream.net',
    HITOKOTO_API: 'https://v1.hitokoto.cn',
    WXPUSHER_API: 'https://wxpusher.zjiecode.com/api/send/message',
    LOCATION_LON: '119.97874',
    LOCATION_LAT: '30.27371',

    // Token缓存文件
    TOKEN_CACHE_FILE: path.join(__dirname, '../data/hefeng_token.json'),

    // Token提前刷新时间（秒）
    TOKEN_REFRESH_BEFORE_EXPIRE: 300, // 提前5分钟刷新

    // 模块开关配置：控制哪些内容包含在推送中 (true开启, false关闭)
    SHOW_MODULES: {
        WEATHER: true,      // 天气（含预警、降水、轮播）
        LUCK: false,         // 运势跑马灯
        HISTORY: false,      // 历史上的今天
        GOLD: false,         // 黄金价格
        EXCHANGE: false,     // 汇率
        FUEL: false,         // 汽油价格
        MOYU: false,         // 摸鱼日报
        AI_NEWS: false,      // AI 资讯
        NEWS_60S: false,     // 60秒读懂世界
        HOT_LIST: {
            DOUYIN: false,    // 抖音
            BILI: false,      // B站
            WEIBO: false,     // 微博
            REDNOTE: false,   // 小红书
            TOUTIAO: false,   // 头条
            ZHIHU: false,     // 知乎
            QUARK: false,     // 夸克
            BAIDU: false,     // 百度
            TIEBA: false,     // 贴吧
            DONGCHEDI: false, // 懂车帝
            MOVIE: false,     // 猫眼电影
            TV: false,        // 猫眼剧集
            WEB: false        // 猫眼网剧
        },
        BING_WALLPAPER: true,// Bing每日壁纸
        yiYan: true,        // 一言
        KFC: true           // 疯狂星期四（仍需满足周四条件）
    }
};

module.exports = CONFIG;
