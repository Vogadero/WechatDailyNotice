# 项目优化说明

## 已完成的优化

### 1. 包管理器冲突解决
- **问题**: 项目同时存在 `package-lock.json` 和 `pnpm-lock.yaml`，导致依赖管理冲突
- **解决方案**: 
  - 删除 `pnpm-lock.yaml` 文件
  - 统一使用 npm 作为包管理器
  - 更新 GitHub Actions 配置使用 `npm ci` 安装依赖

### 2. API 调用优化（v2 - 并发限制器）
- **问题**: 原方案使用 `ApiQueue` 按域名串行排队请求，同域名 10+ 个接口排队执行（每个间隔 1s），导致总耗时极长，HTML 组装时数据还未返回
- **解决方案**:
  - 将 `ApiQueue` 串行队列替换为 `ConcurrencyLimiter` 全局并发限制器
  - 同一时刻最多 5 个请求并发执行（可配置），不同域名和同域名均可并行
  - 保留 `axiosWithRetry` 指数退避重试机制不变
  - 增大 `safeAsyncCall` 默认超时从 15s 到 25s
  - 增大热点榜单类接口超时从 20s 到 30s

### 3. NEWS_60S 跑马灯动画优化
- **问题**: 滚动动画重新开始时有卡顿和漂移感
- **解决方案**:
  - 移除重复内容的 DOM 结构
  - 使用 `transform3d` 开启硬件加速
  - 添加 CSS `mask` 属性创建渐变遮罩效果
  - 优化动画时间函数使用 `cubic-bezier` 缓动
  - 在动画末尾瞬间重置位置，配合遮罩实现无缝循环

## 技术细节

### API 并发限制管理
```javascript
class ConcurrencyLimiter {
  constructor(maxConcurrency = 5) {
    this.maxConcurrency = maxConcurrency;
    this.running = 0;
    this.queue = [];
  }

  async run(fn) {
    while (this.running >= this.maxConcurrency) {
      await new Promise(resolve => this.queue.push(resolve));
    }
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      if (this.queue.length > 0) this.queue.shift()();
    }
  }
}
```

### 重试机制
```javascript
async function axiosWithRetry(config, maxRetries = 3, baseDelay = 1000) {
  // 指数退避重试策略
  // 1秒 -> 2秒 -> 4秒 + 随机延迟
}
```

### 4. 并发调度优化（v2）
- **问题**: `ApiQueue` 按域名串行排队，导致 viki.moe 域名下 10+ 个接口逐个执行，总耗时过长
- **解决方案**:
  - 替换为 `ConcurrencyLimiter`（全局信号量模式）
  - 最多 5 个请求同时执行，完成一个立即补上下一个
  - 超时时间全面上调（默认 25s，热榜 30s）
  - 预期效果：晚间模式 10 个热榜接口从 ~30s 降至 ~6-8s

### 动画优化
```css
.n60-scroll { 
  animation: scrollUpSmooth 60s cubic-bezier(0.25, 0.46, 0.45, 0.94) infinite;
  padding-bottom: 300px; /* 确保内容足够高 */
}

.n60-cnt {
  mask: linear-gradient(to bottom, transparent 0%, black 10%, black 90%, transparent 100%);
  /* 遮罩隐藏顶部和底部的内容切换 */
}
```

## 性能提升

1. **网络请求稳定性**: 重试机制减少因网络波动导致的失败
2. **服务器友好**: 请求间隔避免对 API 服务器造成压力
3. **用户体验**: 平滑的动画效果，无卡顿感
4. **依赖管理**: 统一包管理器，避免版本冲突

## 使用建议

1. 如需调整 API 请求间隔，修改 `ApiQueue` 中的 `defaultDelay`
2. 如需调整重试次数，修改 `axiosWithRetry` 的 `maxRetries` 参数
3. 动画速度可通过修改 CSS 中的 `60s` 来调整

## 监控建议

建议在生产环境中添加以下监控：
- API 请求成功率统计
- 重试次数统计
- 响应时间监控
- 错误日志收集