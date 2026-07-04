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
npm ci
```

开发时需要更新依赖可使用 `npm install`；复现 CI 环境建议优先使用 `npm ci`。

### 2. 配置环境变量

项目依赖多个外部 API。实际发送必须配置 WxPusher；天气增强、探数财经等模块可按需配置，缺失时脚本会跳过或降级对应非关键内容。

| 变量名 | 说明 | 必填 |
|--------|------|------|
| `WXPUSHER_APP_TOKEN` | WxPusher 应用 Token；真实发送时必需，预览模式不需要 | ✅（发送时） |
| `WXPUSHER_UID` | 固定收件人 UID；配置后优先使用，避免依赖本地 UID 缓存或 UID API | 可选 |
| `HEFENG_API_HOST` | 和风天气 API 地址；用于分钟级降水和天气预警 | 可选 |
| `HEFENG_PROJECT_ID` | 和风天气 Project ID | 可选 |
| `HEFENG_KEY_ID` | 和风天气 Key ID | 可选 |
| `HEFENG_PRIVATE_KEY` | 和风天气私钥 (PKCS8) | 可选 |
| `HEFENG_TOKEN_CACHE_FILE` | 和风 JWT 缓存路径；CI 默认写入 runner 临时目录 | 可选 |
| `WXPUSHER_UID_CACHE_FILE` | 本地 UID 缓存路径；CI 默认写入 runner 临时目录 | 可选 |
| `TANSHU_API_KEY` | 探数数据 API Key；用于油价、白银等探数模块 | 可选 |

### 3. 运行推送

**手动触发发送:**

```bash
npm run send
```

本地手动发送会优先读取 `WXPUSHER_UID` 环境变量；未设置时再从本地 UID 缓存（默认 `data/latest_uid.json`，可用 `WXPUSHER_UID_CACHE_FILE` 覆盖；CI 中默认写入 runner 临时目录）读取收件人 UID。该缓存属于本地运行态文件，不再提交到仓库；如果需要强制从 UID API 获取，可运行：

```bash
FETCH_LATEST_UID=true npm run send
```

GitHub Actions 可配置 `WXPUSHER_UID` secret 作为固定收件人；未配置时，定时任务和手动真实发送会尝试从 UID API 获取。

**定时任务触发:**

```bash
npm run send -- true
```
*注意: 带上 `true` 参数会被识别为定时任务模式。GitHub Actions 会传入触发的 cron，脚本据此锁定早/中/晚；本地未指定时才按当前北京时间自动判断。*

**本地预览（不发送）:**

```bash
npm run preview
```

也可以固定预览某个定时推送模式，避免受当前时间影响；这些脚本会模拟定时任务模块开关，但仍然不会发送：

```bash
npm run preview:morning
npm run preview:midday
npm run preview:evening
```

预览模式会正常拉取数据、构建并压缩 HTML，但不会获取真实 UID，也不会调用 WxPusher 发送。预览产物会写入 `dist/`：

- `*.html`: 未压缩 HTML
- `*.min.html`: 压缩后 HTML
- `*.report.json`: 任务摘要、HTML 长度、失败接口等

默认不写出完整原始接口数据，避免预览 artifact 暴露第三方响应细节；如需排查，可设置 `DEBUG_RAW_DATA=true` 额外生成 `*.raw-data.json`。

GitHub Actions 手动触发默认 `dry_run=true`，会上传 `dist/` 预览产物并跳过发送；确认内容无误后再选择 `dry_run=false` 真实发送。

**语法检查:**

```bash
npm test
```

`npm test` 只执行脚本语法检查，不会发送消息。

## 📂 项目结构

```
WechatDailyNotice/
├── .github/workflows/
│   └── daily-message.yml # GitHub Actions 定时/手动推送流程
├── scripts/
│   ├── config.js          # 全局配置文件 (API Key, 开关等)
│   ├── utils.js           # 日志脱敏等共享工具
│   ├── send-message.js    # 主程序入口，包含所有逻辑
│   └── generate-token.js  # Token 生成工具 (内部调用)
├── data/                  # 本地运行缓存和历史数据（token/UID 缓存不提交）
├── dist/                  # 本地/CI 预览产物（不提交）
├── APIS.api               # 接口文档
├── LICENSE                # 授权协议
├── package-lock.json      # 锁定依赖版本
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

脚本内置三种推送模式。GitHub Actions 定时任务会根据触发的 cron 表达式锁定模式，因此即使 Actions 延迟启动，也不会因为实际启动时间变晚而误判为其他模式：

| 触发时间（北京时间） | cron（UTC） | 模式 |
|---:|---|---|
| 07:15 | `15 23 * * *` | `morning` 早安推送 |
| 10:30 | `30 2 * * *` | `midday` 午间推送 |
| 16:20 | `20 8 * * *` | `evening` 晚间推送 |

本地普通 `npm run preview` 使用 `scripts/config.js` 中的默认模块开关；GitHub Actions 定时任务、手动选择 `run_mode` 或本地显式设置 `RUN_MODE` 时，会应用对应的早/中/晚模块开关。

1.  **早安推送 (Morning)**: 00:00 - 10:00
    - 重点: 详细天气、60秒新闻、一言、Bing壁纸
2.  **午间推送 (Midday)**: 10:00 - 14:00
    - 重点: 财经数据 (金价/汇率/油价)、历史上的今天、AI 资讯
3.  **晚间推送 (Evening)**: 14:00 - 24:00
    - 重点: 全网热搜榜单 (吃瓜时间)、次日天气预告

如需手动指定模式，可使用 npm 预览脚本、环境变量或 CLI 参数。显式指定模式时会应用对应的模块开关：

```bash
npm run preview:morning
RUN_MODE=morning npm run preview
node scripts/send-message.js false --dry-run --run-mode=evening
```

## 📝 License

本项目采用 [MIT License](LICENSE) 授权。
