# WechatDailyNotice - 微信每日消息推送系统

一个功能强大的微信每日消息推送系统，基于 Node.js 和 WxPusher 实现。支持天气预报、生活指数、热点新闻、财经数据、历史上的今天等多种信息的聚合与展示，并采用现代化的 HTML/CSS 设计，提供极佳的移动端阅读体验。

## ✨ 主要功能

- **☀️ 智能天气**: 集成和风天气与 60s 聚合数据，提供实时天气、7天预报、分钟级降水预警、极端天气预警。
- **📊 可视化设计**: 包含动态日出日落图、天气轮播卡片、扇形导航菜单等交互式组件。
- **🔥 实时热点**: 聚合抖音、微博、B站、知乎、小红书等全网热搜榜单，支持点击跳转。
- **💰 财经资讯**: 实时汇率、黄金/白银价格、各地油价及涨跌趋势。
- **📰 新闻资讯**: 60秒读懂世界、AI 行业快报、摸鱼日报（含节假日倒计时）。
- **📅 每日宜忌**: 包含黄历、星座运势、一言金句。
- **🍗 特色彩蛋**: 肯德基疯狂星期四文案自动检测与推送。
- **⏰ 智能调度**: 根据时间段（早安/午间/晚间）自动调整推送内容的侧重点。

## 🛠️ 技术栈

- **Runtime**: Node.js
- **Network**: Axios
- **Crypto**: Jose (用于 JWT 签名)
- **Tooling**: HTML Minifier (压缩推送内容)
- **Service**: WxPusher (微信推送通道)

## 🚀 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量

项目依赖多个外部 API，请确保配置以下环境变量。你可以直接修改 `scripts/config.js` 或在运行环境设置。

| 变量名 | 说明 | 必填 |
|--------|------|------|
| `WXPUSHER_APP_TOKEN` | WxPusher 应用 Token | ✅ |
| `HEFENG_API_HOST` | 和风天气 API 地址 | ✅ |
| `HEFENG_PROJECT_ID` | 和风天气 Project ID | ✅ |
| `HEFENG_KEY_ID` | 和风天气 Key ID | ✅ |
| `HEFENG_PRIVATE_KEY` | 和风天气私钥 (PKCS8) | ✅ |
| `TANSHU_API_KEY` | 探数数据 API Key | ✅ |

### 3. 运行推送

**手动触发:**

```bash
npm run send
```

**定时任务触发:**

```bash
npm run send -- true
```
*注意: 带上 `true` 参数会被识别为定时任务模式，脚本会根据当前时间自动选择推送模式（早/中/晚）。*

## 📂 项目结构

```
WechatDailyNotice/
├── scripts/
│   ├── config.js          # 全局配置文件 (API Key, 开关等)
│   ├── send-message.js    # 主程序入口，包含所有逻辑
│   └── generate-token.js  # Token 生成工具 (内部调用)
├── data/                  # 本地数据缓存 (Token, 历史数据等)
├── APIS.api               # 接口文档
├── LICENSE                # 授权协议
└── package.json           # 项目依赖配置
```

## ⚙️ 详细配置

在 `scripts/config.js` 中可以精细控制各个模块的开关：

```javascript
SHOW_MODULES: {
    WEATHER: true,      // 天气模块
    HISTORY: true,      // 历史上的今天
    GOLD: true,         // 金价
    HOT_LIST: {         // 各大平台热榜开关
        DOUYIN: true,
        WEIBO: true,
        // ...
    },
    // ...
}
```

## 📱 推送模式

脚本内置了三种推送模式，根据服务器时间自动判断：

1.  **早安推送 (Morning)**: 00:00 - 10:00
    - 重点: 详细天气、60秒新闻、一言、Bing壁纸
2.  **午间推送 (Midday)**: 10:00 - 14:00
    - 重点: 财经数据 (金价/汇率/油价)、历史上的今天、AI 资讯
3.  **晚间推送 (Evening)**: 14:00 - 24:00
    - 重点: 全网热搜榜单 (吃瓜时间)、次日天气预告

## 📝 License

本项目采用 [MIT License](LICENSE) 授权。
