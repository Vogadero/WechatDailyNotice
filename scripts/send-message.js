// send-message.js
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const minify = require('html-minifier').minify;

// 命令行参数
const cliArgs = process.argv.slice(2);

function isTruthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase());
}

function getBooleanCliFlag(args, name) {
  const flag = `--${name}`;
  const prefix = `${flag}=`;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === flag) {
      const nextArg = args[i + 1];
      if (nextArg === 'true' || nextArg === 'false') {
        return nextArg === 'true';
      }
      return true;
    }
    if (arg.startsWith(prefix)) {
      return isTruthy(arg.slice(prefix.length));
    }
  }

  return false;
}

function getCliOption(args, name) {
  const flag = `--${name}`;
  const prefix = `${flag}=`;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === flag) {
      return args[i + 1] || '';
    }
    if (arg.startsWith(prefix)) {
      return arg.slice(prefix.length);
    }
  }

  return '';
}

// 从命令行第一个位置参数判断是否是定时触发，兼容原有 `node scripts/send-message.js true|false`
const positionalScheduledArg = cliArgs[0];
const isScheduled = positionalScheduledArg === 'true'
  || (!['true', 'false'].includes(positionalScheduledArg) && isTruthy(process.env.IS_SCHEDULED));

// 预览模式：拉取数据并生成 HTML，但不发送 WxPusher
const isDryRun = getBooleanCliFlag(cliArgs, 'dry-run') || getBooleanCliFlag(cliArgs, 'preview') || isTruthy(process.env.DRY_RUN);

// 是否主动从 UID API 获取收件人。定时任务默认获取；GitHub Actions 手动真实发送可通过 FETCH_LATEST_UID=true 获取。
const shouldFetchLatestUid = isScheduled || isTruthy(process.env.FETCH_LATEST_UID);

const RUN_MODE_NAMES = {
  morning: '早安推送',
  midday: '午间推送',
  evening: '晚间推送'
};
const rawRequestedRunMode = getCliOption(cliArgs, 'run-mode') || process.env.RUN_MODE || '';
const hasRunModeOverride = Boolean(rawRequestedRunMode);
const requestedRunMode = rawRequestedRunMode === 'auto' ? '' : rawRequestedRunMode;

const MAX_WXPUSHER_CONTENT_LENGTH = 40000;
const PREVIEW_OUTPUT_DIR = path.join(__dirname, '../dist');

// 配置
const CONFIG = require('./config');

function hasHefengConfig() {
  return Boolean(
    CONFIG.HEFENG_API_HOST
    && CONFIG.HEFENG_PRIVATE_KEY
    && CONFIG.HEFENG_KEY_ID
    && CONFIG.HEFENG_PROJECT_ID
  );
}

// 动态导入 jose 库（ESM）
let jose;
async function importJose() {
  if (!jose) {
    jose = await import('jose');
  }
  return jose;
}

// 添加延迟函数
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 带重试的 axios 请求函数
async function axiosWithRetry(config, maxRetries = 3, baseDelay = 1000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await axios(config);
      return response;
    } catch (error) {
      console.warn(`请求失败 (尝试 ${attempt}/${maxRetries}):`, error.message);
      
      if (attempt === maxRetries) {
        throw error;
      }
      
      // 指数退避延迟
      const delayTime = baseDelay * Math.pow(2, attempt - 1) + Math.random() * 1000;
      console.log(`等待 ${Math.round(delayTime)}ms 后重试...`);
      await delay(delayTime);
    }
  }
}

// 安全的 Promise 包装器，确保异步操作不会无限期阻塞后续流程
async function safeAsyncCall(asyncFn, name, timeout = 25000) {
  let timeoutTimer;
  try {
    const timeoutPromise = new Promise((_, reject) => {
      timeoutTimer = setTimeout(() => {
        console.warn(`${name} 已等待 ${timeout}ms，按超时失败处理...`);
        reject(new Error(`${name} 超过 ${timeout}ms 未完成`));
      }, timeout);
    });

    return await Promise.race([asyncFn(), timeoutPromise]);
  } catch (error) {
    console.error(`${name} 执行失败:`, error.message);
    return { success: false, error: error.message };
  } finally {
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
    }
  }
}

function maskSensitiveValue(value, visiblePrefix = 4, visibleSuffix = 4) {
  if (!value || typeof value !== 'string') return '';
  if (value.length <= visiblePrefix + visibleSuffix) return `${value.slice(0, visiblePrefix)}***`;
  return `${value.slice(0, visiblePrefix)}...${value.slice(-visibleSuffix)}`;
}

function maskUid(uid) {
  if (!uid || typeof uid !== 'string') return '';
  if (uid.length <= 12) return `${uid.slice(0, 3)}***`;
  return `${uid.slice(0, 8)}...${uid.slice(-4)}`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char]));
}

function sanitizeUrl(value) {
  const url = String(value || '').trim();
  if (!url) return '';

  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return escapeHtml(parsed.href);
    }
  } catch (error) {
    console.warn('忽略无效链接:', error.message);
  }

  return '';
}

function savePreviewArtifacts({ reason, htmlContent, minifiedHtml, report, dataResults }) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeReason = String(reason || 'preview').replace(/[^a-zA-Z0-9_-]/g, '-');
  const baseName = `${timestamp}-${safeReason}`;

  fs.mkdirSync(PREVIEW_OUTPUT_DIR, { recursive: true });

  const htmlPath = path.join(PREVIEW_OUTPUT_DIR, `${baseName}.html`);
  const minifiedHtmlPath = path.join(PREVIEW_OUTPUT_DIR, `${baseName}.min.html`);
  const reportPath = path.join(PREVIEW_OUTPUT_DIR, `${baseName}.report.json`);
  const rawDataPath = path.join(PREVIEW_OUTPUT_DIR, `${baseName}.raw-data.json`);

  fs.writeFileSync(htmlPath, htmlContent, 'utf8');
  fs.writeFileSync(minifiedHtmlPath, minifiedHtml, 'utf8');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  fs.writeFileSync(rawDataPath, JSON.stringify(dataResults, null, 2), 'utf8');

  return { htmlPath, minifiedHtmlPath, reportPath, rawDataPath };
}

// 并发限制器 - 允许同时进行多个请求，但限制总并发数，防止服务器压力过大
class ConcurrencyLimiter {
  constructor(maxConcurrency = 5) {
    this.maxConcurrency = maxConcurrency;
    this.running = 0;
    this.queue = [];
  }

  async run(fn) {
    // 如果已达到并发上限，排队等待
    while (this.running >= this.maxConcurrency) {
      await new Promise(resolve => this.queue.push(resolve));
    }

    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      // 唤醒队列中下一个等待的任务
      if (this.queue.length > 0) {
        this.queue.shift()();
      }
    }
  }
}

const apiLimiter = new ConcurrencyLimiter(5);

// 获取当前时间信息
function getCurrentTimeInfo() {
  // 使用 Asia/Shanghai 时区获取当前时间
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hour = String(now.getHours()).padStart(2, '0');
  const minute = String(now.getMinutes()).padStart(2, '0');
  const second = String(now.getSeconds()).padStart(2, '0');

  const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const dayOfWeek = weekdays[now.getDay()];
  const dayOfWeekNum = now.getDay();

  return {
    dateTime: `${year}/${month}/${day} ${dayOfWeek} ${hour}:${minute}:${second}`,
    dayOfWeek: dayOfWeek,
    dayOfWeekNum: dayOfWeekNum,
    isThursday: dayOfWeekNum === 4,
    hour: parseInt(hour),
    timestamp: Math.floor(now.getTime() / 1000),
    simpleDate: `${month}月${day}日`,
    time: `${hour}:${minute}:${second}`
  };
}

// 检查并获取有效的和风天气Token
async function getValidHefengToken() {
  try {
    // 检查缓存文件是否存在
    if (fs.existsSync(CONFIG.TOKEN_CACHE_FILE)) {
      const cacheData = JSON.parse(fs.readFileSync(CONFIG.TOKEN_CACHE_FILE, 'utf8'));
      const now = Math.floor(Date.now() / 1000);

      // 检查Token是否有效（提前5分钟刷新）
      if (cacheData.token && cacheData.expires_at &&
        cacheData.expires_at - CONFIG.TOKEN_REFRESH_BEFORE_EXPIRE > now) {
        console.log('✅ 使用缓存的Token');
        return cacheData.token;
      }

      console.log('🔄 Token已过期或即将过期，重新生成...');
    } else {
      console.log('🔄 未找到Token缓存文件，生成新的Token...');
    }

    // 生成新的Token
    const tokenData = await generateHefengToken();

    // 确保data目录存在
    const dataDir = path.dirname(CONFIG.TOKEN_CACHE_FILE);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    fs.writeFileSync(CONFIG.TOKEN_CACHE_FILE, JSON.stringify(tokenData, null, 2));
    console.log('✅ Token已生成并缓存');

    return tokenData.token;

  } catch (error) {
    console.error('获取Token失败:', error.message);

    // 尝试使用上次的Token（即使可能过期）
    if (fs.existsSync(CONFIG.TOKEN_CACHE_FILE)) {
      try {
        const cacheData = JSON.parse(fs.readFileSync(CONFIG.TOKEN_CACHE_FILE, 'utf8'));
        if (cacheData.token) {
          console.log('⚠️ 使用上次的Token（可能已过期）');
          return cacheData.token;
        }
      } catch (e) {
        console.error('读取缓存Token失败:', e.message);
      }
    }

    throw new Error('无法获取有效的和风天气Token');
  }
}

// 生成和风天气JWT Token
async function generateHefengToken() {
  try {
    console.log('🔑 开始生成和风天气JWT Token...');

    // 检查必要的环境变量
    if (!CONFIG.HEFENG_PRIVATE_KEY) {
      throw new Error('请设置HEFENG_PRIVATE_KEY环境变量');
    }
    if (!CONFIG.HEFENG_KEY_ID) {
      throw new Error('请设置HEFENG_KEY_ID环境变量');
    }
    if (!CONFIG.HEFENG_PROJECT_ID) {
      throw new Error('请设置HEFENG_PROJECT_ID环境变量');
    }

    // 导入jose库
    const { SignJWT, importPKCS8 } = await importJose();

    // 设置时间
    const iat = Math.floor(Date.now() / 1000) - 30; // 签发时间（减30秒）
    const exp = iat + 900; // 15分钟后过期（和风要求）

    const customHeader = {
      alg: 'EdDSA',
      kid: CONFIG.HEFENG_KEY_ID
    };

    const customPayload = {
      sub: CONFIG.HEFENG_PROJECT_ID,
      iat: iat,
      exp: exp
    };

    console.log('⚙️  JWT配置信息:');
    console.log('   Header:', JSON.stringify({ ...customHeader, kid: maskSensitiveValue(customHeader.kid) }));
    console.log('   Payload:', JSON.stringify({ ...customPayload, sub: maskSensitiveValue(customPayload.sub) }));
    console.log(`   有效期: ${(exp - iat) / 60} 分钟`);

    // 导入私钥
    console.log('📥 导入私钥...');
    const privateKey = await importPKCS8(CONFIG.HEFENG_PRIVATE_KEY, 'EdDSA');
    console.log('✅ 私钥导入成功');

    // 生成JWT
    console.log('🔐 生成签名...');
    const token = await new SignJWT(customPayload)
      .setProtectedHeader(customHeader)
      .sign(privateKey);

    console.log('🎉 JWT Token生成成功!');

    return {
      token: token,
      generated_at: iat,
      expires_at: exp,
      created_at: new Date().toISOString()
    };

  } catch (error) {
    console.error('生成JWT Token失败:', error.message);
    throw new Error(`生成Token失败: ${error.message}`);
  }
}

// 获取存储的UID
function getStoredUid() {
  try {
    const uidPath = CONFIG.UID_CACHE_FILE;
    if (fs.existsSync(uidPath)) {
      const data = JSON.parse(fs.readFileSync(uidPath, 'utf8'));
      console.log(`📁 从本地文件读取UID: ${maskUid(data.uid)} (更新时间: ${data.updated}, 触发方式: ${data.trigger || '未知'})`);
      return {
        success: true,
        uid: data.uid
      };
    }
  } catch (error) {
    console.error('读取存储的UID失败:', error.message);
  }
  return {
    success: false,
    error: '未找到存储的UID文件'
  };
}

// 历史数据文件路径
const HISTORY_FILE = path.join(__dirname, '../data/history_data.json');

// 获取历史数据
function getHistoryData() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('读取历史数据失败:', e.message);
  }
  return {};
}

// 保存历史数据
function saveHistoryData(data) {
  try {
    const dir = path.dirname(HISTORY_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('保存历史数据失败:', e.message);
  }
}

function mergeHistoryUpdates(updates) {
  return updates.reduce((merged, update) => {
    if (!update) return merged;
    return {
      ...merged,
      ...update
    };
  }, getHistoryData());
}

function saveLatestUid(uidData) {
  try {
    const uidPath = CONFIG.UID_CACHE_FILE;
    const dataDir = path.dirname(uidPath);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    fs.writeFileSync(
      uidPath,
      JSON.stringify(uidData, null, 2)
    );
    console.log('✅ UID已存储到本地文件 (触发方式: 定时任务)');
  } catch (error) {
    console.error('存储UID到文件失败:', error.message);
  }
}

// 获取最新的UID（优化：只有定时任务时才调用API）
async function getLatestUid() {
  try {
    let latestUid;
    let uidDataToSave = null;

    if (CONFIG.WXPUSHER_UID) {
      latestUid = CONFIG.WXPUSHER_UID;
      console.log(`使用环境变量 WXPUSHER_UID: ${maskUid(latestUid)}`);
      uidDataToSave = null;
    } else if (shouldFetchLatestUid) {
      // 定时任务或 Actions 手动真实发送：从 API 获取最新 UID
      console.log('⏰ 正在从 UID API 获取最新的UID...');
      const response = await axios.get(CONFIG.UID_API, {
        timeout: 10000
      });

      if (response.data.code === 200 && response.data.data && response.data.data.length > 0) {
        latestUid = response.data.data[0].uid;
        console.log(`获取到的UID: ${maskUid(latestUid)}`);
        uidDataToSave = {
          uid: latestUid,
          updated: new Date().toISOString(),
          trigger: isScheduled ? 'scheduled' : 'manual-api',
          source: 'api'
        };
      } else {
        throw new Error('UID API返回数据格式异常');
      }
    } else {
      // 本地手动触发：从本地存储读取
      console.log('👆 本地手动触发，从本地存储读取UID...');
      const storedUid = getStoredUid();
      if (storedUid.success) {
        latestUid = storedUid.uid;
        uidDataToSave = null; // 本地手动触发不更新文件
      } else {
        throw new Error('本地手动触发时未找到本地UID文件，请配置 WXPUSHER_UID 环境变量，或设置 FETCH_LATEST_UID=true 从 UID API 获取');
      }
    }

    // UID 缓存只在发送成功后由主流程持久化。
    if (latestUid && !uidDataToSave) {
      console.log('ℹ️ 本地手动触发模式，不更新本地UID文件');
    }

    if (latestUid) {
      return {
        success: true,
        uid: latestUid,
        uidDataToSave
      };
    } else {
      throw new Error('无法获取UID');
    }
  } catch (error) {
    console.error('获取最新UID失败:', error.message);

    // 对于本地手动触发，如果读取本地文件失败，就直接失败
    if (!shouldFetchLatestUid) {
      throw new Error(`本地手动触发时获取UID失败: ${error.message}`);
    }

    // 对于 API 获取模式，尝试从 UID 缓存回退。CI 中缓存位于 runner 临时目录，不能依赖仓库内存在历史 UID。
    console.log('尝试从 UID 缓存获取UID...');
    const storedUid = getStoredUid();
    if (storedUid.success) {
      return {
        ...storedUid,
        uidDataToSave: null
      };
    }

    throw new Error(`获取UID失败: ${error.message}。建议配置 WXPUSHER_UID 环境变量作为固定收件人，避免依赖 UID API 或本地缓存`);
  }
}

// 获取实时天气 - 优化版
async function getCurrentWeather() {
  return apiLimiter.run(async () => {
    try {
      console.log(`正在获取${CONFIG.LOCATION}实时天气...`);
      const response = await axiosWithRetry({
        method: 'get',
        url: `${CONFIG.WEATHER_API_BASE}/weather`,
        params: {
          query: CONFIG.LOCATION,
          encoding: 'json'
        },
        timeout: 10000
      });

      if (response.data.code === 200) {
        const data = response.data.data;

        // 解析日出日落时间（只取时分秒）
        let sunriseTime = data.sunrise.sunrise;
        let sunsetTime = data.sunrise.sunset;

        // 如果有desc字段，优先使用
        if (data.sunrise.sunrise_desc) {
          sunriseTime = data.sunrise.sunrise_desc;
        }
        if (data.sunrise.sunset_desc) {
          sunsetTime = data.sunrise.sunset_desc;
        }

        // 如果没有desc，尝试从字符串中提取时间部分
        if (!data.sunrise.sunrise_desc && sunriseTime.includes(' ')) {
          sunriseTime = sunriseTime.split(' ')[1] || sunriseTime;
        }
        if (!data.sunrise.sunset_desc && sunsetTime.includes(' ')) {
          sunsetTime = sunsetTime.split(' ')[1] || sunsetTime;
        }

        return {
          success: true,
          data: {
            location: data.location.name || CONFIG.LOCATION,
            province: data.location.province || '',
            city: data.location.city || '',
            temperature: data.weather.temperature,
            condition: data.weather.condition,
            condition_code: data.weather.condition_code || '',
            humidity: data.weather.humidity,
            pressure: data.weather.pressure,
            precipitation: data.weather.precipitation || 0,
            wind_direction: data.weather.wind_direction,
            wind_power: data.weather.wind_power,
            weather_icon: data.weather.weather_icon || '',
            updated: data.weather.updated || '',
            airQuality: data.air_quality.quality,
            aqi: data.air_quality.aqi,
            pm25: data.air_quality.pm25,
            pm10: data.air_quality.pm10,
            sunrise: sunriseTime,
            sunset: sunsetTime,
            lifeIndices: data.life_indices || [],
            alerts: data.alerts || [],
            hasAlerts: data.alerts && data.alerts.length > 0,
            weather_colors: data.weather.weather_colors || ['#667eea', '#764ba2']
          }
        };
      } else {
        return {
          success: false,
          error: `天气API返回错误: ${response.data.message}`
        };
      }
    } catch (error) {
      console.error('获取实时天气失败:', error.message);
      return {
        success: false,
        error: `获取天气失败: ${error.message}`
      };
    }
  });
}

// 获取天气预报
async function getWeatherForecast() {
  try {
    console.log(`正在获取${CONFIG.LOCATION}天气预报...`);
    const response = await axios.get(`${CONFIG.WEATHER_API_BASE}/weather/forecast`, {
      params: {
        query: CONFIG.LOCATION,
        encoding: 'json',
        days: 7  // Changed from 3 to 7
      },
      timeout: 10000
    });

    if (response.data.code === 200) {
      const data = response.data.data;

      // 构建7天预报数据
      const forecastDays = data.daily_forecast.map((day, index) => {
        // Calculate day name dynamically
        let dayName = '未知';
        if (index === 0) dayName = '今天';
        else if (index === 1) dayName = '明天';
        else if (index === 2) dayName = '后天';
        else {
            // Calculate weekday for further days
            const date = new Date();
            date.setDate(date.getDate() + index);
            const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
            dayName = weekdays[date.getDay()];
        }

        const weatherIcons = {
          '晴': '☀️',
          '多云': '⛅',
          '阴': '☁️',
          '雨': '🌧️',
          '雪': '❄️',
          '雷': '⛈️',
          '雾': '🌫️',
          '小雨': '🌦️',
          '中雨': '🌧️',
          '大雨': '🌧️',
          '暴雨': '⛈️',
          '阵雨': '🌦️',
          '雷阵雨': '⛈️'
        };

        const dayIcon = weatherIcons[day.day_condition] || '🌤️';
        const nightIcon = weatherIcons[day.night_condition] || '🌙';

        // 判断是否为恶劣天气
        const isBadWeather = day.day_condition.includes('雨') ||
          day.day_condition.includes('雪') ||
          day.day_condition.includes('雷') ||
          day.day_condition.includes('暴雨') ||
          day.day_condition.includes('大雪');

        return {
          dayName: dayName,
          dayIcon: dayIcon,
          nightIcon: nightIcon,
          maxTemp: day.max_temperature,
          minTemp: day.min_temperature,
          dayCondition: day.day_condition,
          nightCondition: day.night_condition,
          windDirection: day.wind_direction || day.day_wind_direction || '',
          windPower: day.wind_power || day.day_wind_power || '',
          isBadWeather: isBadWeather
        };
      });

      return {
        success: true,
        data: forecastDays
      };
    } else {
      return {
        success: false,
        error: `天气预报API返回错误: ${response.data.message}`
      };
    }
  } catch (error) {
    console.error('获取天气预报失败:', error.message);
    return {
      success: false,
      error: `获取天气预报失败: ${error.message}`
    };
  }
}

// 获取真实的分钟级降水预报
async function getMinutePrecipitation(token) {
  try {
    const response = await axios.get(`${CONFIG.HEFENG_API_HOST}/v7/minutely/5m`, {
      params: {
        location: `${CONFIG.LOCATION_LON},${CONFIG.LOCATION_LAT}`
      },
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept-Encoding': 'gzip'
      },
      timeout: 10000
    });

    if (response.data.code === '200') {
      const data = response.data;

      // 分析降水数据
      let hasPrecipitation = false;
      let maxPrecip = 0;
      let precipitationType = 'none';
      let startTime = null;
      let endTime = null;

      if (data.minutely && data.minutely.length > 0) {
        // 检查未来120分钟内是否有降水
        const futureData = data.minutely.slice(0, 24); // 5分钟一个点，24个点=120分钟
        const precipitationData = futureData.filter(item => parseFloat(item.precip) > 0);

        if (precipitationData.length > 0) {
          hasPrecipitation = true;
          precipitationType = precipitationData[0].type || 'rain';

          // 计算最大降水量
          maxPrecip = Math.max(...precipitationData.map(item => parseFloat(item.precip)));

          // 获取开始时间
          startTime = new Date(precipitationData[0].fxTime).toLocaleTimeString('zh-CN', {
            hour: '2-digit',
            minute: '2-digit'
          });

          // 获取结束时间
          const lastPrecipTime = precipitationData[precipitationData.length - 1].fxTime;
          endTime = new Date(lastPrecipTime).toLocaleTimeString('zh-CN', {
            hour: '2-digit',
            minute: '2-digit'
          });
        }
      }

      // 根据降水量判断强度
      let intensity = '无降水';
      let isSevere = false;

      if (hasPrecipitation) {
        if (maxPrecip < 0.1) {
          intensity = '小雨';
        } else if (maxPrecip < 0.25) {
          intensity = '中雨';
        } else if (maxPrecip < 0.5) {
          intensity = '大雨';
          isSevere = true;
        } else {
          intensity = '暴雨';
          isSevere = true;
        }

        if (precipitationType === 'snow') {
          if (maxPrecip < 0.1) {
            intensity = '小雪';
          } else if (maxPrecip < 0.25) {
            intensity = '中雪';
          } else {
            intensity = '大雪';
            isSevere = true;
          }
        }
      }

      return {
        success: true,
        data: {
          hasPrecipitation,
          precipitationType: precipitationType === 'rain' ? '雨' : (precipitationType === 'snow' ? '雪' : '无'),
          intensity,
          startTime: startTime || '无',
          endTime: endTime || '无',
          summary: data.summary || '暂无降水',
          maxPrecip: maxPrecip.toFixed(2),
          updateTime: data.updateTime || new Date().toISOString()
        },
        isSevere
      };
    } else {
      return {
        success: false,
        error: `分钟级降水API返回错误: ${response.data.code}`
      };
    }
  } catch (error) {
    console.error('获取分钟级降水失败:', error.message);
    return {
      success: false,
      error: `获取分钟级降水失败: ${error.message}`
    };
  }
}

// 获取真实的天气预警信息
async function getWeatherAlerts(token) {
  try {
    const response = await axios.get(
      `${CONFIG.HEFENG_API_HOST}/weatheralert/v1/current/${CONFIG.LOCATION_LAT}/${CONFIG.LOCATION_LON}`,
      {
        params: {
          localTime: true
        },
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept-Encoding': 'gzip'
        },
        timeout: 10000
      }
    );

    if (response.data.metadata && !response.data.metadata.zeroResult && response.data.alerts) {
      const alerts = response.data.alerts.map(alert => {
        // 转换颜色代码为中文
        const colorMap = {
          'blue': '蓝色',
          'green': '绿色',
          'yellow': '黄色',
          'orange': '橙色',
          'red': '红色',
          'black': '黑色'
        };

        // 转换严重程度
        const severityMap = {
          'minor': '轻微',
          'moderate': '中等',
          'severe': '严重',
          'extreme': '极端'
        };

        return {
          type: alert.eventType?.name || '未知',
          level: colorMap[alert.color?.code] || alert.color?.code || '未知',
          colorCode: alert.color?.code,
          description: alert.description || alert.headline || '无详细描述',
          headline: alert.headline || '天气预警',
          time: alert.issuedTime ? new Date(alert.issuedTime).toLocaleString('zh-CN') : '未知时间',
          effectiveTime: alert.effectiveTime ? new Date(alert.effectiveTime).toLocaleString('zh-CN') : '立即生效',
          expireTime: alert.expireTime ? new Date(alert.expireTime).toLocaleString('zh-CN') : '未知',
          severity: severityMap[alert.severity] || alert.severity || '未知',
          instruction: alert.instruction || '请关注官方预警信息'
        };
      });

      return {
        success: true,
        data: {
          alerts,
          hasAlerts: alerts.length > 0,
          count: alerts.length
        }
      };
    } else {
      return {
        success: true,
        data: {
          alerts: [],
          hasAlerts: false,
          count: 0
        }
      };
    }
  } catch (error) {
    console.error('获取天气预警失败:', error.message);
    return {
      success: false,
      error: `获取天气预警失败: ${error.message}`
    };
  }
}

// 获取KFC文案
async function getKfcContent(isThursday) {
  if (!isThursday) {
    return {
      success: false,
      content: '',
      skip: true
    };
  }

  try {
    console.log('今天是星期四，正在获取KFC文案...');
    const response = await axios.get(CONFIG.KFC_API, {
      params: {
        encoding: 'json'
      },
      timeout: 8000
    });

    if (response.data.code === 200) {
      const kfcText = escapeHtml(response.data.data.kfc);
      console.log('获取到的KFC文案:', kfcText);

      const kfcContent = `<div style="background: rgba(20, 20, 30, 0.6); border-radius: 12px; padding: 16px; margin: 15px 0; border: 1px solid rgba(211, 47, 47, 0.4); box-shadow: 0 0 15px rgba(211, 47, 47, 0.1); backdrop-filter: blur(10px);">
                            <div style="display: flex; align-items: center; margin-bottom: 10px; border-bottom: 1px dashed rgba(211, 47, 47, 0.3); padding-bottom: 8px;">
                              <span style="font-size: 20px; margin-right: 10px;">🍗</span>
                              <h3 style="margin: 0; color: #ff6b6b; font-size: 16px; font-weight: 600; letter-spacing: 1px;">疯狂星期四</h3>
                            </div>
                            <div style="padding: 0; color: #e0e0e0; font-size: 14px; line-height: 1.6; font-family: 'Courier New', monospace, sans-serif;">
                              ${kfcText}
                            </div>
                          </div>`;

      return {
        success: true,
        content: kfcContent
      };
    } else {
      throw new Error(`KFC API返回错误: ${response.data.message}`);
    }
  } catch (error) {
    console.error('获取KFC文案失败:', error.message);
    return {
      success: false,
      content: '<div style="color: #999; font-style: italic; margin: 10px 0; font-size: 13px;">今天周四，但KFC文案获取失败...</div>'
    };
  }
}

// 获取一言 - 优化版
async function getHitokoto() {
  return apiLimiter.run(async () => {
    try {
      console.log('正在获取一言内容...');
      const response = await axiosWithRetry({
        method: 'get',
        url: CONFIG.HITOKOTO_API,
        timeout: 10000
      });

      const hitokoto = response.data.hitokoto;
      const from = response.data.from || '未知';
      const type = response.data.type || '';

      const typeMap = {
        'a': '动画',
        'b': '漫画',
        'c': '游戏',
        'd': '文学',
        'e': '原创',
        'f': '网络',
        'g': '其他',
        'h': '影视',
        'i': '诗词',
        'j': '网易云',
        'k': '哲学',
        'l': '抖机灵'
      };

      const typeText = typeMap[type] || '未知';

      console.log('获取到的一言:', hitokoto);
      console.log('来源:', from);
      console.log('类型:', typeText);

      return {
        success: true,
        hitokoto: hitokoto,
        from: from,
        type: typeText
      };
    } catch (error) {
      console.error('获取一言失败:', error.message);
      throw new Error(`获取一言失败: ${error.message}`);
    }
  });
}

// 获取随机运势
async function getLuck() {
  try {
    console.log('正在获取今日运势...');
    const response = await axios.get(CONFIG.LUCK_API, {
      params: { encoding: 'json' },
      timeout: 10000
    });

    if (response.data.code === 200) {
      console.log('获取到的运势:', response.data.data.luck_desc);
      return {
        success: true,
        data: response.data.data
      };
    } else {
      throw new Error(`运势API返回错误: ${response.data.message}`);
    }
  } catch (error) {
    console.error('获取运势失败:', error.message);
    return {
      success: false,
      error: `获取运势失败: ${error.message}`
    };
  }
}

// 获取历史上的今天
async function getHistoryToday() {
  try {
    console.log('正在获取历史上的今天...');
    const response = await axios.get(CONFIG.HISTORY_API, {
      params: { encoding: 'json' },
      timeout: 10000
    });

    if (response.data.code === 200) {
      console.log(`获取到历史事件: ${response.data.data.items.length} 条`);
      return {
        success: true,
        data: response.data.data
      };
    } else {
      throw new Error(`历史API返回错误: ${response.data.message}`);
    }
  } catch (error) {
    console.error('获取历史上的今天失败:', error.message);
    return {
      success: false,
      error: `获取历史失败: ${error.message}`
    };
  }
}

// 获取汇率
async function getExchangeRate() {
  try {
    console.log('正在获取今日汇率...');
    const response = await axios.get(CONFIG.EXCHANGE_API, {
      params: {
        currency: 'CNY',
        encoding: 'json'
      },
      timeout: 10000
    });

    if (response.data.code === 200) {
      const allRates = response.data.data.rates;
      // 筛选常用货币并转换汇率 (1外币 = 多少人民币)
      const targetCurrencies = ['USD', 'EUR', 'JPY', 'HKD', 'GBP'];
      const displayRates = [];
      const names = {
        'USD': '美元',
        'EUR': '欧元',
        'JPY': '日元',
        'HKD': '港币',
        'GBP': '英镑'
      };

      const historyData = getHistoryData();
      let historyExchange = historyData.exchange || {};
      let lastRates = historyExchange;
      let historyDate = '';

      if (historyExchange.items) {
        lastRates = historyExchange.items;
        historyDate = historyExchange.date;
      }

      // Determine comparison label
      let diffLabel = '';
      if (historyDate) {
         try {
           const d = new Date(historyDate);
           // if (!isNaN(d.getTime())) {
           //   diffLabel = `较${d.getMonth() + 1}-${d.getDate()}`;
           // }
         } catch (e) { }
      }

      const newHistoryRates = {};

      for (const cur of targetCurrencies) {
        const item = allRates.find(r => r.currency === cur);
        if (item) {
          // API返回的是 1 CNY = X 外币，我们需要算 1 外币 = Y CNY
          const rate = parseFloat((1 / item.rate).toFixed(4));
          
          // 计算涨跌
          const lastRate = lastRates[cur] || 0;
          let diffStr = '';
          let diffColor = '#94a3b8'; // grey
          
          if (lastRate > 0) {
             const diff = rate - lastRate;
             const percent = (diff / lastRate * 100).toFixed(2);
             if (diff > 0.0001) {
                diffStr = `↑ ${percent}%`;
                diffColor = '#ef4444'; // red for up
             } else if (diff < -0.0001) {
                diffStr = `↓ ${Math.abs(percent)}%`;
                diffColor = '#22c55e'; // green for down
             } else {
                diffStr = '-';
             }
          }

          displayRates.push({
            code: cur,
            name: names[cur],
            rate: rate.toFixed(4),
            diffStr: diffStr,
            diffColor: diffColor
          });
          
          newHistoryRates[cur] = rate;
        }
      }
      
      const todayStr = new Date().toISOString().split('T')[0];
      const historyUpdate = {
        exchange: {
          items: newHistoryRates,
          date: todayStr
        }
      };

      console.log(`获取到汇率数据: ${displayRates.length} 条`);
      return {
        success: true,
        historyUpdate,
        data: {
          updated: response.data.data.updated,
          next_updated: response.data.data.next_updated,
          base_code: response.data.data.base_code,
          rates: displayRates,
          diffLabel: diffLabel
        }
      };
    } else {
      throw new Error(`汇率API返回错误: ${response.data.message}`);
    }
  } catch (error) {
    console.error('获取汇率失败:', error.message);
    return {
      success: false,
      error: `获取汇率失败: ${error.message}`
    };
  }
}

// 获取AI资讯
async function getAiNews() {
  try {
    console.log('正在获取AI资讯...');
    // 因为AI新闻建议傍晚获取，如果是早上运行，可能获取到的是昨天的数据，或者空数据
    // 我们不做特殊日期处理，直接获取最新
    const response = await axios.get(CONFIG.AI_NEWS_API, {
      params: { encoding: 'json' },
      timeout: 10000
    });

    if (response.data.code === 200) {
      console.log(`获取到AI资讯: ${response.data.data.news.length} 条`);
      return {
        success: true,
        data: response.data.data
      };
    } else {
      throw new Error(`AI资讯API返回错误: ${response.data.message}`);
    }
  } catch (error) {
    console.error('获取AI资讯失败:', error.message);
    return {
      success: false,
      error: `获取AI资讯失败: ${error.message}`
    };
  }
}

// 获取60秒读懂世界
async function get60sNews() {
  try {
    console.log('正在获取60秒读懂世界...');
    const response = await axios.get(CONFIG.NEWS_60S_API, {
      params: { encoding: 'json' },
      timeout: 15000 // 增加超时时间，因内容较多
    });

    if (response.data.code === 200) {
      console.log(`获取到60s新闻: ${response.data.data.news.length} 条`);
      return {
        success: true,
        data: response.data.data
      };
    } else {
      throw new Error(`60s新闻API返回错误: ${response.data.message}`);
    }
  } catch (error) {
    console.error('获取60s新闻失败:', error.message);
    return {
      success: false,
      error: `获取60s新闻失败: ${error.message}`
    };
  }
}

// 获取白银数据 (Shanghai Gold, Futures, London)
async function getSilverData() {
  try {
    console.log('正在获取白银数据...');
    if (!CONFIG.TANSHU_API_KEY) throw new Error('未配置TANSHU_API_KEY');

    // Parallel fetch for 3 endpoints
    const [shResult, futureResult, londonResult] = await Promise.allSettled([
      axios.get(CONFIG.TANSHU_SILVER_SH_API, { params: { key: CONFIG.TANSHU_API_KEY }, timeout: 10000 }),
      axios.get(CONFIG.TANSHU_SILVER_FUTURE_API, { params: { key: CONFIG.TANSHU_API_KEY }, timeout: 10000 }),
      axios.get(CONFIG.TANSHU_SILVER_LONDON_API, { params: { key: CONFIG.TANSHU_API_KEY }, timeout: 10000 })
    ]);

    const data = {
      shanghai: [],
      future: [],
      london: []
    };

    // Process Shanghai Gold Exchange (Object -> Array)
    if (shResult.status === 'fulfilled' && shResult.value.data.code === 1) {
      const list = shResult.value.data.data.list;
      // Convert object to array if it's an object
      data.shanghai = typeof list === 'object' && !Array.isArray(list) 
        ? Object.values(list) 
        : (Array.isArray(list) ? list : []);
    } else {
        console.warn('上海白银接口失败:', shResult.reason || shResult.value?.data?.msg);
    }

    // Process Shanghai Futures (Array)
    if (futureResult.status === 'fulfilled' && futureResult.value.data.code === 1) {
      data.future = futureResult.value.data.data.list || [];
    } else {
        console.warn('上海期货白银接口失败:', futureResult.reason || futureResult.value?.data?.msg);
    }

    // Process London Market (Array)
    if (londonResult.status === 'fulfilled' && londonResult.value.data.code === 1) {
      data.london = londonResult.value.data.data.list || [];
    } else {
        console.warn('伦敦白银接口失败:', londonResult.reason || londonResult.value?.data?.msg);
    }

    return {
      success: true,
      data: data
    };

  } catch (error) {
    console.error('获取白银数据失败:', error.message);
    return {
      success: false,
      error: error.message
    };
  }
}

// 获取黄金价格
async function getGoldPrice() {
  try {
    console.log('正在获取黄金价格...');
    const response = await axios.get(CONFIG.GOLD_API, {
      params: { encoding: 'json' },
      timeout: 10000
    });

    if (response.data.code === 200) {
      const data = response.data.data || {};
      console.log(`获取到黄金价格数据: ${data.date || '未知日期'}`);

      data.metals = Array.isArray(data.metals) ? data.metals : [];
      data.stores = Array.isArray(data.stores) ? data.stores : [];
      data.banks = Array.isArray(data.banks) ? data.banks : [];
      data.recycle = Array.isArray(data.recycle) ? data.recycle : [];

      const historyData = getHistoryData();
      let historyGold = historyData.gold || {};
      let lastPrices = historyGold;
      let historyDate = '';
      
      if (historyGold.items) {
          lastPrices = historyGold.items;
          historyDate = historyGold.date;
      }
      
      let diffLabel = '';
      if (historyDate) {
         try {
           const d = new Date(historyDate);
           // if (!isNaN(d.getTime())) {
           //   diffLabel = `较${d.getMonth() + 1}-${d.getDate()}`;
           // }
         } catch (e) { }
      }

      const newHistoryGold = {};
      
      // Compare Metals
      if (data.metals && Array.isArray(data.metals)) {
          data.metals = data.metals.map(item => {
              const lastPrice = lastPrices[item.name] || 0;
              const currentPrice = parseFloat(item.today_price);
              let diffStr = '';
              let diffColor = '#94a3b8';
              
              if (lastPrice > 0) {
                  const diff = currentPrice - lastPrice;
                  if (diff > 0.01) {
                      diffStr = `↑ ${diff.toFixed(2)}`;
                      diffColor = '#ef4444';
                  } else if (diff < -0.01) {
                      diffStr = `↓ ${Math.abs(diff).toFixed(2)}`;
                      diffColor = '#22c55e';
                  } else {
                      diffStr = '-';
                  }
              }
              newHistoryGold[item.name] = currentPrice;
              
              return {
                  ...item,
                  diffStr,
                  diffColor
              };
          });
      }
      
      const todayStr = new Date().toISOString().split('T')[0];
      const historyUpdate = {
          gold: {
              items: newHistoryGold,
              date: todayStr
          }
      };

      return {
        success: true,
        historyUpdate,
        data: {
            ...data,
            diffLabel: diffLabel
        }
      };
    } else {
      throw new Error(`黄金价格API返回错误: ${response.data.message}`);
    }
  } catch (error) {
    console.error('获取黄金价格失败:', error.message);
    return {
      success: false,
      error: `获取黄金价格失败: ${error.message}`
    };
  }
}

// 获取汽油价格 (使用探数API)
async function getFuelPrice() {
  try {
    console.log('正在获取汽油价格...');
    
    // 检查API Key
    if (!CONFIG.TANSHU_API_KEY) {
       console.log('⚠️ 未配置TANSHU_API_KEY，尝试使用旧接口...');
       // 如果没有key，可以回退到旧逻辑，但用户明确要求替换。
       // 这里为了兼容性，如果旧配置还在且新配置不在，可以用旧的，但最好直接报错提示。
       // 暂时报错提示。
       throw new Error('未配置TANSHU_API_KEY');
    }

    // 1. 获取省份油价列表
    const listResponse = await axios.get(CONFIG.TANSHU_FUEL_LIST_API, {
      params: { key: CONFIG.TANSHU_API_KEY },
      timeout: 10000
    });

    if (listResponse.data.code !== 1) {
      throw new Error(`获取油价列表失败: ${listResponse.data.msg}`);
    }

    const provinceName = '浙江'; // 筛选浙江
    const provinceData = listResponse.data.data.list.find(p => p.province.includes(provinceName));

    if (!provinceData) {
      throw new Error(`未找到 ${provinceName} 的油价数据`);
    }

    // 2. 获取油价行情 (涨跌趋势)
    let trendData = {};
    try {
      const trendResponse = await axios.get(CONFIG.TANSHU_FUEL_TREND_API, {
        params: { 
          key: CONFIG.TANSHU_API_KEY,
          province: provinceData.province 
        },
        timeout: 10000
      });
      
      if (trendResponse.data.code === 1) {
        trendData = trendResponse.data.data;
        console.log(`获取到 ${provinceName} 油价行情: 下次调价 ${trendData.next_change_time}`);
      } else {
        console.warn(`获取油价行情失败: ${trendResponse.data.msg}`);
      }
    } catch (e) {
      console.warn('获取油价行情API出错:', e.message);
    }

    // 3. 组装数据
    const fuelTypes = [
      { key: '0h', name: '0#柴' },
      { key: '89h', name: '89#' },
      { key: '90h', name: '90#' },
      { key: '92h', name: '92#' },
      { key: '93h', name: '93#' },
      { key: '95h', name: '95#' },
      { key: '97h', name: '97#' },
      { key: '98h', name: '98#' }
    ];

    const items = fuelTypes.map(type => {
      const price = provinceData[type.key];
      if (!price || price.trim() === '') return null; // 过滤空数据

      const trend = trendData[type.key] || {};
      
      let diffStr = '-';
      let diffColor = '#94a3b8';

      // 涨跌信息
      if (trend.change) {
        const change = parseFloat(trend.change);
        if (change > 0) {
          diffStr = `↑${Math.abs(change)}`;
          diffColor = '#ef4444';
        } else if (change < 0) {
          diffStr = `↓${Math.abs(change)}`;
          diffColor = '#22c55e';
        }
      }
      
      // 涨跌幅百分比
      let changePercent = trend.change_percent || '';

      // 上次调整前价格
      let beforePrice = trend.change_before_price || '';

      return {
        name: type.name,
        price: price,
        diffStr,
        diffColor,
        changePercent,
        beforePrice
      };
    }).filter(Boolean); // 移除null

    return {
      success: true,
      data: {
        province: provinceData.province,
        updated: provinceData.date,
        items: items,
        next_change: trendData.next_change_time, // 下次调价时间
        before_change: trendData.before_change_time // 上次调价时间
      }
    };

  } catch (error) {
    console.error('获取汽油价格失败:', error.message);
    return {
      success: false,
      error: `获取汽油价格失败: ${error.message}`
    };
  }
}

async function getMoyuDaily() {
  try {
    console.log('正在获取摸鱼日报...');
    const response = await axios.get(CONFIG.MOYU_API, {
      params: { encoding: 'json' },
      timeout: 10000
    });

    if (response.data.code === 200) {
      return {
        success: true,
        data: response.data.data
      };
    } else {
      throw new Error(`摸鱼日报API返回错误: ${response.data.message}`);
    }
  } catch (error) {
    console.error('获取摸鱼日报失败:', error.message);
    return {
      success: false,
      error: `获取摸鱼日报失败: ${error.message}`
    };
  }
}

// 通用API获取函数 - 优化版
async function fetchApi(url, name, params = { encoding: 'json' }) {
  return apiLimiter.run(async () => {
    try {
      console.log(`正在获取${name}...`);
      const response = await axiosWithRetry({
        method: 'get',
        url: url,
        params: params,
        timeout: 10000
      });
      
      if (response.data.code === 200) {
        return { success: true, data: response.data.data };
      } else {
        return { success: false, error: `${name}API返回错误: ${response.data.message || response.data.msg || response.data.code || '未知错误'}` };
      }
    } catch (error) {
      console.error(`获取${name}失败:`, error.message);
      return { success: false, error: error.message };
    }
  });
}

async function getWeiboHot() { return fetchApi(CONFIG.WEIBO_API, '微博热搜'); }
async function getToutiaoHot() { return fetchApi(CONFIG.TOUTIAO_API, '头条热搜'); }
async function getZhihuHot() { return fetchApi(CONFIG.ZHIHU_API, '知乎热榜'); }
async function getMaoyanMovie() { return fetchApi(CONFIG.MAOYAN_MOVIE_API, '猫眼电影'); }
async function getMaoyanTv() { return fetchApi(CONFIG.MAOYAN_TV_API, '猫眼电视'); }
async function getMaoyanWeb() { return fetchApi(CONFIG.MAOYAN_WEB_API, '猫眼网剧'); }
async function getDouyinHot() { return fetchApi(CONFIG.DOUYIN_API, '抖音热搜'); }
async function getBiliHot() { return fetchApi(CONFIG.BILI_API, 'B站热搜'); }
async function getBaiduTieba() { return fetchApi(CONFIG.BAIDU_TIEBA_API, '百度贴吧'); }

const HOT_LIST_DEFINITIONS = [
  {
    key: 'douyin',
    configKey: 'DOUYIN',
    tabId: 'douyin',
    name: '抖音',
    taskName: '抖音热搜',
    type: 'list',
    fetcher: () => getDouyinHot(),
    getItems: data => data,
    map: item => ({ title: item.title, desc: `热度: ${item.hot_value}`, link: item.link, rank: null })
  },
  {
    key: 'bili',
    configKey: 'BILI',
    tabId: 'bili',
    name: 'B站',
    taskName: 'B站热搜',
    type: 'list',
    fetcher: () => getBiliHot(),
    getItems: data => data,
    map: item => ({ title: item.title, desc: '', link: item.link, rank: null })
  },
  {
    key: 'weibo',
    configKey: 'WEIBO',
    tabId: 'weibo',
    name: '微博',
    taskName: '微博热搜',
    type: 'list',
    fetcher: () => getWeiboHot(),
    getItems: data => data,
    map: item => ({ title: item.title, desc: '', link: item.link, rank: null })
  },
  {
    key: 'toutiao',
    configKey: 'TOUTIAO',
    tabId: 'toutiao',
    name: '头条',
    taskName: '头条热搜',
    type: 'list',
    fetcher: () => getToutiaoHot(),
    getItems: data => data,
    map: item => ({ title: item.title, desc: `热度: ${item.hot_value}`, link: item.link, rank: null })
  },
  {
    key: 'zhihu',
    configKey: 'ZHIHU',
    tabId: 'zhihu',
    name: '知乎',
    taskName: '知乎热榜',
    type: 'list',
    fetcher: () => getZhihuHot(),
    getItems: data => data,
    map: item => ({ title: item.title, desc: item.hot_value_desc || item.detail, link: item.link, rank: null })
  },
  {
    key: 'baiduTieba',
    configKey: 'TIEBA',
    tabId: 'tieba',
    name: '贴吧',
    taskName: '百度贴吧',
    type: 'list',
    fetcher: () => getBaiduTieba(),
    getItems: data => data,
    map: item => ({ title: item.title, desc: item.desc, link: item.url, rank: item.rank })
  },
  {
    key: 'maoyanMovie',
    configKey: 'MOVIE',
    tabId: 'movie',
    name: '电影',
    taskName: '猫眼电影',
    type: 'maoyan',
    fetcher: () => getMaoyanMovie(),
    getItems: data => data?.list,
    map: item => ({ title: item.movie_name, desc: `${item.box_office}${item.box_office_unit}` })
  },
  {
    key: 'maoyanTv',
    configKey: 'TV',
    tabId: 'tv',
    name: '剧集',
    taskName: '猫眼电视',
    type: 'maoyan',
    fetcher: () => getMaoyanTv(),
    getItems: data => data?.list,
    map: item => ({ title: item.programme_name, desc: item.market_rate_desc })
  },
  {
    key: 'maoyanWeb',
    configKey: 'WEB',
    tabId: 'web',
    name: '网剧',
    taskName: '猫眼网剧',
    type: 'maoyan',
    fetcher: () => getMaoyanWeb(),
    getItems: data => data?.list,
    map: item => ({ title: item.series_name, desc: item.curr_heat_desc })
  }
];

// 获取Bing壁纸
async function getBingWallpaper() {
  try {
    console.log('正在获取Bing每日壁纸...');
    const response = await axios.get(CONFIG.BING_API, {
      params: { encoding: 'json' },
      timeout: 10000
    });

    if (response.data.code === 200) {
      console.log(`获取到Bing壁纸: ${response.data.data.title}`);
      return {
        success: true,
        data: response.data.data
      };
    } else {
      throw new Error(`Bing壁纸API返回错误: ${response.data.message}`);
    }
  } catch (error) {
    console.error('获取Bing壁纸失败:', error.message);
    return {
      success: false,
      error: `获取Bing壁纸失败: ${error.message}`
    };
  }
}

// 发送消息到WxPusher
async function sendMessage(htmlContent, summary, uid) {
  try {
    console.log('正在发送消息到WxPusher...');

    if (htmlContent.length > MAX_WXPUSHER_CONTENT_LENGTH) {
      throw new Error(`WxPusher内容超过限制: ${htmlContent.length}/${MAX_WXPUSHER_CONTENT_LENGTH}`);
    }

    if (!CONFIG.WXPUSHER_APP_TOKEN) {
      throw new Error('未配置 WXPUSHER_APP_TOKEN，无法发送消息');
    }

    const messageData = {
      appToken: CONFIG.WXPUSHER_APP_TOKEN,
      content: htmlContent,
      summary: summary,
      contentType: 2,
      uids: [uid],
      topicIds: [],
      verifyPayType: 0
    };

    console.log('使用的AppToken:', CONFIG.WXPUSHER_APP_TOKEN ? '已设置' : '未设置');

    const response = await axios.post(CONFIG.WXPUSHER_API, messageData, {
      headers: {
        'Content-Type': 'application/json'
      },
      timeout: 15000
    });

    console.log('发送结果:', JSON.stringify(response.data, null, 2));

    if (response.data.code === 1000) {
      console.log('✅ 消息发送成功！');
      return {
        success: true,
        messageId: response.data.data[0]?.messageContentId
      };
    } else {
      throw new Error(`发送失败: ${response.data.msg || '未知错误'}`);
    }
  } catch (error) {
    console.error('发送消息失败:', error.message);
    if (error.response) {
      console.error('错误响应:', error.response.data);
    }
    throw new Error(`发送消息失败: ${error.message}`);
  }
}

// 构建天气轮播图的HTML内容 - 科技感设计
// 构建天气轮播图的HTML内容 - 科技感设计 (优化版)
function buildWeatherCarousel(weatherData, forecastData, timeInfo) {
  const w = weatherData.data;
  const forecastDays = forecastData.data;
  
  const safeWeather = {
    location: escapeHtml(w.location),
    sunrise: escapeHtml(w.sunrise),
    sunset: escapeHtml(w.sunset),
    temperature: escapeHtml(w.temperature),
    humidity: escapeHtml(w.humidity),
    windDirection: escapeHtml(w.wind_direction),
    windPower: escapeHtml(w.wind_power),
    pressure: escapeHtml(w.pressure),
    precipitation: escapeHtml(w.precipitation),
    pm25: escapeHtml(w.pm25),
    aqi: escapeHtml(w.aqi || ''),
    airQuality: escapeHtml(w.airQuality)
  };

  // Generate unique ID to avoid conflicts in list views
  const uniqueId = 'carousel-' + Math.floor(Math.random() * 1000000);

  // 天气图标映射
  const weatherIconMap = {
    '晴': '☀️', '多云': '⛅', '阴': '☁️', '雨': '🌧️', '雪': '❄️',
    '雷': '⛈️', '雾': '🌫️', '小雨': '🌦️', '中雨': '🌧️', '大雨': '🌧️',
    '暴雨': '⛈️', '阵雨': '🌦️', '雷阵雨': '⛈️'
  };
  const currentIcon = weatherIconMap[w.condition] || '🌤️';

  // 计算日出日落进度
  const getSunPosition = (sunriseStr, sunsetStr, currentHour, currentMinute) => {
    if (!sunriseStr || !sunsetStr || sunriseStr === '无' || sunsetStr === '无') return 50;
    const parseTime = (str) => {
      const parts = str.split(':');
      if (parts.length < 2) return 0;
      return parseInt(parts[0]) * 60 + parseInt(parts[1]);
    };
    const sunriseMins = parseTime(sunriseStr);
    const sunsetMins = parseTime(sunsetStr);
    const currentMins = currentHour * 60 + currentMinute;

    if (currentMins <= sunriseMins) return 0;
    if (currentMins >= sunsetMins) return 100;
    return ((currentMins - sunriseMins) / (sunsetMins - sunriseMins)) * 100;
  };

  const sunPercent = getSunPosition(w.sunrise, w.sunset, timeInfo.hour, parseInt(timeInfo.time.split(':')[1]));
  // 角度是从 180(左) 到 0(右)
  const sunAngle = 180 - (sunPercent / 100 * 180);
  const sunRad = sunAngle * Math.PI / 180;
  // 半径 80, 中心 (100, 100)
  const sunX = 100 + 80 * Math.cos(sunRad);
  const sunY = 100 - 80 * Math.sin(sunRad);

  // 基础卡片样式 (Moved to CSS)
  // const cardStyle = ''; // Deprecated, using class .wc
  
  // const neonGlow = ''; // Deprecated, using class .wng

  // slide3: Life Indices
  let lifeIndicesHtml = '';
  // Support both snake_case (API spec) and camelCase (potential processor)
  const indicesSource = w.life_indices || w.lifeIndices || [];
  const indicesToShow = indicesSource.length > 0 ? indicesSource.slice(0, 6) : [];

  // Icon Map for Indices - Ensure unique icons
  const indexIconMap = {
    '穿衣': '👕', '紫外线': '☂️', '洗车': '🚗', '运动': '🏃', '感冒': '💊',
    '空气扩散': '💨', '舒适度': '😌', '晾晒': '👚', '钓鱼': '🎣', '旅游': '🧳',
    '过敏': '🤧', '防晒': '🧴', '化妆': '💄', '交通': '🚦', '路况': '🚦',
    '空气污染': '�', '中暑': '🥵', '晨练': '🧘', '约会': '🌹', '雨伞': '☔'
  };
  // Ensure correct icon for air pollution (fix potential encoding issues)
  indexIconMap['空气污染'] = '🌫️';
  const fallbackIcons = ['🌟', '🍀', '🌸', '❄️', '🔥', '🌈', '🎈', '🎁'];

  // Pure CSS Marquee & Highlight Setup
  let gridItems = '';
  let adviceItems = '';
  let cssStyles = '<style>';

  if (indicesToShow.length > 0) {
    const count = indicesToShow.length;
    const itemDuration = 6; // 6 seconds per item to allow horizontal scroll
    const totalDuration = count * itemDuration;
    const stepPercent = 100 / count;
    
    // 1. Define Keyframes
    cssStyles += `
      /* Text Vertical Scroll Animation */
      @keyframes scroll-text-${uniqueId} {
        0% { transform: translateY(0); }
        100% { transform: translateY(-${count * 36}px); }
      }
      
      /* Horizontal Marquee for long text */
      @keyframes horizontal-marquee-${uniqueId} {
        0%, 15% { transform: translateX(0); }
        85%, 100% { transform: translateX(-60%); } /* Roughly scrolls enough */
      }
      
      /* Grid Highlight Animation */
      @keyframes highlight-grid-${uniqueId} {
        0%, ${stepPercent - 0.1}% { 
          background: rgba(255,255,255,0.1); 
          border-color: rgba(255,255,255,0.3); 
        }
        ${stepPercent}%, 100% { 
          background: rgba(255,255,255,0.03); 
          border-color: rgba(255,255,255,0.05); 
        }
      }
      
      /* Apply animations */
      #advice-wrapper-${uniqueId} {
        animation: scroll-text-${uniqueId} ${totalDuration}s steps(${count}) infinite;
      }
      
      .h-scroll-${uniqueId} {
        display: inline-block;
        white-space: nowrap;
        animation: horizontal-marquee-${uniqueId} ${itemDuration}s ease-in-out infinite;
      }
    `;

    indicesToShow.forEach((item, i) => {
        // 2. Grid Item (Div)
        let icon = indexIconMap[item.name];
        if (!icon) icon = fallbackIcons[i % fallbackIcons.length];
        
        const delay = i * itemDuration;

        cssStyles += `
          #grid-item-${uniqueId}-${i} {
            animation: highlight-grid-${uniqueId} ${totalDuration}s infinite;
            animation-delay: ${delay}s;
          }
        `;

        const safeName = escapeHtml(item.name);
        const safeLevel = escapeHtml(item.level || item.status || '');
        const safeAdvice = escapeHtml(item.description || item.detail || item.category || item.text || item.desc || '暂无详细建议');

        gridItems += `
          <div id="grid-item-${uniqueId}-${i}" class="wgi">
            <div style="font-size: 16px;">${icon}</div>
            <div style="flex: 1; min-width: 0;">
              <div style="font-size: 11px; color: #a78bfa; margin-bottom: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${safeName}</div>
              <div style="font-size: 10px; color: #fff;">${safeLevel}</div>
            </div>
          </div>
        `;

        // 3. Advice Item
        adviceItems += `
            <div class="wai" style="height: 36px; box-sizing: border-box;">
                <span style="color: #f472b6; margin-right: 8px; font-weight: bold; flex-shrink: 0; background: rgba(0,0,0,0.4); z-index: 2; padding-right: 6px;">${safeName}</span>
                <div style="flex: 1; overflow: hidden; white-space: nowrap;">
                    <span class="h-scroll-${uniqueId}">${safeAdvice}</span>
                </div>
            </div>
        `;
    });
    
    cssStyles += '</style>';
  } else {
    cssStyles += '</style>'; // Close style tag even if empty
    gridItems = '<div style="color: #64748b; font-size: 12px; text-align: center; padding: 12px; grid-column: span 2;">暂无生活指数数据</div>';
    adviceItems = '<div style="color: #64748b; font-size: 11px; height: 36px; display: flex; align-items: center;">暂无建议</div>';
  }

  // slide1: 实时天气 + 日出日落可视化
  const slide1 = `
    <div class="slide-item-${uniqueId} wc" data-index="0">
      ${cssStyles}
      <div class="wng"></div>
      <div style="position: relative; z-index: 1; flex: 1; display: flex; flex-direction: column;">
        <!-- Header -->
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 2px;">
          <div style="font-size: 16px; font-weight: bold; color: #fff;">${safeWeather.location}</div>
          <div style="font-size: 12px; color: #00f3ff; font-family: monospace;">${timeInfo.time}</div>
        </div>
        
        <!-- Sun Arc Viz -->
        <div style="position: relative; height: 90px; margin-bottom: 0px;">
           <svg width="100%" height="100%" viewBox="0 0 200 95" style="overflow: visible;">
              <!-- Track -->
              <path d="M 20 100 A 80 80 0 0 1 180 100" fill="none" stroke="rgba(255,255,255,0.1)" stroke-width="2" stroke-dasharray="4 4" />
              <!-- Progress -->
              <!-- Sun -->
              <g transform="translate(${sunX}, ${sunY})">
                <circle r="6" fill="#facc15" filter="drop-shadow(0 0 8px #facc15)" />
                <circle r="10" fill="rgba(250, 204, 21, 0.3)" />
              </g>
              <!-- Texts -->
              <text x="20" y="115" fill="#94a3b8" font-size="10" text-anchor="middle">${safeWeather.sunrise}</text>
              <text x="180" y="115" fill="#94a3b8" font-size="10" text-anchor="middle">${safeWeather.sunset}</text>
           </svg>
           <!-- Center Temp -->
           <div style="position: absolute; top: 30px; left: 0; width: 100%; text-align: center;">
              <div style="display: flex; justify-content: center; align-items: center; gap: 8px;">
                 <span style="font-size: 28px;">${currentIcon}</span>
                 <span style="font-size: 36px; font-weight: 300; color: #fff;">${safeWeather.temperature}°</span>
              </div>
           </div>
        </div>

        <!-- Details Grid -->
        <div class="wdg">
           <div class="wdi">
             <div style="font-size: 12px; margin-bottom: 2px;">💧</div>
             <div style="font-size: 10px; color: #64748b;">湿度</div>
             <div style="font-size: 12px; color: #e2e8f0;">${safeWeather.humidity}%</div>
           </div>
           <div class="wdi">
             <div style="font-size: 12px; margin-bottom: 2px;">🌬️</div>
             <div style="font-size: 10px; color: #64748b;">${safeWeather.windDirection}</div>
             <div style="font-size: 12px; color: #e2e8f0;">${safeWeather.windPower}</div>
           </div>
           <div class="wdi">
             <div style="font-size: 12px; margin-bottom: 2px;">⏲️</div>
             <div style="font-size: 10px; color: #64748b;">气压</div>
             <div style="font-size: 12px; color: #e2e8f0;">${safeWeather.pressure}hPa</div>
           </div>
           <div class="wdi">
             <div style="font-size: 12px; margin-bottom: 2px;">☔</div>
             <div style="font-size: 10px; color: #64748b;">降水</div>
             <div style="font-size: 12px; color: #e2e8f0;">${safeWeather.precipitation}mm</div>
           </div>
           <div class="wdi">
             <div style="font-size: 12px; margin-bottom: 2px;">😷</div>
             <div style="font-size: 10px; color: #64748b;">PM2.5</div>
             <div style="font-size: 12px; color: #e2e8f0;">${safeWeather.pm25}</div>
           </div>
           <div class="wdi">
             <div style="font-size: 12px; margin-bottom: 2px;">🍃</div>
             <div style="font-size: 10px; color: #64748b;">空气 ${safeWeather.aqi}</div>
             <div style="font-size: 12px; color: ${w.airQuality === '优' ? '#4ade80' : '#facc15'};">${safeWeather.airQuality}</div>
           </div>
        </div>
        <div style="margin-top: 15px; border-top: 1px dashed rgba(255,255,255,0.08); padding-top: 8px; flex: 1; display: flex; flex-direction: column;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; flex-shrink: 0;">
            <div style="font-size: 12px; color: #f472b6; letter-spacing: 1px;">生活指南</div>
          </div>
          <div class="slide3-content-${uniqueId}" style="position: relative; z-index: 1; display: flex; flex-direction: column; flex: 1;">
            <div class="life-grid-${uniqueId}" style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px; margin-bottom: 6px; flex-shrink: 0;">
              ${gridItems}
            </div>
            <div class="advice-box-${uniqueId}" style="
                background: rgba(0,0,0,0.2); 
                padding: 0 12px; 
                border-radius: 6px; 
                border-left: 2px solid #f472b6;
                height: 36px;
                overflow: hidden;
                position: relative;
                flex-shrink: 0;
            ">
                <div id="advice-wrapper-${uniqueId}" style="display: flex; flex-direction: column;">
                    ${adviceItems}
                </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  // slide2: Forecast
  let forecastHtml = '';
  forecastDays.forEach((day, index) => {
    const borderStyle = index === 0 ? 'border-left-color: #00f3ff;' : '';
    const safeDayName = escapeHtml(day.dayName);
    const safeDayCondition = escapeHtml(day.dayCondition);
    const safeWindDirection = escapeHtml(day.windDirection);
    const safeWindPower = escapeHtml(day.windPower);
    const safeMaxTemp = escapeHtml(day.maxTemp);
    const safeMinTemp = escapeHtml(day.minTemp);
    forecastHtml += `
      <div class="wfi" style="${borderStyle}">
        <div style="display: flex; flex-direction: column; width: 60px;">
          <span style="font-size: 14px; color: #e2e8f0;">${safeDayName}</span>
          <span style="font-size: 10px; color: #64748b;">${safeDayCondition}</span>
        </div>
        <div style="font-size: 20px;">${day.dayIcon}</div>
        <!-- Wind Info -->
        <div style="display: flex; flex-direction: column; align-items: center; width: 60px;">
            <span style="font-size: 10px; color: #94a3b8;">${safeWindDirection}</span>
            <span style="font-size: 10px; color: #64748b;">${safeWindPower}</span>
        </div>
        <div style="text-align: right; width: 40px;">
          <div style="font-size: 16px; color: #fff; font-weight: 500;">${safeMaxTemp}°</div>
          <div style="font-size: 10px; color: #64748b;">${safeMinTemp}°</div>
        </div>
      </div>
    `;
  });

  const slide2 = `
    <div class="slide-item-${uniqueId} wc" data-index="1">
      <div class="wng"></div>
        <div style="position: relative; z-index: 1; flex: 1; display: flex; flex-direction: column;">
        <!-- Cleaned up Header -->
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; flex-shrink: 0;">
          <div style="font-size: 16px; font-weight: bold; color: #fff;">未来天气</div>
        </div>
        <div style="overflow-y: auto; scrollbar-width: none; -ms-overflow-style: none; flex: 1;">
            ${forecastHtml}
        </div>
      </div>
    </div>
  `;

  // 轮播容器
  const html = `
    <div style="margin: 20px 0; position: relative;">
      <div id="${uniqueId}" style="
        overflow-x: auto; 
        display: flex; 
        scroll-snap-type: x mandatory; 
        gap: 12px; 
        padding-bottom: 20px; 
        scrollbar-width: none; 
        -ms-overflow-style: none;
      ">
        ${slide1}
        ${slide2}
      </div>

      <script>
        (function() {
          var container = document.getElementById('${uniqueId}');
          if (!container) return;
          var currentIndex = 0;
          var autoPlayInterval;
          var scrollTimeout;
          var isUserInteracting = false;

          function getSlideWidth() {
             return container.clientWidth || container.offsetWidth || 0;
          }

          function goToSlide(index) {
            if (index < 0 || index >= 2) return;
            currentIndex = index;
            var width = getSlideWidth();
            if (width > 0) {
                // Gap is 12px
                var scrollPos = index * (width + 12);
                container.scrollTo({
                  left: scrollPos,
                  behavior: 'smooth'
                });
            }
          }
          
          function startAutoPlay() {
            stopAutoPlay();
            autoPlayInterval = setInterval(function() {
              if (!isUserInteracting) {
                var nextIndex = (currentIndex + 1) % 2;
                goToSlide(nextIndex);
              }
            }, 5000);
          }
          
          function stopAutoPlay() {
             if (autoPlayInterval) clearInterval(autoPlayInterval);
          }
          
          // Intersection Observer for updating dots
          var observerOptions = {
            root: container,
            threshold: 0.5
          };

          var observer = new IntersectionObserver(function(entries) {
            entries.forEach(function(entry) {
              if (entry.isIntersecting) {
                 var idx = parseInt(entry.target.getAttribute('data-index'));
                 if (!isNaN(idx)) {
                   currentIndex = idx;
                 }
              }
            });
          }, observerOptions);

          var slides = document.querySelectorAll('.slide-item-' + uniqueId);
          slides.forEach(function(slide) {
            observer.observe(slide);
          });
          
          container.addEventListener('scroll', function() {
             isUserInteracting = true;
             clearTimeout(scrollTimeout);
             scrollTimeout = setTimeout(function() {
               isUserInteracting = false;
               startAutoPlay();
             }, 2000);
          });
          
          startAutoPlay();
        })();
      </script>
    </div>
  `;

  return html;
}

// 构建热点榜单模块
function buildHotListModule(hotData) {
  let tabsHtml = '';

  HOT_LIST_DEFINITIONS.forEach((tab, index) => {
    if (!CONFIG.SHOW_MODULES.HOT_LIST[tab.configKey]) return;

    const tabData = resolveFallbackResult(hotData[tab.key]);
    const rawList = getHotListItems(tab, tabData);
    if (rawList.length === 0) return;

    const items = rawList.slice(0, 10).map((item, idx) => {
       const mapped = tab.map(item);
       const title = escapeHtml(mapped.title || '');
       const desc = escapeHtml(mapped.desc || '');
       const link = sanitizeUrl(mapped.link);
       const rank = mapped.rank ?? idx + 1;
       let rankColor = '#64748b'; // default
       if (rank === 1) rankColor = '#ef4444'; // Red
       else if (rank === 2) rankColor = '#f97316'; // Orange
       else if (rank === 3) rankColor = '#facc15'; // Yellow

       // 无缝滚动：文字复制两份 + translateX(-50%) 实现循环
       const isLong = title.length > 16;
       const titleHtml = isLong
         ? `<div class="ht-tt-scroll"><span class="ht-tt-inner">${title} &nbsp;&nbsp;&nbsp;&nbsp; ${title} &nbsp;&nbsp;&nbsp;&nbsp; ${title}</span></div>`
         : `<div class="ht-tt">${title}</div>`;

       return `
         ${link ? `<a href="${link}" class="ht-it" style="text-decoration:none;color:inherit">` : `<div class="ht-it">`}
           <div class="ht-rk" style="color: ${rankColor}">${rank}</div>
           <div class="ht-ct">
             ${titleHtml}
             <div class="ht-dc">${desc}</div>
           </div>
           ${link ? `<span class="ht-lk">🔗</span>` : ''}
         ${link ? `</a>` : `</div>`}
       `;
    }).join('');

    tabsHtml += `
      <input type="radio" name="hot-tabs" id="tab-${tab.tabId}" class="tb-inp" hidden>
      <label for="tab-${tab.tabId}" class="tb-lbl" style="order: ${index + 1};">${tab.name}</label>
      <div class="tb-cnt" style="order: 100; width: 100%;">
         ${items}
      </div>
    `;
  });
  
  if (!tabsHtml) return '';
  
  // Set the first radio to checked
  tabsHtml = tabsHtml.replace('hidden', 'checked hidden');

  return `
    <div style="margin: 20px 0; background: #0f172a; border-radius: 12px; padding: 15px; border: 1px solid rgba(255,255,255,0.1);">
       <div style="margin-bottom: 15px; display: flex; align-items: center; gap: 8px;">
         <div style="font-size: 16px;">🔥</div>
         <div style="color: #fff; font-weight: bold; font-size: 16px;">实时热点</div>
       </div>
       <div style="display: flex; flex-wrap: wrap; gap: 8px;">
         ${tabsHtml}
       </div>
    </div>
    <style>
    .ht-it{display:flex;align-items:center;margin-bottom:12px;padding-bottom:12px;border-bottom:1px dashed rgba(255,255,255,0.05)}
    .ht-it:last-child{border-bottom:none;margin-bottom:0;padding-bottom:0}
    .ht-rk{width:24px;font-family:monospace;font-weight:bold;font-size:14px;margin-right:8px;text-align:center;flex-shrink:0}
    .ht-ct{flex:1;overflow:hidden;min-width:0}
    .ht-tt{color:#e2e8f0;font-size:13px;margin-bottom:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.5}
    .ht-tt-scroll{overflow:hidden;white-space:nowrap;width:100%;position:relative;height:24px;margin-bottom:2px}
    .ht-tt-inner{display:inline-block;white-space:nowrap;color:#e2e8f0;font-size:13px;line-height:24px;animation:hot-marquee 12s linear infinite}
    .ht-dc{color:#64748b;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .ht-lk{color:#64748b;text-decoration:none;font-size:12px;margin-left:8px;opacity:0.5;flex-shrink:0}
    .tb-lbl{padding:4px 12px;border-radius:99px;background:rgba(255,255,255,0.05);color:#94a3b8;font-size:11px;cursor:pointer;border:1px solid rgba(255,255,255,0.05);transition:all 0.2s;user-select:none}
    .tb-inp:checked+.tb-lbl{background:rgba(244,63,94,0.15);color:#f43f5e;border-color:rgba(244,63,94,0.4);font-weight:bold}
    .tb-cnt{display:none;margin-top:15px;max-height:400px;overflow-y:auto}
    .tb-inp:checked+.tb-lbl+.tb-cnt{display:block;animation:fadeIn 0.3s ease}
    @keyframes fadeIn{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:translateY(0)}}
    @keyframes marquee{0%{transform:translateX(0)}100%{transform:translateX(-50%)}}
    @keyframes hot-marquee{0%{transform:translateX(0)}100%{transform:translateX(-33.33%)}}
    </style>
  `;
}

// 数据完整性检查辅助函数
function validateDataIntegrity(data, name) {
  if (!data) {
    console.warn(`⚠️  ${name}: 数据为 null/undefined`);
    return false;
  }
  
  if (typeof data !== 'object') {
    console.warn(`⚠️  ${name}: 数据类型错误 (${typeof data})`);
    return false;
  }
  
  if (data.success === false) {
    console.warn(`⚠️  ${name}: 获取失败 - ${data.error || '未知错误'}`);
    return false;
  }
  
  if (data.skipped === true) {
    console.log(`ℹ️  ${name}: 已跳过（模块未启用）`);
    return false;
  }
  
  return true;
}

// 构建HTML内容 - 科技感设计
function buildHtmlContent(timeInfo, hitokotoData, weatherData, forecastData, precipitationData, alertData, luckData, historyData, rateData, goldData, silverData, fuelData, moyuData, aiNewsData, news60sData, bingData, kfcContent, hotData) {
  console.log('📝 开始构建HTML内容...');
  
  // 数据安全检查
  if (!timeInfo || !timeInfo.dateTime) {
    console.error('❌ timeInfo 数据无效');
    throw new Error('timeInfo 数据无效');
  }
  
  if (CONFIG.SHOW_MODULES.yiYan && (!hitokotoData || !hitokotoData.hitokoto)) {
    console.warn('⚠️  hitokotoData 数据无效，跳过一言卡片');
  }

  const shouldShowHitokoto = CONFIG.SHOW_MODULES.yiYan && hitokotoData && hitokotoData.hitokoto;
  const { dateTime, dayOfWeek, isThursday, simpleDate, time } = timeInfo;
  console.log(`   时间信息: ${dateTime}`);

  // 壁纸处理：如果获取成功且开关开启展示，否则展示默认深色背景
  let headerOverlay = '';

  // Compact Drawer Helper
  const genDrawer = (id, icon, title, content, cls='') => `
    <input type="checkbox" id="${id}" style="display:none">
    <label for="${id}" class="do"></label>
    <div class="dc ${id}-d ${cls}"><div class="dh"><div class="dt">${icon} ${title}</div><label for="${id}" class="dx">✕</label></div>${content}</div>
    <style>#${id}:checked~.do{display:block}#${id}:checked~.${id}-d{right:0!important}</style>
  `;

  if (CONFIG.SHOW_MODULES.BING_WALLPAPER && bingData && bingData.success && bingData.data) {
    console.log('   添加Bing壁纸');
    const b = bingData.data;
    const coverUrl = sanitizeUrl(b.cover);
    const copyright = escapeHtml(b.copyright || '');
    // 使用封面图作为顶部大图，并添加遮罩及渐变过渡到深色背景
    headerOverlay = coverUrl ? `
      <div style="position:relative;width:100%;height:220px;background:url('${coverUrl}') no-repeat center center;background-size:cover">
        <div style="position:absolute;top:0;left:0;width:100%;height:100%;background:linear-gradient(to bottom,rgba(2,4,10,0.1) 0%,rgba(2,4,10,0.8) 80%,rgba(2,4,10,1) 100%)"></div>
        <div style="position:absolute;bottom:10px;right:15px;text-align:right;z-index:15">
          <div style="color:rgba(255,255,255,0.7);font-size:10px;text-shadow:0 1px 2px rgba(0,0,0,0.9);max-width:250px;line-height:1.2">${copyright}</div>
        </div>
      </div>
    ` : '';
  }

  // 整体容器：深色背景，科技感字体
  let html = `
    <div style="background-color:#02040a;background-image:radial-gradient(at 0% 0%,rgba(29,78,216,0.15) 0px,transparent 50%),radial-gradient(at 100% 0%,rgba(139,92,246,0.15) 0px,transparent 50%);color:#e2e8f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;max-width:100%;padding:0;min-height:100vh;overflow-x:hidden">
    ${headerOverlay}
  `;

  // 顶部：一言卡片 (类似HUD显示的样式) - 调整位置
  const paddingTop = (CONFIG.SHOW_MODULES.BING_WALLPAPER && bingData && bingData.success) ? '10px' : '24px';
  html += `
    <div style="padding:${paddingTop} 20px 10px">
      <div style="border-left:3px solid #00f3ff;padding-left:15px;margin-bottom:20px">
        <div style="color:${CONFIG.SHOW_MODULES.BING_WALLPAPER&&bingData&&bingData.success?'#94a3b8':'#64748b'};font-size:12px;letter-spacing:2px;margin-bottom:4px">每日情报 / ${simpleDate}</div>
        <div style="color:#fff;font-size:22px;font-weight:bold;letter-spacing:0.5px">${dayOfWeek}</div>
      </div>
      ${shouldShowHitokoto ? `<div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.1);border-radius:12px;padding:16px;position:relative;backdrop-filter:blur(5px);margin-bottom:16px">
        <div style="color:#94a3b8;font-size:14px;line-height:1.6;font-style:italic;margin-bottom:12px">"${escapeHtml(hitokotoData.hitokoto)}"</div>
        <div style="display:flex;justify-content:space-between;align-items:center;font-size:11px"><div style="color:#00f3ff">来源: ${escapeHtml(hitokotoData.from)}</div><div style="color:#475569">${escapeHtml(hitokotoData.type)}</div></div>
      </div>` : ''}
    </div>
  `;

  // 运势跑马灯
  if (CONFIG.SHOW_MODULES.LUCK && luckData && luckData.success && luckData.data) {
    console.log('   添加运势跑马灯');
    const l = luckData.data;
    const luckDesc = escapeHtml(l.luck_desc || '未知');
    const luckTip = escapeHtml(l.luck_tip || '');
    const luckRank = escapeHtml(l.luck_rank || '');
    const scrollText = `🔮 今日运势: ${luckDesc}  •  ${luckTip}  •  运势指数: ${luckRank}  •  ${luckDesc}  •  ${luckTip}`;
    html += `
      <div style="margin:0 0 20px 0;background:rgba(139,92,246,0.1);border-top:1px solid rgba(139,92,246,0.3);border-bottom:1px solid rgba(139,92,246,0.3);padding:8px 0;overflow:hidden;position:relative;white-space:nowrap">
        <div style="display:inline-block;font-size:12px;color:#a78bfa;font-weight:500;letter-spacing:1px;animation:marquee 20s linear infinite">${scrollText} &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; ${scrollText}</div>
        <style>@keyframes marquee{0%{transform:translateX(0)}100%{transform:translateX(-50%)}}</style>
      </div>
    `;
  } else {
    html += `<div style="margin-bottom:20px"></div>`;
  }

  // 主体内容
  html += `<div style="padding:0 20px 30px">`;

  // 天气预警
  if (CONFIG.SHOW_MODULES.WEATHER && alertData && alertData.success && alertData.data && alertData.data.hasAlerts) {
    console.log('   添加天气预警');
    alertData.data.alerts.forEach(alert => {
      const color = {'蓝色':'#3b82f6','黄色':'#eab308','橙色':'#f97316','红色':'#ef4444'}[alert.level] || '#ef4444';
      const headline = escapeHtml(alert.headline || '');
      const description = escapeHtml(alert.description || '');
      html += `<div style="margin-bottom:16px;background:rgba(239,68,68,0.1);border:1px solid ${color};border-left:4px solid ${color};border-radius:8px;padding:12px;display:flex;align-items:flex-start;gap:12px">
          <div style="font-size:20px">⚠️</div>
          <div><div style="color:${color};font-weight:bold;font-size:14px;margin-bottom:4px">${headline}</div><div style="color:#cbd5e1;font-size:12px;line-height:1.4">${description}</div></div>
        </div>`;
    });
  }

  // 降水预报
  if (CONFIG.SHOW_MODULES.WEATHER && precipitationData && precipitationData.success && precipitationData.data && precipitationData.data.hasPrecipitation) {
    console.log('   添加降水预报');
    const p = precipitationData.data;
    const precipSummary = escapeHtml(p.summary || '');
    const precipIntensity = escapeHtml(p.intensity || '');
    const precipStartTime = escapeHtml(p.startTime || '');
    html += `<div style="margin-bottom:10px;background:linear-gradient(90deg,rgba(6,182,212,0.1),transparent);border:1px solid rgba(6,182,212,0.3);border-radius:12px;padding:12px 16px;display:flex;align-items:center;justify-content:space-between">
        <div style="display:flex;align-items:center;gap:10px"><span style="font-size:18px">🌧️</span><div><div style="color:#67e8f9;font-size:14px;font-weight:600">降水预警</div><div style="color:#a5f3fc;font-size:12px">${precipSummary}</div></div></div>
        <div style="text-align:right"><div style="color:#fff;font-size:14px;font-weight:bold">${precipIntensity}</div><div style="color:#67e8f9;font-size:10px">${precipStartTime} 开始</div></div>
      </div>`;
  }

  // 轮播图
  if (CONFIG.SHOW_MODULES.WEATHER && weatherData && weatherData.success && forecastData && forecastData.success) {
    console.log('   添加天气轮播图');
    try {
      html += buildWeatherCarousel(weatherData, forecastData, timeInfo);
    } catch (carouselError) {
      console.error('   ⚠️  天气轮播图构建失败:', carouselError.message);
    }
  }

  // 60秒读懂世界 - 科技感终端风格（真正的无缝循环跑马灯）
  if (CONFIG.SHOW_MODULES.NEWS_60S && news60sData && news60sData.success && news60sData.data && Array.isArray(news60sData.data.news)) {
    console.log('   添加60秒读懂世界');
    const n = news60sData.data;
    const newsDate = escapeHtml(n.date || '');
    const newsTip = escapeHtml(n.tip || '');
    // 生成新闻列表HTML
    const newsItemsHtml = n.news.map((item, index) => `
      <div class="n60-it">
        <span class="n60-idx">[${String(index + 1).padStart(2, '0')}]</span>
        <span class="n60-txt">${escapeHtml(item)}</span>
      </div>
    `).join('');

    // 添加分隔符
    const separator = `
      <div class="n60-sep">
        <div class="n60-sep-line"></div>
        <span class="n60-sep-text">● ● ● 循环播报 ● ● ●</span>
        <div class="n60-sep-line"></div>
      </div>
    `;

    html += `
      <div class="n60-wrap">
        <!-- Header -->
        <div class="n60-hd">
          <div style="display: flex; align-items: center; gap: 8px;">
            <div class="n60-dot"></div>
            <div class="n60-tt">60秒世界摘要</div>
          </div>
          <div class="n60-date">${newsDate}</div>
        </div>

        <!-- Scrolling Content -->
        <div class="n60-cnt">
          <!-- 扫描线效果 -->
          <div class="n60-scan"></div>

          <div class="n60-scroll">
            <!-- 第一份内容 -->
            <div class="n60-content">
              ${newsItemsHtml}
            </div>
            <!-- 分隔符 -->
            ${separator}
            <!-- 第二份内容（用于无缝循环） -->
            <div class="n60-content">
              ${newsItemsHtml}
            </div>
            <!-- 分隔符 -->
            ${separator}
          </div>
        </div>

        <!-- Footer -->
        <div class="n60-ft">
          > TIP: ${newsTip}
          <span class="n60-blk">_</span>
        </div>

        <style>
          .n60-it { margin-bottom: 12px; display: flex; }
          .n60-idx { color: #64748b; margin-right: 8px; font-family: monospace; }
          .n60-txt { color: #e2e8f0; line-height: 1.5; }
          .n60-wrap { margin: 20px 0; background: #0f172a; border: 1px solid rgba(16, 185, 129, 0.3); border-radius: 12px; overflow: hidden; position: relative; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); }
          .n60-hd { background: rgba(16, 185, 129, 0.1); padding: 10px 15px; border-bottom: 1px solid rgba(16, 185, 129, 0.2); display: flex; justify-content: space-between; align-items: center; }
          .n60-dot { width: 8px; height: 8px; background: #10b981; border-radius: 50%; box-shadow: 0 0 8px #10b981; animation: pulse 2s ease-in-out infinite; }
          .n60-tt { color: #10b981; font-weight: bold; font-family: monospace; letter-spacing: 1px; font-size: 13px; }
          .n60-date { color: #64748b; font-size: 10px; font-family: monospace; }
          .n60-cnt { 
            height: 300px; 
            overflow: hidden; 
            position: relative; 
            padding: 15px;
          }
          .n60-scan { 
            position: absolute; 
            top: 0; 
            left: 0; 
            width: 100%; 
            height: 100%; 
            background: linear-gradient(to bottom, transparent, rgba(16, 185, 129, 0.05) 50%, transparent); 
            background-size: 100% 4px; 
            pointer-events: none; 
            z-index: 2;
            animation: scanLine 3s ease-in-out infinite;
          }
          .n60-scroll { 
            /* 真正的无缝循环：滚动距离为一半内容的高度 */
            animation: scrollUpContinuous 90s linear infinite;
            font-size: 13px;
            will-change: transform;
          }
          .n60-content {
            margin-bottom: 20px;
          }
          .n60-sep {
            display: flex;
            align-items: center;
            margin: 20px 0;
            opacity: 0.6;
          }
          .n60-sep-line {
            flex: 1;
            height: 1px;
            background: linear-gradient(to right, transparent, rgba(16, 185, 129, 0.5), transparent);
          }
          .n60-sep-text {
            color: #10b981;
            font-size: 10px;
            font-family: monospace;
            margin: 0 15px;
            white-space: nowrap;
            animation: glow 2s ease-in-out infinite alternate;
          }
          .n60-ft { padding: 8px 15px; border-top: 1px solid rgba(16, 185, 129, 0.2); background: rgba(15, 23, 42, 0.8); font-family: monospace; font-size: 10px; color: #10b981; }
          .n60-blk { animation: blink 1s step-end infinite; }
          
          /* 无缝循环滚动动画 */
          @keyframes scrollUpContinuous {
            0% { 
              transform: translate3d(0, 0, 0); 
            }
            100% { 
              /* 滚动到第一份内容完全消失的位置，此时第二份内容刚好开始显示 */
              transform: translate3d(0, -50%, 0); 
            }
          }
          
          @keyframes blink {
            0%, 100% { opacity: 1; }
            50% { opacity: 0; }
          }
          
          @keyframes pulse {
            0%, 100% { opacity: 1; transform: scale(1); }
            50% { opacity: 0.7; transform: scale(1.1); }
          }
          
          @keyframes glow {
            0% { text-shadow: 0 0 5px rgba(16, 185, 129, 0.5); }
            100% { text-shadow: 0 0 10px rgba(16, 185, 129, 0.8), 0 0 15px rgba(16, 185, 129, 0.3); }
          }
          
          @keyframes scanLine {
            0%, 100% { transform: translateY(0); opacity: 0.3; }
            50% { transform: translateY(20px); opacity: 0.7; }
          }
          
          /* 响应式优化 */
          @media (max-width: 480px) {
            .n60-cnt { height: 250px; }
            .n60-scroll { font-size: 12px; }
            .n60-sep-text { font-size: 9px; margin: 0 10px; }
          }
        </style>
      </div>
    `;
  }

  // 热点榜单
  if (CONFIG.SHOW_MODULES.HOT_LIST && hotData) {
    try {
      const hotListHtml = buildHotListModule(hotData);
      if (hotListHtml) {
        console.log('   添加热点榜单');
        html += hotListHtml;
      }
    } catch (hotListError) {
      console.error('   ⚠️  热点榜单构建失败:', hotListError.message);
    }
  }

  // KFC
  if (CONFIG.SHOW_MODULES.KFC && isThursday && kfcContent && kfcContent.success && kfcContent.content) {
    console.log('   添加KFC文案');
    html += kfcContent.content;
  }

  // 历史上的今天
  if (CONFIG.SHOW_MODULES.HISTORY && historyData && historyData.success) {
    const h = historyData.data;
    const historyDate = escapeHtml(h.date || '');
    const historyItems = h.items.slice(0,10).map(i => {
      const link = sanitizeUrl(i.link);
      const year = escapeHtml(i.year || '');
      const title = escapeHtml(i.title || '');
      const description = escapeHtml((i.description || '').substring(0, 60));
      return `${link ? `<a href="${link}" class="hi" style="display:block;text-decoration:none;color:inherit">` : '<div class="hi">'}<div class="hy">${year}</div><div class="ht">${title}${link ? '<span class="hl">🔗</span>' : ''}</div><div class="hd">${description}...</div>${link ? '</a>' : '</div>'}`;
    }).join('');
    const content = `
      <div style="color:#94a3b8;font-size:12px;margin-bottom:15px">${historyDate} (${h.items.length} 个事件)</div>
      ${historyItems}
      <div style="text-align:center;margin-top:20px;font-size:10px;color:#475569">数据来源: 百度百科</div>
      <style>.hi{margin-bottom:15px;border-left:2px solid #a78bfa;padding-left:12px}.hy{color:#a78bfa;font-size:14px;font-weight:bold;margin-bottom:2px}.ht{color:#e2e8f0;font-size:13px;font-weight:500;margin-bottom:4px;display:flex;align-items:center;justify-content:space-between}.hd{color:#94a3b8;font-size:12px;line-height:1.4}.hl{color:#a78bfa;text-decoration:none;font-size:12px;margin-left:8px;opacity:0.7}</style>
    `;
    html += genDrawer('history-drawer-toggle', '📜', '历史上的今天', content);
  }

  // 今日汇率
  if (CONFIG.SHOW_MODULES.EXCHANGE && rateData && rateData.success) {
    const r = rateData.data;
    const content = `
      <div style="margin-bottom:20px;font-size:12px;color:#94a3b8"><div style="display:flex;justify-content:space-between;margin-bottom:4px"><span>基准货币: <span style="color:#e2e8f0;font-weight:bold">${r.base_code||'CNY'}</span></span><span>更新时间: ${r.updated}</span></div>${r.next_updated?`<div style="text-align:right;font-size:10px;opacity:0.8">下次更新: ${r.next_updated}</div>`:''}</div>
      ${r.rates.map(i => `<div class="ri"><div class="rl"><div class="rn">${i.code}</div><div><div class="rm">${i.name}</div><div class="rc">1 ${i.code} =</div></div></div><div class="rr"><div class="rv">${i.rate} <span class="ru">CNY</span></div><div class="rp" style="color:${i.diffColor||'#94a3b8'}">${r.diffLabel||'涨跌'} ${i.diffStr||'-'}</div></div></div>`).join('')}
      <div style="margin-top:20px;padding:10px;background:rgba(245,158,11,0.1);border-radius:8px;border:1px solid rgba(245,158,11,0.2)"><div style="color:#f59e0b;font-size:12px;line-height:1.4">💡 提示: 数据仅供参考，交易时请以银行柜台成交价为准。</div></div>
      <style>.ri{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;background:rgba(255,255,255,0.05);padding:12px;border-radius:8px;border:1px solid rgba(255,255,255,0.05)}.rl{display:flex;align-items:center}.rn{width:32px;height:32px;background:#334155;color:#fff;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:10px;margin-right:12px;font-weight:bold}.rm{color:#e2e8f0;font-size:14px;font-weight:500}.rc{color:#64748b;font-size:10px}.rr{text-align:right}.rv{color:#00f3ff;font-size:18px;font-weight:bold;font-family:monospace}.ru{font-size:10px;color:#64748b}.rp{font-size:10px}</style>
    `;
    html += genDrawer('rate-drawer-toggle', '💰', '今日汇率', content);
  }

  // AI资讯
  if (CONFIG.SHOW_MODULES.AI_NEWS && aiNewsData && aiNewsData.success) {
    const ai = aiNewsData.data;
    const aiDate = escapeHtml(ai.date || '');
    const aiItems = ai.news.map(i => {
      const link = sanitizeUrl(i.link);
      const title = escapeHtml(i.title || '');
      const detail = escapeHtml(i.detail || '暂无详细描述');
      const source = escapeHtml(i.source || '');
      return `${link ? `<a href="${link}" class="ni" style="display:block;text-decoration:none;color:inherit">` : '<div class="ni">'}<div class="nt">${title}</div><div class="nd">${detail}</div><div class="nf"><div class="ns">${source}</div>${link ? '<span class="nl">查看原文</span>' : ''}</div>${link ? '</a>' : '</div>'}`;
    }).join('');
    const content = `
      <div style="color:#94a3b8;font-size:12px;margin-bottom:20px">更新日期: ${aiDate}</div>
      ${aiItems}
      <style>.ni{margin-bottom:20px;background:rgba(59,130,246,0.05);padding:15px;border-radius:12px;border:1px solid rgba(59,130,246,0.1)}.nt{color:#60a5fa;font-size:15px;font-weight:bold;margin-bottom:8px;line-height:1.4}.nd{color:#cbd5e1;font-size:13px;line-height:1.6;margin-bottom:10px}.nf{display:flex;justify-content:space-between;align-items:center}.ns{color:#64748b;font-size:11px}.nl{color:#3b82f6;font-size:11px;text-decoration:none;padding:2px 8px;border:1px solid #3b82f6;border-radius:4px}</style>
    `;
    html += genDrawer('ai-drawer-toggle', '🤖', 'AI 资讯快报', content);
  }

  // 黄金/白银 - 抽屉组件 (Tab切换 + Grid布局)
  if (CONFIG.SHOW_MODULES.GOLD && goldData && goldData.success) {
    const g = goldData.data || {};
    const goldMetals = Array.isArray(g.metals) ? g.metals : [];
    const goldStores = Array.isArray(g.stores) ? g.stores : [];
    const goldBanks = Array.isArray(g.banks) ? g.banks : [];
    const goldRecycle = Array.isArray(g.recycle) ? g.recycle : [];
    // Compact Helpers
    const R = (n, p, d='') => `<div class="gi"><div class="gh"><span class="gn">${n}</span><div class="gp">${p}</div></div>${d}</div>`;
    const P = (v, u='克', s='¥') => `<span class="gu">${s}</span>${v}<span class="gu">${u?`/${u.replace('元/','')}`:''}</span>`;
    const D = (l, k='') => `<div class="gd ${k}">${l.map(([n,v,c,z])=>`<div><span class="gl">${n}</span><span${c?` style="color:${c}"`:''}${z?` class="${z}"`:''}>${v}</span></div>`).join('')}</div>`;
    
    // Gold Content
    let gh = `<div class="mt-st">基础金价</div>` + (
      goldMetals.length
        ? goldMetals.map(i => R(i.name, P(i.today_price, i.unit), D([
            ['最高', i.high_price, '', 'cr'], ['最低', i.low_price, '', 'cgr'], ['售卖', i.sell_price||'-', '', 'cy'],
            [g.diffLabel||'涨跌', i.diffStr||'-', i.diffColor||'#94a3b8']
          ], 'gd-2'))).join('')
        : '<div style="text-align:center;color:#64748b;padding:20px;">暂无基础金价数据</div>'
    );

    gh += `<div class="mt-st">品牌金价</div>` + (
      goldStores.length
        ? goldStores.slice(0,3).map(i => R(i.brand, P(i.price))).join('')
        : '<div style="text-align:center;color:#64748b;padding:20px;">暂无品牌金价数据</div>'
    );
    if (goldBanks.length) gh += `<div class="mt-st">银行金价</div>` + goldBanks.slice(0,3).map(i => R(i.bank, P(i.price))).join('');
    if (goldRecycle.length) gh += `<div class="mt-st">回收金价</div>` + goldRecycle.map(i => R(i.type, P(i.price))).join('');

    // Silver Content
    let sh = '';
    const S = (l, t) => {
        if(!l?.length) return '';
        return `<div class="mt-st">${t}</div>` + l.map(i => {
            const up = !(i.changepercent||'').includes('-');
            const sym = t.includes('伦敦') ? '$' : '¥';
            return R(i.typename||i.type, P(i.price, t.includes('上海黄金')?i.unit:'', sym), D([
                ['今开', i.openingprice||'-'], ['昨收', i.lastclosingprice||'-'],
                ['最高', i.maxprice||'-', '', 'cr'], ['涨跌', i.changepercent, up?'#f87171':'#4ade80']
            ], 'gd-2'));
        }).join('');
    };
    
    if (silverData && silverData.success) {
        sh += S(silverData.data.shanghai, '上海黄金交易所');
        sh += S(silverData.data.future, '上海期货交易所');
        sh += S(silverData.data.london, '伦敦金银市场');
    }

    html += `
      <input type="checkbox" id="gold-drawer-toggle" style="display: none;">
      <label for="gold-drawer-toggle" class="do"></label>
      <div class="dc gold-drawer">
        <div class="dh"><div class="dt">🏆 贵金属</div><label for="gold-drawer-toggle" class="dx">✕</label></div>
        
        <input type="radio" name="mt-tabs" id="mt-gold" class="mt-inp" checked hidden>
        <input type="radio" name="mt-tabs" id="mt-silver" class="mt-inp" hidden>
        
        <div class="mt-tabs">
            <label for="mt-gold" class="mt-lbl">黄金</label>
            <label for="mt-silver" class="mt-lbl">白银</label>
        </div>
        <div class="mt-cnt mt-c-gold">
            <div style="color:#94a3b8;font-size:12px;margin-bottom:10px">更新时间: ${g.date}</div>${gh}
        </div>
        <div class="mt-cnt mt-c-silver"><div style="color:#94a3b8;font-size:12px;margin-bottom:10px">更新时间: ${g.date}</div>${sh || '<div style="text-align:center;color:#64748b;padding:20px;">暂无白银数据</div>'}</div>
      </div>
      <style>
        #gold-drawer-toggle:checked~.do{display:block}#gold-drawer-toggle:checked~.gold-drawer{right:0!important}
        .mt-tabs{display:flex;gap:10px;margin-bottom:15px}
        
        #mt-gold:checked~.mt-tabs label[for="mt-gold"],
        #mt-silver:checked~.mt-tabs label[for="mt-silver"]{color:#fbbf24;border-color:rgba(251,191,36,0.5)}
        
        .mt-lbl{flex:1;text-align:center;padding:8px;background:rgba(255,255,255,0.05);border-radius:8px;color:#94a3b8;font-size:13px;border:1px solid transparent;transition:all 0.2s}
        .mt-cnt{display:none;animation:fadeIn 0.3s ease}
        #mt-gold:checked~.mt-c-gold,#mt-silver:checked~.mt-c-silver{display:block}
        
        .mt-st{color:#a78bfa;font-size:13px;margin:15px 0 8px;font-weight:bold;border-left:3px solid #a78bfa;padding-left:8px;line-height:1}
        .mt-st:first-child{margin-top:0}
        .gd.gd-2{display:grid;grid-template-columns:1fr 1fr;gap:4px 12px}.gd.gd-2>div{display:flex;justify-content:space-between}
      </style>
    `;
  }

  // 汽油价格
  if (CONFIG.SHOW_MODULES.FUEL && fuelData && fuelData.success) {
    const f = fuelData.data;
    const content = `
      <div style="color:#94a3b8;font-size:12px;margin-bottom:6px">地区: ${f.province} | 更新: ${f.updated}</div>
      <div style="display:flex;justify-content:space-between;margin-bottom:15px;background:rgba(255,255,255,0.05);padding:8px;border-radius:6px">
          <div style="text-align:center;width:48%"><div style="font-size:10px;color:#94a3b8">上次调价</div><div style="font-size:12px;color:#cbd5e1">${f.before_change||'-'}</div></div>
          <div style="width:1px;background:rgba(255,255,255,0.1)"></div>
          <div style="text-align:center;width:48%"><div style="font-size:10px;color:#94a3b8">下次调价</div><div style="font-size:12px;color:#fcd34d">${f.next_change||'-'}</div></div>
      </div>
      ${f.items.map(i => `<div class="fi"><div class="fl"><div class="fn">${i.name}</div><div class="fd">${i.beforePrice?`<span style="opacity:0.6;font-size:9px">前:${i.beforePrice}</span>`:''}</div></div><div class="fr"><div class="fp">${i.price}</div><div class="ff" style="color:${i.diffColor||'#94a3b8'}">${i.diffStr||'-'}${i.changePercent?`<span style="opacity:0.8;margin-left:2px;font-size:9px">${i.changePercent}</span>`:''}</div></div></div>`).join('')}
      ${f.link?`<div style="margin-top:14px;display:flex;justify-content:flex-end"><a href="${f.link}" style="display:inline-flex;align-items:center;gap:6px;padding:6px 10px;background:rgba(56,189,248,0.12);border:1px solid rgba(56,189,248,0.4);border-radius:999px;color:#7dd3fc;font-size:11px;text-decoration:none;letter-spacing:0.3px"><span style="font-size:12px">🔗</span> 数据来源</a></div>`:''}
      <style>.fi{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;background:rgba(255,255,255,0.05);padding:10px;border-radius:8px;border:1px solid rgba(255,255,255,0.05)}.fl{display:flex;flex-direction:column}.fn{color:#e2e8f0;font-size:13px;font-weight:500}.fd{color:#64748b;font-size:10px}.fr{text-align:right}.fp{color:#38bdf8;font-weight:bold;font-family:monospace}.ff{font-size:10px}</style>
    `;
    html += genDrawer('fuel-drawer-toggle', '⛽', '汽油价格', content);
  }

  // 摸鱼日报
  if (CONFIG.SHOW_MODULES.MOYU && moyuData && moyuData.success) {
    const m = moyuData.data;
    const l = m.date?.lunar || {};
    const nh = m.nextHoliday || {};
    const nw = m.nextWeekend || {};
    const cd = m.countdown || {};
    const p = m.progress || {};
    
    // Compact Helpers
    const PB = (t, v) => `<div class="pb"><div class="pt">${t}</div><div class="pv">${v}%</div></div>`;
    const CB = (t, v, c='10b981') => `<div class="pb"><div class="pt">${t}</div><div class="pv" style="color:#${c}">${v}</div></div>`;

    const content = `
      <div style="color:#94a3b8;font-size:12px;margin-bottom:8px">${m.date?.gregorian||''} · ${m.date?.weekday||''}</div>
      <div style="color:#64748b;font-size:11px;margin-bottom:12px">农历: ${l.yearCN||''}${l.monthCN||''}${l.dayCN||''} · ${l.zodiac||''}</div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:12px">${PB('本周',p.week?.percentage||0)}${PB('本月',p.month?.percentage||0)}${PB('本年',p.year?.percentage||0)}</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">${CB('距离周末',cd.toWeekEnd||0)}${CB('距离周五',cd.toFriday||0)}${CB('距离月末',cd.toMonthEnd||0,'f59e0b')}${CB('距离年末',cd.toYearEnd||0,'f59e0b')}</div>
      <div style="margin-top:12px;background:rgba(255,255,255,0.05);padding:10px;border-radius:8px">
        <div style="color:#a78bfa;font-size:12px;font-weight:bold;margin-bottom:6px">下一个节日</div><div style="color:#e2e8f0;font-size:12px">${nh.name||'暂无'} · ${nh.date||''}</div><div style="color:#94a3b8;font-size:10px">倒计时: ${nh.until||0} 天</div>
      </div>
      <div style="margin-top:8px;background:rgba(255,255,255,0.05);padding:10px;border-radius:8px">
        <div style="color:#a78bfa;font-size:12px;font-weight:bold;margin-bottom:6px">下一个周末</div><div style="color:#e2e8f0;font-size:12px">${nw.date||''} · ${nw.weekday||''}</div><div style="color:#94a3b8;font-size:10px">还剩: ${nw.daysUntil||0} 天</div>
      </div>
      ${m.moyuQuote?`<div style="margin-top:12px;background:rgba(255,255,255,0.05);padding:12px;border-radius:8px;color:#e2e8f0;font-size:13px;line-height:1.6">${m.moyuQuote}</div>`:''}
      <style>.pb{background:rgba(255,255,255,0.05);padding:10px;border-radius:8px}.pt{color:#94a3b8;font-size:11px}.pv{color:#06b6d4;font-weight:bold;font-family:monospace}</style>
    `;
    html += genDrawer('moyu-drawer-toggle', '🐟', '摸鱼日报', content);
  }

  // 菜单项配置
  const menuItems = [];
  if (CONFIG.SHOW_MODULES.AI_NEWS && aiNewsData && aiNewsData.success) menuItems.push({ id: 'ai-drawer-toggle', icon: '🤖', color: '#3b82f6' });
  if (CONFIG.SHOW_MODULES.GOLD && goldData && goldData.success) menuItems.push({ id: 'gold-drawer-toggle', icon: '🏆', color: '#f59e0b' });
  if (CONFIG.SHOW_MODULES.EXCHANGE && rateData && rateData.success) menuItems.push({ id: 'rate-drawer-toggle', icon: '💰', color: '#10b981' });
  if (CONFIG.SHOW_MODULES.FUEL && fuelData && fuelData.success) menuItems.push({ id: 'fuel-drawer-toggle', icon: '⛽', color: '#f97316' });
  if (CONFIG.SHOW_MODULES.MOYU && moyuData && moyuData.success) menuItems.push({ id: 'moyu-drawer-toggle', icon: '🐟', color: '#06b6d4' });
  if (CONFIG.SHOW_MODULES.HISTORY && historyData && historyData.success) menuItems.push({ id: 'history-drawer-toggle', icon: '📜', color: '#8b5cf6' });

  // 扇形轮盘菜单 (True Pie Chart with Pure CSS Animation)
  if (menuItems.length > 0) {
    const radius = 80; // 轮盘半径
    const fixedCount = 6; // 固定扇形数量，避免数量过少导致畸形
    const count = fixedCount;
    const sectorAngle = 360 / count; // 每个扇形的角度

    // SVG 扇形路径生成
    const svgSectors = Array.from({ length: fixedCount }).map((_, index) => {
      const hasItem = index < menuItems.length;
      const item = hasItem ? menuItems[index] : { id: '', icon: '', color: 'rgba(255,255,255,0.08)' };
      const startAngle = index * sectorAngle;
      const endAngle = (index + 1) * sectorAngle;

      // 转换为弧度, 0度是正右方。我们希望 0 index 在上方(-90度)。
      const startRad = (startAngle - 90) * Math.PI / 180;
      const endRad = (endAngle - 90) * Math.PI / 180;

      const x1 = radius + radius * Math.cos(startRad);
      const y1 = radius + radius * Math.sin(startRad);
      const x2 = radius + radius * Math.cos(endRad);
      const y2 = radius + radius * Math.sin(endRad);

      const largeArc = sectorAngle > 180 ? 1 : 0;

      const pathData = `M ${radius} ${radius} L ${x1} ${y1} A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2} Z`;

      // 计算中心角度用于图标定位
      const centerAngle = index * sectorAngle + sectorAngle / 2;
      const theta = (centerAngle - 90) * Math.PI / 180;
      const dist = radius * 0.65;
      const iconX = radius + dist * Math.cos(theta);
      const iconY = radius + dist * Math.sin(theta);

      // 交互逻辑：使用 onclick 切换 checkbox
      return `
         <g class="wheel-sector-group" ${hasItem ? `onclick="document.getElementById('${item.id}').checked = !document.getElementById('${item.id}').checked"` : ''} style="cursor: ${hasItem ? 'pointer' : 'default'};">
            <path d="${pathData}" fill="${item.color}" stroke="rgba(255,255,255,0.2)" stroke-width="1" />
            ${hasItem ? `<text x="${iconX}" y="${iconY}" text-anchor="middle" dominant-baseline="central" fill="white" font-size="20" style="pointer-events: none;">${item.icon}</text>` : ''}
         </g>
       `;
    }).join('');

    html += `
      <style>
        @keyframes rotate-wheel {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
        @keyframes rotate-icon {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(-360deg); }
        }
        
        .wheel-container {
          position: fixed;
          bottom: 150px;
          right: -${radius}px;
          width: ${radius * 2}px;
          height: ${radius * 2}px;
          z-index: 999;
          /* 整个容器自动旋转 */
          animation: rotate-wheel 20s linear infinite;
          transform-origin: center center;
          /* 阴影 */
          filter: drop-shadow(-2px 4px 6px rgba(0,0,0,0.3));
        }
        
        /* 鼠标悬停或点击时暂停旋转 */
        .wheel-container:hover, .wheel-container:active {
          animation-play-state: paused;
        }

        /* 扇形组中的文本（图标）反向旋转 */
        .wheel-sector-group text {
           transform-box: fill-box;
           transform-origin: center;
           animation: rotate-icon 20s linear infinite;
        }
        
        .wheel-container:hover text, .wheel-container:active text {
          animation-play-state: paused;
        }
      </style>

      <!-- Rotating Wheel -->
      <div class="wheel-container">
         <svg width="${radius * 2}" height="${radius * 2}" viewBox="0 0 ${radius * 2} ${radius * 2}" style="overflow: visible;">
           ${svgSectors}
           <!-- Center Hole -->
           <circle cx="${radius}" cy="${radius}" r="${radius * 0.2}" fill="#1e293b" stroke="rgba(255,255,255,0.2)" stroke-width="1" style="pointer-events: none;"/>
         </svg>
      </div>
    `;
  }

  // 二维码分享
  if (CONFIG.SHOW_MODULES.QR_CODE) {
    html += `
    <div class="qrc">
      <a href="https://wxpusher.zjiecode.com/api/qrcode/O5f8VIZJDQ5gHTIx9KDzP8rWtNDSEB8cvBltIzHoAZdNuEOjDuNKbD7pKiEmQItv.jpg" class="qrl">
        <div class="qri"></div>
      </a>
      <div class="qrt">点击二维码·订阅推送</div>
    </div>
    `;
  }
  html += `
    <style>
    .f{display:flex}.fa{align-items:center}.fj{justify-content:space-between}.fc{flex-direction:column}
    .rel{position:relative}.abs{position:absolute}
    .br8{border-radius:8px}.br12{border-radius:12px}
    .mb6{margin-bottom:6px}.mb10{margin-bottom:10px}.mb12{margin-bottom:12px}.mb20{margin-bottom:20px}
    .p10{padding:10px}.p12{padding:12px}.p20{padding:20px}
    .cw{color:#fff}.cg{color:#94a3b8}.cy{color:#fcd34d}.cr{color:#f87171}.cgr{color:#4ade80}
    .fs10{font-size:10px}.fs11{font-size:11px}.fs12{font-size:12px}.fs14{font-size:14px}.fs16{font-size:16px}.fs18{font-size:18px}
    .fwb{font-weight:bold}.mono{font-family:monospace}
    .do{position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:1001;display:none;backdrop-filter:blur(2px)}
    .dc{position:fixed;top:0;right:-85%;width:85%;height:100%;background:#0f172a;z-index:1002;box-shadow:-5px 0 15px rgba(0,0,0,0.5);padding:20px;box-sizing:border-box;border-left:1px solid rgba(255,255,255,0.1);overflow-y:auto;transition:right 0.3s ease-in-out}
    .dh{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;border-bottom:1px solid rgba(255,255,255,0.1);padding-bottom:10px}
    .dx{color:#64748b;font-size:20px;cursor:pointer}
    .dt{color:#fff;font-size:18px;font-weight:bold}
    .gi{margin-bottom:12px;background:rgba(245,158,11,0.05);padding:10px;border-radius:8px;border:1px solid rgba(245,158,11,0.1)}
    .gh{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}
    .gn{color:#fcd34d;font-weight:bold;font-size:14px}
    .gp{color:#fff;font-weight:bold;font-family:monospace;font-size:16px}
    .gd{display:flex;justify-content:space-between;font-size:11px;color:#94a3b8;font-family:monospace;white-space:nowrap}
    .gu{font-size:10px;opacity:0.7;font-weight:normal;margin:0 1px}
    .gl{margin-right:2px}
    .fi{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;background:rgba(255,255,255,0.05);padding:10px;border-radius:8px;border:1px solid rgba(255,255,255,0.05)}
    .fl{display:flex;flex-direction:column}
    .fn{color:#e2e8f0;font-size:13px;font-weight:500}
    .fd{color:#64748b;font-size:10px}
    .fr{text-align:right}
    .fp{color:#38bdf8;font-weight:bold;font-family:monospace}
    .ff{font-size:10px}
    .qrc{margin:30px 0 20px;text-align:center;position:relative;z-index:10}
    .qrl{text-decoration:none;display:inline-block}
    .qri{width:100px;height:100px;border-radius:50%;background:url('https://wxpusher.zjiecode.com/api/qrcode/O5f8VIZJDQ5gHTIx9KDzP8rWtNDSEB8cvBltIzHoAZdNuEOjDuNKbD7pKiEmQItv.jpg') no-repeat center center;background-size:cover;box-shadow:0 0 15px rgba(59,130,246,0.8);animation:qb 2s infinite ease-in-out;border:2px solid rgba(255,255,255,0.8)}
    .qrt{margin-top:10px;font-size:10px;color:rgba(255,255,255,0.5)}
    @keyframes qb{0%,100%{transform:scale(1);box-shadow:0 0 15px rgba(59,130,246,0.8)}50%{transform:scale(1.05);box-shadow:0 0 25px rgba(59,130,246,1)}}
    .wc{flex:0 0 100%;scroll-snap-align:center;background:rgba(16,24,40,0.6);border-radius:16px;border:1px solid rgba(0,243,255,0.15);padding:12px;box-sizing:border-box;backdrop-filter:blur(12px);box-shadow:0 8px 32px rgba(0,0,0,0.2);position:relative;overflow:hidden;display:flex;flex-direction:column}
    .wgi{background:rgba(255,255,255,0.05);border-radius:8px;padding:8px;display:flex;align-items:center;gap:8px;overflow:hidden}
    .wai{display:flex;align-items:center;font-size:11px;color:#e2e8f0}
    .wfi{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:rgba(255,255,255,0.02);border-radius:8px;margin-bottom:8px;border-left:3px solid rgba(255,255,255,0.1)}
    .wdg{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-top:25px}
    .wdi{background:rgba(255,255,255,0.03);padding:6px;border-radius:8px;text-align:center}
    .wng{position:absolute;top:-50%;left:-50%;width:200%;height:200%;background:radial-gradient(circle at 50% 50%,rgba(0,243,255,0.03) 0%,transparent 50%);pointer-events:none;z-index:0}
    </style>
  `;

  html += `</div></div>`;

  console.log('✅ HTML内容构建完成');
  return html;
}

// 获取运行模式。定时任务由 workflow 显式传入 RUN_MODE，避免 GitHub Actions 延迟启动后按实际时间误判。
function getRunMode() {
  if (requestedRunMode) {
    if (RUN_MODE_NAMES[requestedRunMode]) {
      console.log(`使用显式运行模式: ${requestedRunMode} (${RUN_MODE_NAMES[requestedRunMode]})`);
      return requestedRunMode;
    }
    console.warn(`忽略无效 RUN_MODE: ${requestedRunMode}`);
  }

  // 本地手动或 RUN_MODE=auto：按实际北京时间判断。
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  const hour = now.getHours();

  if (hour < 10) {
    return 'morning'; // 早安推送
  } else if (hour >= 10 && hour < 14) {
    return 'midday'; // 午间推送
  } else {
    return 'evening'; // 晚间推送
  }
}

function buildDataTasks({ token, timeInfo }) {
  return [
    { key: 'weather', name: '实时天气', enabled: CONFIG.SHOW_MODULES.WEATHER, required: true, timeout: 15000, fetcher: () => getCurrentWeather() },
    { key: 'forecast', name: '天气预报', enabled: CONFIG.SHOW_MODULES.WEATHER, required: true, timeout: 15000, validate: result => Array.isArray(result.data) && result.data.length > 0, fetcher: () => getWeatherForecast() },
    { key: 'precipitation', name: '分钟级降水', enabled: CONFIG.SHOW_MODULES.WEATHER && !!token, timeout: 15000, fetcher: () => getMinutePrecipitation(token) },
    { key: 'alert', name: '天气预警', enabled: CONFIG.SHOW_MODULES.WEATHER && !!token, timeout: 15000, fetcher: () => getWeatherAlerts(token) },
    { key: 'luck', name: '今日运势', enabled: CONFIG.SHOW_MODULES.LUCK, timeout: 12000, fetcher: () => getLuck() },
    { key: 'history', name: '历史上的今天', enabled: CONFIG.SHOW_MODULES.HISTORY, timeout: 12000, fetcher: () => getHistoryToday() },
    { key: 'rate', name: '汇率信息', enabled: CONFIG.SHOW_MODULES.EXCHANGE, timeout: 12000, fetcher: () => getExchangeRate() },
    { key: 'gold', name: '黄金价格', enabled: CONFIG.SHOW_MODULES.GOLD, timeout: 18000, fetcher: () => getGoldPrice() },
    { key: 'silver', name: '白银数据', enabled: CONFIG.SHOW_MODULES.GOLD, timeout: 18000, fetcher: () => getSilverData() },
    { key: 'fuel', name: '汽油价格', enabled: CONFIG.SHOW_MODULES.FUEL, timeout: 18000, fetcher: () => getFuelPrice() },
    { key: 'moyu', name: '摸鱼日报', enabled: CONFIG.SHOW_MODULES.MOYU, timeout: 12000, fetcher: () => getMoyuDaily() },
    { key: 'aiNews', name: 'AI资讯', enabled: CONFIG.SHOW_MODULES.AI_NEWS, timeout: 12000, fetcher: () => getAiNews() },
    { key: 'news60s', name: '60秒读懂世界', enabled: CONFIG.SHOW_MODULES.NEWS_60S, timeout: 18000, fetcher: () => get60sNews() },
    { key: 'bing', name: 'Bing壁纸', enabled: CONFIG.SHOW_MODULES.BING_WALLPAPER, timeout: 12000, fetcher: () => getBingWallpaper() },
    { key: 'kfc', name: 'KFC文案', enabled: CONFIG.SHOW_MODULES.KFC && timeInfo.isThursday, timeout: 10000, fetcher: () => getKfcContent(timeInfo.isThursday) },
    { key: 'hitokoto', name: '一言', enabled: CONFIG.SHOW_MODULES.yiYan, timeout: 12000, validate: result => !!result.hitokoto, fetcher: () => getHitokoto() },
    ...HOT_LIST_DEFINITIONS.map(def => ({
      key: def.key,
      name: def.taskName,
      enabled: CONFIG.SHOW_MODULES.HOT_LIST[def.configKey],
      timeout: 30000,
      group: 'hotList',
      validate: result => getHotListItems(def, result).length > 0,
      fetcher: def.fetcher
    }))
  ];
}

function resolveFallbackResult(result) {
  return result?.success === false && result?.fallback ? result.fallback : result;
}

function isValidHotListItem(def, item) {
  if (!item || typeof item !== 'object') return false;
  try {
    const mapped = def.map(item);
    return Boolean(mapped && mapped.title);
  } catch (error) {
    return false;
  }
}

function getHotListItems(def, result) {
  if (!result?.success || !result.data) return [];
  const items = def.getItems(result.data);
  return Array.isArray(items) ? items.filter(item => isValidHotListItem(def, item)) : [];
}

function isTaskSuccessful(task, result) {
  const resolvedResult = resolveFallbackResult(result);
  return resolvedResult?.success === true && (!task.validate || task.validate(resolvedResult));
}

async function runDataTasks(dataTasks) {
  const enabledTasks = dataTasks.filter(task => task.enabled);
  const taskResults = await Promise.all(
    enabledTasks.map(task => safeAsyncCall(task.fetcher, task.name, task.timeout))
  );
  const dataResults = Object.fromEntries(dataTasks.map(task => [task.key, { success: false, skipped: true }]));

  enabledTasks.forEach((task, index) => {
    dataResults[task.key] = taskResults[index];
  });

  return { enabledTasks, dataResults };
}

function shouldApplyRunModeModules() {
  return isScheduled || hasRunModeOverride;
}

function applyRunModeModules(runMode) {
  // 先重置所有模块为 false（除了始终开启的）
  const alwaysOn = ['LUCK', 'BING_WALLPAPER', 'yiYan', 'KFC'];
  for (const key in CONFIG.SHOW_MODULES) {
    if (!alwaysOn.includes(key)) {
      if (typeof CONFIG.SHOW_MODULES[key] === 'object') {
        for (const subKey in CONFIG.SHOW_MODULES[key]) {
          CONFIG.SHOW_MODULES[key][subKey] = false;
        }
      } else {
        CONFIG.SHOW_MODULES[key] = false;
      }
    }
  }

  if (runMode === 'morning') {
    console.log('🌅 执行早安推送模式: 天气 + 基础 + 60s新闻');
    CONFIG.SHOW_MODULES.WEATHER = true;
    CONFIG.SHOW_MODULES.NEWS_60S = true;
    CONFIG.SHOW_MODULES.QR_CODE = true;
  } else if (runMode === 'midday') {
    console.log('☀️ 执行午间推送模式: 抽屉内容');
    CONFIG.SHOW_MODULES.HISTORY = true;
    CONFIG.SHOW_MODULES.EXCHANGE = true;
    CONFIG.SHOW_MODULES.GOLD = true;
    CONFIG.SHOW_MODULES.FUEL = true;
    CONFIG.SHOW_MODULES.AI_NEWS = true;
    CONFIG.SHOW_MODULES.KFC = false;
  } else if (runMode === 'evening') {
    console.log('🌇 执行晚间推送模式: 热点榜单');
    for (const subKey in CONFIG.SHOW_MODULES.HOT_LIST) {
      CONFIG.SHOW_MODULES.HOT_LIST[subKey] = true;
    }
    CONFIG.SHOW_MODULES.QR_CODE = false;
  }
}

// 主函数
async function main() {
  console.log('========== 开始执行每日消息推送 ==========');
  const runMode = getRunMode();
  console.log(`触发方式: ${isScheduled ? '定时任务' : '手动触发'} `);
  console.log(`运行模式: ${runMode}`);

  // 根据模式调整模块开关。定时任务和显式 RUN_MODE 都应用固定模式，避免手动补发/预览只改日志不改内容。
  if (shouldApplyRunModeModules()) {
    applyRunModeModules(runMode);
  }

  try {
    // 1. 获取时间信息
    const timeInfo = getCurrentTimeInfo();
    console.log(`当前时间: ${timeInfo.dateTime} `);
    console.log(`星期几: ${timeInfo.dayOfWeek} `);
    console.log(`是否是星期四: ${timeInfo.isThursday} `);

    // 2. 获取和风天气Token（仅和风增强天气接口启用且配置完整时需要）
    let token = null;
    if (CONFIG.SHOW_MODULES.WEATHER) {
      if (hasHefengConfig()) {
        try {
          token = await getValidHefengToken();
        } catch (tokenError) {
          console.warn(`天气模块已启用，但和风天气Token获取失败，跳过分钟级降水和天气预警: ${tokenError.message}`);
        }
      } else {
        console.warn('天气模块已启用，但 HEFENG_* 配置不完整，跳过分钟级降水和天气预警');
      }
    } else {
      console.log('天气模块未启用，跳过和风天气Token获取');
    }

    // 3. 构建并并行获取数据
    console.log('开始并行获取所有数据...');
    const startTime = Date.now();
    const dataTasks = buildDataTasks({ token, timeInfo });
    const { enabledTasks, dataResults } = await runDataTasks(dataTasks);
    const endTime = Date.now();
    console.log(`所有数据获取完成，总耗时: ${((endTime - startTime) / 1000).toFixed(2)}秒`);

    const resolvedDataResults = Object.fromEntries(
      Object.entries(dataResults).map(([key, result]) => [key, resolveFallbackResult(result)])
    );

    const weatherData = resolvedDataResults.weather;
    const forecastData = resolvedDataResults.forecast;
    const precipitationData = resolvedDataResults.precipitation;
    const alertData = resolvedDataResults.alert;
    const luckData = resolvedDataResults.luck;
    const historyData = resolvedDataResults.history;
    const rateData = resolvedDataResults.rate;
    const goldData = resolvedDataResults.gold;
    const silverData = resolvedDataResults.silver;
    const fuelData = resolvedDataResults.fuel;
    const moyuData = resolvedDataResults.moyu;
    const aiNewsData = resolvedDataResults.aiNews;
    const news60sData = resolvedDataResults.news60s;
    const bingData = resolvedDataResults.bing;
    const kfcContent = resolvedDataResults.kfc || { success: false, content: '' };
    const hitokotoData = resolvedDataResults.hitokoto;

    const hotData = Object.fromEntries(
      dataTasks
        .filter(task => task.group === 'hotList')
        .map(task => [task.key, resolvedDataResults[task.key]])
    );

    // 打印数据获取统计
    const successCount = enabledTasks.filter(task => isTaskSuccessful(task, dataResults[task.key])).length;
    console.log(`已启用接口成功统计: ${successCount}/${enabledTasks.length} 成功`);

    const failedApis = enabledTasks
      .filter(task => !isTaskSuccessful(task, dataResults[task.key]))
      .map(task => {
        const error = dataResults[task.key]?.error ? `: ${dataResults[task.key].error}` : ': 数据校验未通过';
        return `${task.name}${error}`;
      });

    if (failedApis.length > 0) {
      console.warn(`⚠️  以下已启用接口获取失败: ${failedApis.join(', ')}`);
    } else {
      console.log('✅ 所有已启用接口均已完成并返回成功状态');
    }

    const historyUpdates = [
      rateData?.historyUpdate,
      goldData?.historyUpdate
    ].filter(Boolean);

    // 4. 检查关键数据（基于 task 元数据 required/validate）
    const requiredTasks = dataTasks.filter(task => task.required && task.enabled);
    const failedRequiredTasks = requiredTasks.filter(task => !isTaskSuccessful(task, dataResults[task.key]));

    if (failedRequiredTasks.length > 0) {
      const failedNames = failedRequiredTasks.map(task => task.name).join(', ');
      throw new Error(`关键数据获取失败: ${failedNames}，取消推送以避免内容缺失`);
    }

    const enabledHotListTasks = enabledTasks.filter(task => task.group === 'hotList');
    const hotListSuccessCount = enabledHotListTasks.filter(task => isTaskSuccessful(task, dataResults[task.key])).length;
    if (enabledHotListTasks.length > 0 && hotListSuccessCount === 0) {
      throw new Error('热点榜单已启用，但所有热榜接口均获取失败，取消推送以避免内容缺失');
    }

    // 5. 获取UID（预览模式不需要真实 UID）
    let uidResult = { success: true, uid: 'DRY_RUN' };
    if (isDryRun) {
      console.log('🧪 预览模式，跳过UID获取和实际发送');
    } else {
      console.log('正在获取UID...');
      uidResult = await getLatestUid();
      if (!uidResult.success) {
        throw new Error(`获取UID失败: ${uidResult.error} `);
      }
      console.log(`✅ UID获取成功: ${maskUid(uidResult.uid)}`);
    }

    // 6. 数据完整性验证
    console.log('开始数据完整性验证...');
    const validationTargets = [
      { key: 'timeInfo', valid: !!timeInfo && !!timeInfo.dateTime },
      ...enabledTasks.map(task => ({
        key: task.key,
        valid: validateDataIntegrity(resolvedDataResults[task.key], task.name)
      })),
      { key: 'hotData', valid: hotData && typeof hotData === 'object' }
    ];

    const invalidData = validationTargets
      .filter(({ valid }) => !valid)
      .map(({ key }) => key);

    if (invalidData.length > 0) {
      console.warn(`⚠️  以下数据对象无效: ${invalidData.join(', ')}`);
    } else {
      console.log('✅ 所有数据对象验证通过');
    }

    // 7. 构建HTML内容
    console.log('开始构建HTML内容...');
    let htmlContent;
    try {
      htmlContent = buildHtmlContent(
        timeInfo, 
        hitokotoData, 
        weatherData, 
        forecastData, 
        precipitationData, 
        alertData, 
        luckData, 
        historyData, 
        rateData, 
        goldData, 
        silverData, 
        fuelData, 
        moyuData, 
        aiNewsData, 
        news60sData, 
        bingData, 
        kfcContent, 
        hotData
      );
      
      if (!htmlContent || htmlContent.length === 0) {
        throw new Error('HTML内容构建失败，内容为空');
      }
      
      console.log(`✅ HTML内容构建成功，长度: ${htmlContent.length} 字符`);
    } catch (buildError) {
      console.error('❌ HTML构建过程出错:', buildError);
      throw new Error(`HTML构建失败: ${buildError.message}`);
    }

    // 8. 压缩 HTML 内容 (以满足 wxpusher 40000 字符限制)
    console.log('正在压缩 HTML 内容...');
    let minifiedHtml;
    try {
      minifiedHtml = minify(htmlContent, {
        collapseWhitespace: true,
        removeComments: true,
        minifyCSS: true,
        removeEmptyAttributes: true
      });
      console.log(`✅ HTML压缩完成 - 压缩前: ${htmlContent.length} 字符, 压缩后: ${minifiedHtml.length} 字符`);
      
      if (minifiedHtml.length > MAX_WXPUSHER_CONTENT_LENGTH) {
        console.warn(`⚠️  警告: HTML内容超过${MAX_WXPUSHER_CONTENT_LENGTH}字符限制 (${minifiedHtml.length})`);
      }
    } catch (minifyError) {
      console.error('❌ HTML压缩失败:', minifyError);
      console.log('使用未压缩的HTML内容');
      minifiedHtml = htmlContent;
    }

    const taskReport = {
      dryRun: isDryRun,
      scheduled: isScheduled,
      runMode,
      generatedAt: new Date().toISOString(),
      summary: timeInfo.dateTime,
      htmlLength: htmlContent.length,
      minifiedHtmlLength: minifiedHtml.length,
      wxpusherLimit: MAX_WXPUSHER_CONTENT_LENGTH,
      overLimit: minifiedHtml.length > MAX_WXPUSHER_CONTENT_LENGTH,
      enabledTasks: enabledTasks.map(task => ({
        key: task.key,
        name: task.name,
        success: isTaskSuccessful(task, dataResults[task.key]),
        skipped: dataResults[task.key]?.skipped === true,
        error: dataResults[task.key]?.error || ''
      })),
      failedApis,
      uid: maskUid(uidResult.uid)
    };

    if (isDryRun) {
      const outputs = savePreviewArtifacts({
        reason: 'dry-run',
        htmlContent,
        minifiedHtml,
        report: taskReport,
        dataResults
      });
      console.log('🧪 预览模式完成，已生成预览文件，不发送 WxPusher');
      console.log(`   HTML: ${outputs.htmlPath}`);
      console.log(`   压缩HTML: ${outputs.minifiedHtmlPath}`);
      console.log(`   报告: ${outputs.reportPath}`);
      console.log(`   原始数据: ${outputs.rawDataPath}`);
      console.log('========== 每日消息推送预览执行完成 ==========');
      return;
    }

    if (minifiedHtml.length > MAX_WXPUSHER_CONTENT_LENGTH) {
      const outputs = savePreviewArtifacts({
        reason: 'over-limit',
        htmlContent,
        minifiedHtml,
        report: taskReport,
        dataResults
      });
      console.error(`❌ HTML内容超过WxPusher限制，已取消发送并保存预览: ${minifiedHtml.length}/${MAX_WXPUSHER_CONTENT_LENGTH}`);
      console.error(`   报告: ${outputs.reportPath}`);
      throw new Error('HTML内容超过WxPusher限制，已取消发送');
    }

    // 9. 发送消息
    console.log('准备发送消息...');
    console.log(`正在发送消息到 UID: ${maskUid(uidResult.uid)}...`);
    const sendResult = await sendMessage(minifiedHtml, timeInfo.dateTime, uidResult.uid);

    if (sendResult.success) {
      console.log(`✅ 消息发送成功！消息ID: ${sendResult.messageId || '未知'}`);
      if (historyUpdates.length > 0) {
        saveHistoryData(mergeHistoryUpdates(historyUpdates));
      }
      if (uidResult.uidDataToSave) {
        saveLatestUid(uidResult.uidDataToSave);
      }
    } else {
      throw new Error('消息发送失败');
    }

    console.log('========== 每日消息推送执行完成 ==========');

  } catch (error) {
    console.error('❌ 执行过程中发生错误:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// 执行主函数
main();
