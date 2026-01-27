// send-message.js
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// 从命令行参数判断是否是定时触发
const isScheduled = process.argv[2] === 'true';

// 配置
const CONFIG = require('./config');
// 动态导入 jose 库（ESM）
let jose;
async function importJose() {
  if (!jose) {
    jose = await import('jose');
  }
  return jose;
}

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
    console.log('   Header:', JSON.stringify(customHeader));
    console.log('   Payload:', JSON.stringify(customPayload));
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
      created_at: new Date().toISOString(),
      header: customHeader,
      payload: customPayload
    };

  } catch (error) {
    console.error('生成JWT Token失败:', error.message);
    throw new Error(`生成Token失败: ${error.message}`);
  }
}

// 获取存储的UID
function getStoredUid() {
  try {
    const uidPath = path.join(__dirname, '../data/latest_uid.json');
    if (fs.existsSync(uidPath)) {
      const data = JSON.parse(fs.readFileSync(uidPath, 'utf8'));
      console.log(`📁 从本地文件读取UID: ${data.uid} (更新时间: ${data.updated}, 触发方式: ${data.trigger || '未知'})`);
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

// 获取最新的UID（优化：只有定时任务时才调用API）
async function getLatestUid() {
  try {
    let latestUid;
    let shouldUpdateFile = false;

    if (isScheduled) {
      // 定时任务：从API获取最新UID
      console.log('⏰ 定时任务，正在获取最新的UID...');
      const response = await axios.get(CONFIG.UID_API, {
        timeout: 10000
      });

      if (response.data.code === 200 && response.data.data && response.data.data.length > 0) {
        latestUid = response.data.data[0].uid;
        console.log(`获取到的UID: ${latestUid}`);
        shouldUpdateFile = true;
      } else {
        throw new Error('UID API返回数据格式异常');
      }
    } else {
      // 手动触发：从本地存储读取
      console.log('👆 手动触发，从本地存储读取UID...');
      const storedUid = getStoredUid();
      if (storedUid.success) {
        latestUid = storedUid.uid;
        shouldUpdateFile = false; // 手动触发不更新文件，但会存储（如果需要）
      } else {
        throw new Error('手动触发时未找到本地UID文件，请先运行一次定时任务');
      }
    }

    // 存储到文件（无论是定时还是手动都存储，记录触发方式）
    if (latestUid) {
      try {
        const dataDir = path.join(__dirname, '../data');
        if (!fs.existsSync(dataDir)) {
          fs.mkdirSync(dataDir, { recursive: true });
        }
        const uidData = {
          uid: latestUid,
          updated: new Date().toISOString(),
          trigger: isScheduled ? 'scheduled' : 'manual',
          source: isScheduled ? 'api' : 'local_storage'
        };
        fs.writeFileSync(
          path.join(dataDir, 'latest_uid.json'),
          JSON.stringify(uidData, null, 2)
        );
        console.log(`✅ UID已存储到本地文件 (触发方式: ${isScheduled ? '定时任务' : '手动触发'})`);
      } catch (error) {
        console.error('存储UID到文件失败:', error.message);
      }

      return {
        success: true,
        uid: latestUid
      };
    } else {
      throw new Error('无法获取UID');
    }
  } catch (error) {
    console.error('获取最新UID失败:', error.message);

    // 对于手动触发，如果读取本地文件失败，就直接失败
    if (!isScheduled) {
      throw new Error(`手动触发时获取UID失败: ${error.message}`);
    }

    // 对于定时任务，尝试从存储获取
    console.log('尝试从本地存储获取UID...');
    const storedUid = getStoredUid();
    if (storedUid.success) {
      return storedUid;
    }

    throw new Error(`获取UID失败: ${error.message}`);
  }
}

// 获取实时天气
async function getCurrentWeather() {
  try {
    console.log(`正在获取${CONFIG.LOCATION}实时天气...`);
    const response = await axios.get(`${CONFIG.WEATHER_API_BASE}/weather`, {
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

    // 降级处理：返回模拟数据
    console.warn('⚠️ 使用模拟降水数据');
    return getMockMinutePrecipitation();
  }
}

// 模拟分钟级降水数据（降级使用）
function getMockMinutePrecipitation() {
  const hasPrecipitation = Math.random() > 0.7;
  const precipitationType = ['雨', '雪'][Math.floor(Math.random() * 2)];
  const intensity = ['小雨', '中雨', '大雨'][Math.floor(Math.random() * 3)];
  const startTime = '未来15分钟';
  const endTime = '持续约1小时';

  return {
    success: true,
    data: {
      hasPrecipitation,
      precipitationType,
      intensity,
      startTime,
      endTime,
      summary: hasPrecipitation ? `${intensity}即将开始` : '暂无降水',
      maxPrecip: hasPrecipitation ? (Math.random() * 0.5).toFixed(2) : '0.00',
      updateTime: new Date().toISOString()
    },
    isSevere: intensity === '大雨' || intensity === '大雪'
  };
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

    // 降级处理：返回模拟数据
    console.warn('⚠️ 使用模拟预警数据');
    return getMockWeatherAlerts();
  }
}

// 模拟天气预警数据（降级使用）
function getMockWeatherAlerts() {
  const alerts = [];

  if (Math.random() > 0.8) {
    const alertTypes = [
      { type: '暴雨', level: '黄色', colorCode: 'yellow', desc: '预计未来6小时内将有暴雨，请注意防范' },
      { type: '大风', level: '蓝色', colorCode: 'blue', desc: '预计未来24小时内将有6-7级大风' },
      { type: '雷电', level: '黄色', colorCode: 'yellow', desc: '预计未来2小时内将有雷电活动' },
      { type: '高温', level: '橙色', colorCode: 'orange', desc: '预计最高气温将达38℃以上' }
    ];

    const randomAlert = alertTypes[Math.floor(Math.random() * alertTypes.length)];
    alerts.push({
      type: randomAlert.type,
      level: randomAlert.level,
      colorCode: randomAlert.colorCode,
      description: randomAlert.desc,
      headline: `${randomAlert.level}${randomAlert.type}预警`,
      time: new Date().toLocaleString('zh-CN'),
      effectiveTime: '立即生效',
      expireTime: new Date(Date.now() + 12 * 60 * 60 * 1000).toLocaleString('zh-CN'), // 12小时后
      severity: randomAlert.level === '橙色' || randomAlert.level === '红色' ? '严重' : '中等',
      instruction: '请关注官方预警信息，做好防范措施'
    });
  }

  return {
    success: true,
    data: {
      alerts,
      hasAlerts: alerts.length > 0,
      count: alerts.length
    }
  };
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
      const kfcText = response.data.data.kfc;
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

// 获取一言
async function getHitokoto() {
  try {
    console.log('正在获取一言内容...');
    const response = await axios.get(CONFIG.HITOKOTO_API, {
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
      const historyRates = historyData.exchange || {};
      const newHistoryRates = {};

      for (const cur of targetCurrencies) {
        const item = allRates.find(r => r.currency === cur);
        if (item) {
          // API返回的是 1 CNY = X 外币，我们需要算 1 外币 = Y CNY
          const rate = parseFloat((1 / item.rate).toFixed(4));
          
          // 计算涨跌
          const lastRate = historyRates[cur] || 0;
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
      
      // Save updated history
      historyData.exchange = newHistoryRates;
      saveHistoryData(historyData);

      console.log(`获取到汇率数据: ${displayRates.length} 条`);
      return {
        success: true,
        data: {
          updated: response.data.data.updated,
          rates: displayRates
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

// 获取黄金价格
async function getGoldPrice() {
  try {
    console.log('正在获取黄金价格...');
    const response = await axios.get(CONFIG.GOLD_API, {
      params: { encoding: 'json' },
      timeout: 10000
    });

    if (response.data.code === 200) {
      console.log(`获取到黄金价格数据: ${response.data.data.date}`);
      
      const data = response.data.data;
      const historyData = getHistoryData();
      const historyGold = historyData.gold || {};
      const newHistoryGold = {};
      
      // Compare Metals
      if (data.metals && Array.isArray(data.metals)) {
          data.metals = data.metals.map(item => {
              const lastPrice = historyGold[item.name] || 0;
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
      
      historyData.gold = newHistoryGold;
      saveHistoryData(historyData);

      return {
        success: true,
        data: data
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

async function getFuelPrice() {
  try {
    console.log('正在获取汽油价格...');
    const response = await axios.get(CONFIG.FUEL_API, {
      params: {
        region: CONFIG.LOCATION,
        encoding: 'json'
      },
      timeout: 10000
    });

    if (response.data.code === 200) {
      const data = response.data.data;
      const historyData = getHistoryData();
      const historyFuel = historyData.fuel || {};
      const newHistoryFuel = {};

      if (data.items && Array.isArray(data.items)) {
        data.items = data.items.map(item => {
          const currentPrice = parseFloat(item.price);
          const lastPrice = historyFuel[item.name] || 0;
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

          newHistoryFuel[item.name] = currentPrice;

          return {
            ...item,
            diffStr,
            diffColor
          };
        });
      }

      historyData.fuel = newHistoryFuel;
      saveHistoryData(historyData);

      return {
        success: true,
        data: data
      };
    } else {
      throw new Error(`汽油价格API返回错误: ${response.data.message}`);
    }
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

// 通用API获取函数
async function fetchApi(url, name) {
  try {
    console.log(`正在获取${name}...`);
    const response = await axios.get(url, {
      params: { encoding: 'json' },
      timeout: 10000
    });
    if (response.data.code === 200) {
      return { success: true, data: response.data.data };
    } else {
      // 部分接口可能直接返回数组或对象，视具体情况而定，但这里假设遵循标准结构
      return { success: true, data: response.data.data };
    }
  } catch (error) {
    console.error(`获取${name}失败:`, error.message);
    return { success: false, error: error.message };
  }
}

async function getRedNoteHot() { return fetchApi(CONFIG.REDNOTE_API, '小红书热点'); }
async function getWeiboHot() { return fetchApi(CONFIG.WEIBO_API, '微博热搜'); }
async function getToutiaoHot() { return fetchApi(CONFIG.TOUTIAO_API, '头条热搜'); }
async function getZhihuHot() { return fetchApi(CONFIG.ZHIHU_API, '知乎热榜'); }
async function getMaoyanMovie() { return fetchApi(CONFIG.MAOYAN_MOVIE_API, '猫眼电影'); }
async function getMaoyanTv() { return fetchApi(CONFIG.MAOYAN_TV_API, '猫眼电视'); }
async function getMaoyanWeb() { return fetchApi(CONFIG.MAOYAN_WEB_API, '猫眼网剧'); }
async function getDouyinHot() { return fetchApi(CONFIG.DOUYIN_API, '抖音热搜'); }
async function getBiliHot() { return fetchApi(CONFIG.BILI_API, 'B站热搜'); }
async function getQuarkHot() { return fetchApi(CONFIG.QUARK_API, '夸克热点'); }
async function getBaiduHot() { return fetchApi(CONFIG.BAIDU_HOT_API, '百度热搜'); }
async function getBaiduTeleplay() { return fetchApi(CONFIG.BAIDU_TELEPLAY_API, '百度电视剧'); }
async function getBaiduTieba() { return fetchApi(CONFIG.BAIDU_TIEBA_API, '百度贴吧'); }
async function getDongchediHot() { return fetchApi(CONFIG.DONGCHEDI_API, '懂车帝热搜'); }

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

  // 基础卡片样式
  const cardStyle = `
    flex: 0 0 100%; 
    scroll-snap-align: center; 
    background: rgba(16, 24, 40, 0.6); 
    border-radius: 16px; 
    border: 1px solid rgba(0, 243, 255, 0.15); 
    padding: 12px; 
    box-sizing: border-box;
    backdrop-filter: blur(12px);
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
    position: relative;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  `;

  const neonGlow = `
    position: absolute;
    top: -50%;
    left: -50%;
    width: 200%;
    height: 200%;
    background: radial-gradient(circle at 50% 50%, rgba(0, 243, 255, 0.03) 0%, transparent 50%);
    pointer-events: none;
    z-index: 0;
  `;

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
  let cssStyles = '';

  if (indicesToShow.length > 0) {
    const count = indicesToShow.length;
    const itemDuration = 6; // 6 seconds per item to allow horizontal scroll
    const totalDuration = count * itemDuration;
    const stepPercent = 100 / count;
    
    // 1. Define Keyframes
    cssStyles += `<style>
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

        gridItems += `
          <div id="grid-item-${uniqueId}-${i}" style="
            background: rgba(255,255,255,0.03); 
            border-color: rgba(255,255,255,0.05);
            padding: 6px 8px; 
            border-radius: 8px; 
            border: 1px solid rgba(255,255,255,0.05);
            display: flex;
            align-items: center;
            gap: 6px;
            transition: all 0.3s ease;
          ">
            <div style="font-size: 16px;">${icon}</div>
            <div style="flex: 1; min-width: 0;">
              <div style="font-size: 11px; color: #a78bfa; margin-bottom: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${item.name}</div>
              <div style="font-size: 10px; color: #fff;">${item.level || item.status || ''}</div>
            </div>
          </div>
        `;
        
        // 3. Advice Item
        let adviceText = item.description || item.detail || item.category || item.text || item.desc || "暂无详细建议";
        adviceItems += `
            <div style="
                height: 36px; 
                display: flex; 
                align-items: center; 
                font-size: 12px; 
                color: #e2e8f0; 
                width: 100%;
                overflow: hidden;
            ">
                <span style="color: #f472b6; margin-right: 8px; font-weight: bold; flex-shrink: 0; background: rgba(0,0,0,0.4); z-index: 2; padding-right: 6px;">${item.name}</span>
                <div style="flex: 1; overflow: hidden; white-space: nowrap;">
                    <span class="h-scroll-${uniqueId}">${adviceText}</span>
                </div>
            </div>
        `;
    });
    
    cssStyles += '</style>';
  } else {
    gridItems = '<div style="color: #64748b; font-size: 12px; text-align: center; padding: 12px; grid-column: span 2;">暂无生活指数数据</div>';
    adviceItems = '<div style="color: #64748b; font-size: 11px; height: 36px; display: flex; align-items: center;">暂无建议</div>';
  }

  // slide1: 实时天气 + 日出日落可视化
  const slide1 = `
    <div class="slide-item-${uniqueId}" data-index="0" style="${cardStyle}">
      ${cssStyles}
      <div style="${neonGlow}"></div>
      <div style="position: relative; z-index: 1; flex: 1; display: flex; flex-direction: column;">
        <!-- Header -->
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 2px;">
          <div style="font-size: 16px; font-weight: bold; color: #fff;">${w.location}</div>
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
              <text x="20" y="115" fill="#94a3b8" font-size="10" text-anchor="middle">${w.sunrise}</text>
              <text x="180" y="115" fill="#94a3b8" font-size="10" text-anchor="middle">${w.sunset}</text>
           </svg>
           <!-- Center Temp -->
           <div style="position: absolute; top: 30px; left: 0; width: 100%; text-align: center;">
              <div style="display: flex; justify-content: center; align-items: center; gap: 8px;">
                 <span style="font-size: 28px;">${currentIcon}</span>
                 <span style="font-size: 36px; font-weight: 300; color: #fff;">${w.temperature}°</span>
              </div>
           </div>
        </div>

        <!-- Details Grid -->
        <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; margin-top: 25px;">
           <div style="background: rgba(255,255,255,0.03); padding: 6px; border-radius: 8px; text-align: center;">
             <div style="font-size: 12px; margin-bottom: 2px;">💧</div>
             <div style="font-size: 10px; color: #64748b;">湿度</div>
             <div style="font-size: 12px; color: #e2e8f0;">${w.humidity}%</div>
           </div>
           <div style="background: rgba(255,255,255,0.03); padding: 6px; border-radius: 8px; text-align: center;">
             <div style="font-size: 12px; margin-bottom: 2px;">🌬️</div>
             <div style="font-size: 10px; color: #64748b;">${w.wind_direction}</div>
             <div style="font-size: 12px; color: #e2e8f0;">${w.wind_power}</div>
           </div>
           <div style="background: rgba(255,255,255,0.03); padding: 6px; border-radius: 8px; text-align: center;">
             <div style="font-size: 12px; margin-bottom: 2px;">⏲️</div>
             <div style="font-size: 10px; color: #64748b;">气压</div>
             <div style="font-size: 12px; color: #e2e8f0;">${w.pressure}hPa</div>
           </div>
           <div style="background: rgba(255,255,255,0.03); padding: 6px; border-radius: 8px; text-align: center;">
             <div style="font-size: 12px; margin-bottom: 2px;">☔</div>
             <div style="font-size: 10px; color: #64748b;">降水</div>
             <div style="font-size: 12px; color: #e2e8f0;">${w.precipitation}mm</div>
           </div>
           <div style="background: rgba(255,255,255,0.03); padding: 6px; border-radius: 8px; text-align: center;">
             <div style="font-size: 12px; margin-bottom: 2px;">😷</div>
             <div style="font-size: 10px; color: #64748b;">PM2.5</div>
             <div style="font-size: 12px; color: #e2e8f0;">${w.pm25}</div>
           </div>
           <div style="background: rgba(255,255,255,0.03); padding: 6px; border-radius: 8px; text-align: center;">
             <div style="font-size: 12px; margin-bottom: 2px;">🍃</div>
             <div style="font-size: 10px; color: #64748b;">空气 ${w.aqi || ''}</div>
             <div style="font-size: 12px; color: ${w.airQuality === '优' ? '#4ade80' : '#facc15'};">${w.airQuality}</div>
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
    forecastHtml += `
      <div style="
        display: flex; align-items: center; justify-content: space-between; 
        padding: 10px 12px; 
        background: rgba(255,255,255,0.02); 
        border-radius: 8px; 
        margin-bottom: 8px;
        border-left: 3px solid ${index === 0 ? '#00f3ff' : 'rgba(255,255,255,0.1)'};
      ">
        <div style="display: flex; flex-direction: column; width: 60px;">
          <span style="font-size: 14px; color: #e2e8f0;">${day.dayName}</span>
          <span style="font-size: 10px; color: #64748b;">${day.dayCondition}</span>
        </div>
        <div style="font-size: 20px;">${day.dayIcon}</div>
        <!-- Wind Info -->
        <div style="display: flex; flex-direction: column; align-items: center; width: 60px;">
            <span style="font-size: 10px; color: #94a3b8;">${day.windDirection}</span>
            <span style="font-size: 10px; color: #64748b;">${day.windPower}</span>
        </div>
        <div style="text-align: right; width: 40px;">
          <div style="font-size: 16px; color: #fff; font-weight: 500;">${day.maxTemp}°</div>
          <div style="font-size: 10px; color: #64748b;">${day.minTemp}°</div>
        </div>
      </div>
    `;
  });

  const slide2 = `
    <div class="slide-item-${uniqueId}" data-index="1" style="${cardStyle}">
      <div style="${neonGlow}"></div>
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
  const tabs = [
    { id: 'douyin', name: '抖音', data: hotData.douyin, type: 'list', config: 'DOUYIN',
      map: item => ({ title: item.title, desc: `热度: ${item.hot_value}`, link: item.link, rank: null }) },
    { id: 'bili', name: 'B站', data: hotData.bili, type: 'list', config: 'BILI',
      map: item => ({ title: item.title, desc: '', link: item.link, rank: null }) },
    { id: 'weibo', name: '微博', data: hotData.weibo, type: 'list', config: 'WEIBO',
      map: item => ({ title: item.title, desc: `热度: ${item.hot_value}`, link: item.link, rank: null }) },
    { id: 'rednote', name: '小红书', data: hotData.rednote, type: 'list', config: 'REDNOTE',
      map: item => ({ title: item.title, desc: `热度: ${item.score}`, link: item.link, rank: item.rank }) },
    { id: 'toutiao', name: '头条', data: hotData.toutiao, type: 'list', config: 'TOUTIAO',
      map: item => ({ title: item.title, desc: `热度: ${item.hot_value}`, link: item.link, rank: null }) },
    { id: 'zhihu', name: '知乎', data: hotData.zhihu, type: 'list', config: 'ZHIHU',
      map: item => ({ title: item.title, desc: item.hot_value_desc || item.detail, link: item.link, rank: null }) },
    { id: 'quark', name: '夸克', data: hotData.quark, type: 'list', config: 'QUARK',
      map: item => ({ title: item.title, desc: item.hot_value, link: item.link, rank: null }) },
    { id: 'baidu', name: '百度', data: hotData.baiduHot, type: 'list', config: 'BAIDU',
      map: item => ({ title: item.title, desc: item.desc, link: item.url, rank: item.rank }) },
    { id: 'tieba', name: '贴吧', data: hotData.baiduTieba, type: 'list', config: 'TIEBA',
      map: item => ({ title: item.title, desc: item.desc, link: item.url, rank: item.rank }) },
    { id: 'dongchedi', name: '懂车帝', data: hotData.dongchedi, type: 'list', config: 'DONGCHEDI',
      map: item => ({ title: item.title, desc: '', link: item.url, rank: null }) },
    { id: 'movie', name: '电影', data: hotData.maoyanMovie, type: 'maoyan', config: 'MOVIE',
      map: item => ({ title: item.movie_name, desc: `${item.box_office}${item.box_office_unit}` }) },
    { id: 'tv', name: '剧集', data: hotData.maoyanTv, type: 'maoyan', config: 'TV',
      map: item => ({ title: item.programme_name, desc: item.market_rate_desc }) },
    { id: 'web', name: '网剧', data: hotData.maoyanWeb, type: 'maoyan', config: 'WEB',
      map: item => ({ title: item.series_name, desc: item.curr_heat_desc }) },
  ];

  let tabsHtml = '';
  
  tabs.forEach((tab, index) => {
    if (!CONFIG.SHOW_MODULES.HOT_LIST[tab.config]) return;
    if (!tab.data || !tab.data.success || !tab.data.data) return;
    
    const rawList = tab.type === 'maoyan' ? tab.data.data.list : tab.data.data;
    if (!Array.isArray(rawList) || rawList.length === 0) return;
    
    const items = rawList.slice(0, 10).map((item, idx) => {
       const mapped = tab.map(item);
       const rank = mapped.rank || idx + 1;
       let rankColor = '#64748b'; // default
       if (rank === 1) rankColor = '#ef4444'; // Red
       else if (rank === 2) rankColor = '#f97316'; // Orange
       else if (rank === 3) rankColor = '#facc15'; // Yellow
       
       // Marquee logic: if title is long (>16 chars), add scrolling class
       const isLong = mapped.title.length > 16;
       const titleHtml = isLong 
         ? `<div class="ht-tt-scroll"><span class="ht-tt-inner">${mapped.title}</span></div>`
         : `<div class="ht-tt">${mapped.title}</div>`;
       
       return `
         <div class="ht-it">
           <div class="ht-rk" style="color: ${rankColor}">${rank}</div>
           <div class="ht-ct">
             ${titleHtml}
             <div class="ht-dc">${mapped.desc}</div>
           </div>
           ${mapped.link ? `<a href="${mapped.link}" class="ht-lk">🔗</a>` : ''}
         </div>
       `;
    }).join('');
    
    tabsHtml += `
      <input type="radio" name="hot-tabs" id="tab-${tab.id}" class="tb-inp" hidden>
      <label for="tab-${tab.id}" class="tb-lbl" style="order: ${index + 1};">${tab.name}</label>
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
    .ht-tt-inner{display:inline-block;white-space:nowrap;color:#e2e8f0;font-size:13px;line-height:24px;animation:marquee 10s linear infinite}
    .ht-dc{color:#64748b;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .ht-lk{color:#64748b;text-decoration:none;font-size:12px;margin-left:8px;opacity:0.5;flex-shrink:0}
    .tb-lbl{padding:4px 12px;border-radius:99px;background:rgba(255,255,255,0.05);color:#94a3b8;font-size:11px;cursor:pointer;border:1px solid rgba(255,255,255,0.05);transition:all 0.2s;user-select:none}
    .tb-inp:checked+.tb-lbl{background:rgba(244,63,94,0.15);color:#f43f5e;border-color:rgba(244,63,94,0.4);font-weight:bold}
    .tb-cnt{display:none;margin-top:15px;max-height:400px;overflow-y:auto}
    .tb-inp:checked+.tb-lbl+.tb-cnt{display:block;animation:fadeIn 0.3s ease}
    @keyframes fadeIn{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:translateY(0)}}
    @keyframes marquee{0%{transform:translateX(0)}100%{transform:translateX(-50%)}}
    </style>
  `;
}

// 构建HTML内容 - 科技感设计
function buildHtmlContent(timeInfo, hitokotoData, weatherData, forecastData, precipitationData, alertData, luckData, historyData, rateData, goldData, fuelData, moyuData, aiNewsData, news60sData, bingData, kfcContent, hotData) {
  const { dateTime, dayOfWeek, isThursday, simpleDate, time } = timeInfo;

  // 壁纸处理：如果获取成功且开关开启展示，否则展示默认深色背景
  let bgStyle = '';
  let headerOverlay = '';

  if (CONFIG.SHOW_MODULES.BING_WALLPAPER && bingData && bingData.success) {
    const b = bingData.data;
    // 使用封面图作为顶部大图，并添加遮罩及渐变过渡到深色背景
    headerOverlay = `
      <div style="
        position: relative; 
        width: 100%; 
        height: 220px; 
        background: url('${b.cover}') no-repeat center center; 
        background-size: cover;
      ">
        <div style="
          position: absolute; 
          top: 0; left: 0; width: 100%; height: 100%;
          background: linear-gradient(to bottom, rgba(2,4,10,0.1) 0%, rgba(2,4,10,0.8) 80%, rgba(2,4,10,1) 100%);
        "></div>
        <div style="
          position: absolute;
          bottom: 10px;
          right: 15px;
          text-align: right;
          z-index: 15;
        ">
          <div style="color: rgba(255,255,255,0.7); font-size: 10px; text-shadow: 0 1px 2px rgba(0,0,0,0.9); max-width: 250px; line-height: 1.2;">${b.copyright}</div>
        </div>
      </div>
    `;
  }

  // 整体容器：深色背景，科技感字体
  let html = `
    <div style="
      background-color: #02040a; 
      background-image: 
        radial-gradient(at 0% 0%, rgba(29, 78, 216, 0.15) 0px, transparent 50%), 
        radial-gradient(at 100% 0%, rgba(139, 92, 246, 0.15) 0px, transparent 50%);
      color: #e2e8f0; 
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; 
      max-width: 100%; 
      padding: 0;
      min-height: 100vh;
      overflow-x: hidden; 
    ">
    
    ${headerOverlay}
  `;

  // 顶部：一言卡片 (类似HUD显示的样式) - 调整位置
  // 去除负 margin，让布局更自然，避免遮挡
  const paddingTop = (CONFIG.SHOW_MODULES.BING_WALLPAPER && bingData && bingData.success) ? '10px' : '24px';
  const showYiYan = CONFIG.SHOW_MODULES.yiYan;

  html += `
    <div style="padding: ${paddingTop} 20px 10px;">
      <div style="border-left: 3px solid #00f3ff; padding-left: 15px; margin-bottom: 20px;">
        <div style="color: ${CONFIG.SHOW_MODULES.BING_WALLPAPER && bingData && bingData.success ? '#94a3b8' : '#64748b'}; font-size: 12px; letter-spacing: 2px; margin-bottom: 4px;">每日情报 / ${simpleDate}</div>
        <div style="color: #fff; font-size: 22px; font-weight: bold; letter-spacing: 0.5px;">${dayOfWeek}</div>
      </div>

      ${showYiYan ? `
      <div style="
        background: rgba(255, 255, 255, 0.03); 
        border: 1px solid rgba(255, 255, 255, 0.1); 
        border-radius: 12px; 
        padding: 16px; 
        position: relative;
        backdrop-filter: blur(5px);
        margin-bottom: 16px;
      ">
        <div style="color: #94a3b8; font-size: 14px; line-height: 1.6; font-style: italic; margin-bottom: 12px;">
          "${hitokotoData.hitokoto}"
        </div>
        <div style="display: flex; justify-content: space-between; align-items: center; font-size: 11px;">
          <div style="color: #00f3ff;">来源: ${hitokotoData.from}</div>
          <div style="color: #475569;">${hitokotoData.type}</div>
        </div>
      </div>
      ` : ''}
    </div>
  `;


  // 运势跑马灯 (在顶部信息下方)
  if (CONFIG.SHOW_MODULES.LUCK && luckData && luckData.success) {
    const l = luckData.data;
    const scrollText = `🔮 今日运势: ${l.luck_desc}  •  ${l.luck_tip}  •  运势指数: ${l.luck_rank}  •  ${l.luck_desc}  •  ${l.luck_tip}`; // 重复内容以确保填满

    html += `
      <div style="
        margin: 0 0 20px 0;
        background: rgba(139, 92, 246, 0.1);
        border-top: 1px solid rgba(139, 92, 246, 0.3);
        border-bottom: 1px solid rgba(139, 92, 246, 0.3);
        padding: 8px 0;
        overflow: hidden;
        position: relative;
        white-space: nowrap;
      ">
        <div style="
          display: inline-block;
          font-size: 12px;
          color: #a78bfa;
          font-weight: 500;
          letter-spacing: 1px;
          animation: marquee 20s linear infinite;
        ">
          ${scrollText} &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; ${scrollText}
        </div>
        <!-- 定义Keyframes，虽然内联样式不支持keyframes，但部分客户端可能会解析style标签，尝试兼容 -->
        <style>
          @keyframes marquee {
            0% { transform: translateX(0); }
            100% { transform: translateX(-50%); }
          }
        </style>
      </div>
    `;
  } else { // 如果没有运势数据，添加一个空的间距
    html += `<div style="margin-bottom: 20px;"></div>`;
  }

  // 主体内容
  html += `<div style="padding: 0 20px 30px;">`;

  // 天气预警
  if (CONFIG.SHOW_MODULES.WEATHER && alertData.success && alertData.data.hasAlerts) {
    alertData.data.alerts.forEach(alert => {
      const colorMap = {
        '蓝色': '#3b82f6', '黄色': '#eab308', '橙色': '#f97316', '红色': '#ef4444'
      };
      const color = colorMap[alert.level] || '#ef4444';

      html += `
        <div style="
          margin-bottom: 16px; 
          background: rgba(239, 68, 68, 0.1); 
          border: 1px solid ${color}; 
          border-left: 4px solid ${color};
          border-radius: 8px; 
          padding: 12px;
          display: flex;
          align-items: flex-start;
          gap: 12px;
        ">
          <div style="font-size: 20px;">⚠️</div>
          <div>
            <div style="color: ${color}; font-weight: bold; font-size: 14px; margin-bottom: 4px;">${alert.headline}</div>
            <div style="color: #cbd5e1; font-size: 12px; line-height: 1.4;">${alert.description}</div>
          </div>
        </div>
      `;
    });
  }

  // 降水预报
  if (CONFIG.SHOW_MODULES.WEATHER && precipitationData.success && precipitationData.data.hasPrecipitation) {
    html += `
      <div style="
        margin-bottom: 10px;
        background: linear-gradient(90deg, rgba(6, 182, 212, 0.1), transparent);
        border: 1px solid rgba(6, 182, 212, 0.3);
        border-radius: 12px;
        padding: 12px 16px;
        display: flex;
        align-items: center;
        justify-content: space-between;
      ">
        <div style="display: flex; align-items: center; gap: 10px;">
          <span style="font-size: 18px;">🌧️</span>
          <div>
            <div style="color: #67e8f9; font-size: 14px; font-weight: 600;">降水预警</div>
            <div style="color: #a5f3fc; font-size: 12px;">${precipitationData.data.summary}</div>
          </div>
        </div>
        <div style="text-align: right;">
           <div style="color: #fff; font-size: 14px; font-weight: bold;">${precipitationData.data.intensity}</div>
           <div style="color: #67e8f9; font-size: 10px;">${precipitationData.data.startTime} 开始</div>
        </div>
      </div>
    `;
  }

  // 轮播图
  if (CONFIG.SHOW_MODULES.WEATHER && weatherData.success && forecastData.success) {
    html += buildWeatherCarousel(weatherData, forecastData, timeInfo);
  }

  // 60秒读懂世界 - 科技感终端风格
  if (CONFIG.SHOW_MODULES.NEWS_60S && news60sData && news60sData.success && news60sData.data && Array.isArray(news60sData.data.news)) {
    const n = news60sData.data;
    // 生成新闻列表HTML
    const newsItemsHtml = n.news.map((item, index) => `
      <div style="margin-bottom: 12px; display: flex;">
        <span style="color: #64748b; margin-right: 8px; font-family: monospace;">[${String(index + 1).padStart(2, '0')}]</span>
        <span style="color: #e2e8f0; line-height: 1.5;">${item}</span>
      </div>
    `).join('');

    html += `
      <div style="
        margin: 20px 0;
        background: #0f172a;
        border: 1px solid rgba(16, 185, 129, 0.3);
        border-radius: 12px;
        overflow: hidden;
        position: relative;
        box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
      ">
        <!-- Header -->
        <div style="
          background: rgba(16, 185, 129, 0.1);
          padding: 10px 15px;
          border-bottom: 1px solid rgba(16, 185, 129, 0.2);
          display: flex;
          justify-content: space-between;
          align-items: center;
        ">
          <div style="display: flex; align-items: center; gap: 8px;">
            <div style="width: 8px; height: 8px; background: #10b981; border-radius: 50%; box-shadow: 0 0 8px #10b981;"></div>
            <div style="color: #10b981; font-weight: bold; font-family: monospace; letter-spacing: 1px; font-size: 13px;">60秒世界摘要</div>
          </div>
          <div style="color: #64748b; font-size: 10px; font-family: monospace;">${n.date}</div>
        </div>

        <!-- Scrolling Content -->
        <div style="
          height: 300px;
          overflow: hidden;
          position: relative;
          padding: 15px;
        ">
          <!-- 扫描线效果 -->
          <div style="
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: linear-gradient(to bottom, transparent, rgba(16, 185, 129, 0.05) 50%, transparent);
            background-size: 100% 4px;
            pointer-events: none;
            z-index: 2;
          "></div>

          <div style="
            animation: scrollUp 45s linear infinite;
            font-size: 13px;
          ">
            ${newsItemsHtml}
            <!-- 重复一份以实现无缝滚动 -->
            <div style="margin-top: 20px; border-top: 1px dashed rgba(16, 185, 129, 0.3); padding-top: 20px;">
              ${newsItemsHtml}
            </div>
          </div>
        </div>

        <!-- Footer -->
        <div style="
          padding: 8px 15px;
          border-top: 1px solid rgba(16, 185, 129, 0.2);
          background: rgba(15, 23, 42, 0.8);
          font-family: monospace;
          font-size: 10px;
          color: #10b981;
        ">
          > TIP: ${n.tip}
          <span style="animation: blink 1s step-end infinite;">_</span>
        </div>

        <style>
          @keyframes scrollUp {
            0% { transform: translateY(0); }
            100% { transform: translateY(-50%); }
          }
          @keyframes blink {
            0%, 100% { opacity: 1; }
            50% { opacity: 0; }
          }
        </style>
      </div>
    `;
  }

  // 热点榜单
  if (CONFIG.SHOW_MODULES.HOT_LIST) {
     html += buildHotListModule(hotData);
  }

  // KFC
  if (CONFIG.SHOW_MODULES.KFC && isThursday && kfcContent.success && kfcContent.content) {
    html += kfcContent.content;
  }

  // 历史上的今天 - 抽屉组件 (Pure CSS)
  if (CONFIG.SHOW_MODULES.HISTORY && historyData && historyData.success) {
    const h = historyData.data;
    let historyItemsFunc = () => {
      // 取前10条重要事件，避免内容过多
      return h.items.slice(0, 10).map(item => `
        <div style="margin-bottom: 15px; border-left: 2px solid #a78bfa; padding-left: 12px;">
          <div style="color: #a78bfa; font-size: 14px; font-weight: bold; margin-bottom: 2px;">${item.year}</div>
          <div style="color: #e2e8f0; font-size: 13px; font-weight: 500; margin-bottom: 4px;">${item.title}</div>
          <div style="color: #94a3b8; font-size: 12px; line-height: 1.4;">${item.description.substring(0, 60)}...</div>
        </div>
      `).join('');
    };

    html += `
      <!-- Pure CSS Drawer Toggle -->
      <input type="checkbox" id="history-drawer-toggle" style="display: none;">
      <!-- Overlay -->
      <label for="history-drawer-toggle" class="drawer-overlay" style="
        position: fixed; top: 0; left: 0; width: 100%; height: 100%;
        background: rgba(0,0,0,0.5); z-index: 1001;
        display: none; backdrop-filter: blur(2px);
      "></label>
      <!-- Drawer Content -->
      <div class="drawer-content history-drawer" style="
        position: fixed; top: 0; right: -85%; width: 85%; height: 100%;
        background: #0f172a; z-index: 1002;
        box-shadow: -5px 0 15px rgba(0,0,0,0.5);
        padding: 20px; box-sizing: border-box;
        border-left: 1px solid rgba(255,255,255,0.1);
        overflow-y: auto;
        transition: right 0.3s ease-in-out;
      ">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 10px;">
          <div style="color: #fff; font-size: 18px; font-weight: bold;">📜 历史上的今天</div>
          <label for="history-drawer-toggle" style="color: #64748b; font-size: 20px; cursor: pointer;">✕</label>
        </div>
        <div style="color: #94a3b8; font-size: 12px; margin-bottom: 15px;">${h.date} (${h.items.length} 个事件)</div>
        <div>
          ${historyItemsFunc()}
        </div>
        <div style="text-align: center; margin-top: 20px; font-size: 10px; color: #475569;">
          数据来源: 百度百科
        </div>
      </div>
      <style>
        #history-drawer-toggle:checked ~ .drawer-overlay { display: block; }
        #history-drawer-toggle:checked ~ .history-drawer { right: 0 !important; }
      </style>
    `;
  }

  // 今日汇率 - 抽屉组件 (Pure CSS)
  if (CONFIG.SHOW_MODULES.EXCHANGE && rateData && rateData.success) {
    const r = rateData.data;
    let rateItemsHtml = r.rates.map(item => `
        <div style="
          display: flex; 
          justify-content: space-between; 
          align-items: center; 
          margin-bottom: 12px; 
          background: rgba(255,255,255,0.05); 
          padding: 12px; 
          border-radius: 8px;
          border: 1px solid rgba(255,255,255,0.05);
        ">
          <div style="display: flex; align-items: center;">
            <div style="
              width: 32px; 
              height: 32px; 
              background: #334155; 
              color: #fff; 
              border-radius: 50%; 
              display: flex; 
              align-items: center; 
              justify-content: center; 
              font-size: 10px; 
              margin-right: 12px;
              font-weight: bold;
            ">${item.code}</div>
            <div>
              <div style="color: #e2e8f0; font-size: 14px; font-weight: 500;">${item.name}</div>
              <div style="color: #64748b; font-size: 10px;">1 ${item.code} =</div>
            </div>
          </div>
          <div style="text-align: right;">
            <div style="color: #00f3ff; font-size: 18px; font-weight: bold; font-family: monospace;">
              ${item.rate} <span style="font-size: 10px; color: #64748b;">CNY</span>
            </div>
            <div style="font-size: 10px; color: ${item.diffColor || '#94a3b8'};">较昨 ${item.diffStr || '-'}</div>
          </div>
        </div>
    `).join('');

    html += `
      <!-- Rate Drawer Toggle -->
      <input type="checkbox" id="rate-drawer-toggle" style="display: none;">
      <label for="rate-drawer-toggle" class="drawer-overlay" style="
        position: fixed; top: 0; left: 0; width: 100%; height: 100%;
        background: rgba(0,0,0,0.5); z-index: 1001;
        display: none; backdrop-filter: blur(2px);
      "></label>
      <div class="drawer-content rate-drawer" style="
        position: fixed; top: 0; right: -85%; width: 85%; height: 100%;
        background: #0f172a; z-index: 1002;
        box-shadow: -5px 0 15px rgba(0,0,0,0.5);
        padding: 20px; box-sizing: border-box;
        border-left: 1px solid rgba(255,255,255,0.1);
        overflow-y: auto;
        transition: right 0.3s ease-in-out;
      ">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 10px;">
          <div style="color: #fff; font-size: 18px; font-weight: bold;">💰 今日汇率</div>
          <label for="rate-drawer-toggle" style="color: #64748b; font-size: 20px; cursor: pointer;">✕</label>
        </div>
        <div style="color: #94a3b8; font-size: 12px; margin-bottom: 20px;">更新时间: ${r.updated}</div>
        
        <div>
          ${rateItemsHtml}
        </div>
        
        <div style="margin-top: 20px; padding: 10px; background: rgba(245, 158, 11, 0.1); border-radius: 8px; border: 1px solid rgba(245, 158, 11, 0.2);">
          <div style="color: #f59e0b; font-size: 12px; line-height: 1.4;">
            💡 提示: 数据仅供参考，交易时请以银行柜台成交价为准。
          </div>
        </div>
      </div>
      <style>
        #rate-drawer-toggle:checked ~ .drawer-overlay { display: block; }
        #rate-drawer-toggle:checked ~ .rate-drawer { right: 0 !important; }
      </style>
    `;
  }

  // AI资讯 - 抽屉组件 (Pure CSS)
  if (CONFIG.SHOW_MODULES.AI_NEWS && aiNewsData && aiNewsData.success) {
    const ai = aiNewsData.data;
    let aiItemsHtml = ai.news.map(item => `
        <div style="
          margin-bottom: 20px; 
          background: rgba(59, 130, 246, 0.05); 
          padding: 15px; 
          border-radius: 12px;
          border: 1px solid rgba(59, 130, 246, 0.1);
        ">
          <div style="color: #60a5fa; font-size: 15px; font-weight: bold; margin-bottom: 8px; line-height: 1.4;">${item.title}</div>
          <div style="color: #cbd5e1; font-size: 13px; line-height: 1.6; margin-bottom: 10px;">${item.detail || '暂无详细描述'}</div>
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <div style="color: #64748b; font-size: 11px;">${item.source}</div>
            ${item.link ? `<a href="${item.link}" style="color: #3b82f6; font-size: 11px; text-decoration: none; padding: 2px 8px; border: 1px solid #3b82f6; border-radius: 4px;">查看原文</a>` : ''}
          </div>
        </div>
    `).join('');

    html += `
      <!-- AI Drawer Toggle -->
      <input type="checkbox" id="ai-drawer-toggle" style="display: none;">
      <label for="ai-drawer-toggle" class="drawer-overlay" style="
        position: fixed; top: 0; left: 0; width: 100%; height: 100%;
        background: rgba(0,0,0,0.5); z-index: 1001;
        display: none; backdrop-filter: blur(2px);
      "></label>
      <div class="drawer-content ai-drawer" style="
        position: fixed; top: 0; right: -85%; width: 85%; height: 100%;
        background: #0f172a; z-index: 1002;
        box-shadow: -5px 0 15px rgba(0,0,0,0.5);
        padding: 20px; box-sizing: border-box;
        border-left: 1px solid rgba(255,255,255,0.1);
        overflow-y: auto;
        transition: right 0.3s ease-in-out;
      ">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 10px;">
          <div style="color: #fff; font-size: 18px; font-weight: bold;">🤖 AI 资讯快报</div>
          <label for="ai-drawer-toggle" style="color: #64748b; font-size: 20px; cursor: pointer;">✕</label>
        </div>
         <div style="color: #94a3b8; font-size: 12px; margin-bottom: 20px;">更新日期: ${ai.date}</div>
        
        <div>
          ${aiItemsHtml}
        </div>
      </div>
      <style>
        #ai-drawer-toggle:checked ~ .drawer-overlay { display: block; }
        #ai-drawer-toggle:checked ~ .ai-drawer { right: 0 !important; }
      </style>
    `;
  }

  // 黄金价格 - 抽屉组件 (Pure CSS)
  if (CONFIG.SHOW_MODULES.GOLD && goldData && goldData.success) {
    const g = goldData.data;
    // 基础金价
    let metalItemsHtml = g.metals.map(item => `
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; font-size: 13px;">
        <span style="color: #cbd5e1;">${item.name}</span>
        <div style="text-align: right;">
          <div style="color: #f59e0b; font-weight: bold;">${item.today_price} ${item.unit}</div>
          <div style="font-size: 10px; color: ${item.diffColor || '#94a3b8'};">较昨 ${item.diffStr || '-'}</div>
        </div>
      </div>
    `).join('');

    // 品牌金价 (取前3个)
    let storeItemsHtml = g.stores.slice(0, 3).map(item => `
      <div style="background: rgba(255,255,255,0.05); padding: 10px; border-radius: 8px; margin-bottom: 8px;">
        <div style="font-weight: bold; color: #e2e8f0; font-size: 13px; margin-bottom: 4px;">${item.brand} - ${item.product}</div>
        <div style="color: #f59e0b; font-family: monospace;">${item.price} ${item.unit}</div>
      </div>
    `).join('');

    html += `
      <!-- Gold Drawer Toggle -->
      <input type="checkbox" id="gold-drawer-toggle" style="display: none;">
      <label for="gold-drawer-toggle" class="drawer-overlay" style="
        position: fixed; top: 0; left: 0; width: 100%; height: 100%;
        background: rgba(0,0,0,0.5); z-index: 1001;
        display: none; backdrop-filter: blur(2px);
      "></label>
      <div class="drawer-content gold-drawer" style="
        position: fixed; top: 0; right: -85%; width: 85%; height: 100%;
        background: #0f172a; z-index: 1002;
        box-shadow: -5px 0 15px rgba(0,0,0,0.5);
        padding: 20px; box-sizing: border-box;
        border-left: 1px solid rgba(255,255,255,0.1);
        overflow-y: auto;
        transition: right 0.3s ease-in-out;
      ">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 10px;">
          <div style="color: #fff; font-size: 18px; font-weight: bold;">🏆 今日金价</div>
          <label for="gold-drawer-toggle" style="color: #64748b; font-size: 20px; cursor: pointer;">✕</label>
        </div>
        <div style="color: #94a3b8; font-size: 12px; margin-bottom: 15px;">${g.date}</div>
        
        <div style="margin-bottom: 20px;">
          <div style="color: #a78bfa; font-size: 14px; margin-bottom: 10px; font-weight: bold;">基础金价</div>
          ${metalItemsHtml}
        </div>

        <div>
          <div style="color: #a78bfa; font-size: 14px; margin-bottom: 10px; font-weight: bold;">品牌金价</div>
          ${storeItemsHtml}
        </div>
      </div>
      <style>
        #gold-drawer-toggle:checked ~ .drawer-overlay { display: block; }
        #gold-drawer-toggle:checked ~ .gold-drawer { right: 0 !important; }
      </style>
    `;
  }

  if (CONFIG.SHOW_MODULES.FUEL && fuelData && fuelData.success) {
    const f = fuelData.data;
    let fuelItemsHtml = f.items.map(item => `
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; background: rgba(255,255,255,0.05); padding: 10px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.05);">
        <div style="display: flex; flex-direction: column;">
          <div style="color: #e2e8f0; font-size: 13px; font-weight: 500;">${item.name}</div>
          <div style="color: #64748b; font-size: 10px;">${item.price_desc || ''}</div>
        </div>
        <div style="text-align: right;">
          <div style="color: #38bdf8; font-weight: bold; font-family: monospace;">${item.price}</div>
          <div style="font-size: 10px; color: ${item.diffColor || '#94a3b8'};">较昨 ${item.diffStr || '-'}</div>
        </div>
      </div>
    `).join('');

    html += `
      <input type="checkbox" id="fuel-drawer-toggle" style="display: none;">
      <label for="fuel-drawer-toggle" class="drawer-overlay" style="
        position: fixed; top: 0; left: 0; width: 100%; height: 100%;
        background: rgba(0,0,0,0.5); z-index: 1001;
        display: none; backdrop-filter: blur(2px);
      "></label>
      <div class="drawer-content fuel-drawer" style="
        position: fixed; top: 0; right: -85%; width: 85%; height: 100%;
        background: #0f172a; z-index: 1002;
        box-shadow: -5px 0 15px rgba(0,0,0,0.5);
        padding: 20px; box-sizing: border-box;
        border-left: 1px solid rgba(255,255,255,0.1);
        overflow-y: auto;
        transition: right 0.3s ease-in-out;
      ">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 10px;">
          <div style="color: #fff; font-size: 18px; font-weight: bold;">⛽ 汽油价格</div>
          <label for="fuel-drawer-toggle" style="color: #64748b; font-size: 20px; cursor: pointer;">✕</label>
        </div>
        <div style="color: #94a3b8; font-size: 12px; margin-bottom: 6px;">地区: ${f.region}</div>
        <div style="color: #94a3b8; font-size: 12px; margin-bottom: 15px;">更新时间: ${f.updated}</div>

        <div>
          ${fuelItemsHtml}
        </div>

        ${f.link ? `<div style="margin-top: 14px; display: flex; justify-content: flex-end;">
           <a href="${f.link}" style="display: inline-flex; align-items: center; gap: 6px; padding: 6px 10px; background: rgba(56, 189, 248, 0.12); border: 1px solid rgba(56, 189, 248, 0.4); border-radius: 999px; color: #7dd3fc; font-size: 11px; text-decoration: none; letter-spacing: 0.3px;">
             <span style="font-size: 12px;">🔗</span> 数据来源
           </a>
         </div>` : ''}
      </div>
      <style>
        #fuel-drawer-toggle:checked ~ .drawer-overlay { display: block; }
        #fuel-drawer-toggle:checked ~ .fuel-drawer { right: 0 !important; }
      </style>
    `;
  }

  if (CONFIG.SHOW_MODULES.MOYU && moyuData && moyuData.success) {
    const m = moyuData.data;
    const lunar = m.date && m.date.lunar ? m.date.lunar : {};
    const week = m.progress && m.progress.week ? m.progress.week : {};
    const month = m.progress && m.progress.month ? m.progress.month : {};
    const year = m.progress && m.progress.year ? m.progress.year : {};
    const nh = m.nextHoliday || {};
    const nw = m.nextWeekend || {};
    const cd = m.countdown || {};

    const progressHtml = `
      <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; margin-bottom: 12px;">
        <div style="background: rgba(255,255,255,0.05); padding: 10px; border-radius: 8px;">
          <div style="color: #94a3b8; font-size: 11px;">本周进度</div>
          <div style="color: #06b6d4; font-weight: bold; font-family: monospace;">${week.percentage || 0}%</div>
        </div>
        <div style="background: rgba(255,255,255,0.05); padding: 10px; border-radius: 8px;">
          <div style="color: #94a3b8; font-size: 11px;">本月进度</div>
          <div style="color: #06b6d4; font-weight: bold; font-family: monospace;">${month.percentage || 0}%</div>
        </div>
        <div style="background: rgba(255,255,255,0.05); padding: 10px; border-radius: 8px;">
          <div style="color: #94a3b8; font-size: 11px;">本年进度</div>
          <div style="color: #06b6d4; font-weight: bold; font-family: monospace;">${year.percentage || 0}%</div>
        </div>
      </div>
    `;

    const countdownHtml = `
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
        <div style="background: rgba(255,255,255,0.05); padding: 10px; border-radius: 8px;">
          <div style="color: #94a3b8; font-size: 11px;">距离周末</div>
          <div style="color: #10b981; font-weight: bold; font-family: monospace;">${cd.toWeekEnd || 0}</div>
        </div>
        <div style="background: rgba(255,255,255,0.05); padding: 10px; border-radius: 8px;">
          <div style="color: #94a3b8; font-size: 11px;">距离周五</div>
          <div style="color: #10b981; font-weight: bold; font-family: monospace;">${cd.toFriday || 0}</div>
        </div>
        <div style="background: rgba(255,255,255,0.05); padding: 10px; border-radius: 8px;">
          <div style="color: #94a3b8; font-size: 11px;">距离月末</div>
          <div style="color: #f59e0b; font-weight: bold; font-family: monospace;">${cd.toMonthEnd || 0}</div>
        </div>
        <div style="background: rgba(255,255,255,0.05); padding: 10px; border-radius: 8px;">
          <div style="color: #94a3b8; font-size: 11px;">距离年末</div>
          <div style="color: #f59e0b; font-weight: bold; font-family: monospace;">${cd.toYearEnd || 0}</div>
        </div>
      </div>
    `;

    const holidayHtml = `
      <div style="margin-top: 12px; background: rgba(255,255,255,0.05); padding: 10px; border-radius: 8px;">
        <div style="color: #a78bfa; font-size: 12px; font-weight: bold; margin-bottom: 6px;">下一个节日</div>
        <div style="color: #e2e8f0; font-size: 12px;">${nh.name || '暂无'} · ${nh.date || ''}</div>
        <div style="color: #94a3b8; font-size: 10px;">倒计时: ${nh.until || 0} 天</div>
      </div>
      <div style="margin-top: 8px; background: rgba(255,255,255,0.05); padding: 10px; border-radius: 8px;">
        <div style="color: #a78bfa; font-size: 12px; font-weight: bold; margin-bottom: 6px;">下一个周末</div>
        <div style="color: #e2e8f0; font-size: 12px;">${nw.date || ''} · ${nw.weekday || ''}</div>
        <div style="color: #94a3b8; font-size: 10px;">还剩: ${nw.daysUntil || 0} 天</div>
      </div>
    `;

    html += `
      <input type="checkbox" id="moyu-drawer-toggle" style="display: none;">
      <label for="moyu-drawer-toggle" class="drawer-overlay" style="
        position: fixed; top: 0; left: 0; width: 100%; height: 100%;
        background: rgba(0,0,0,0.5); z-index: 1001;
        display: none; backdrop-filter: blur(2px);
      "></label>
      <div class="drawer-content moyu-drawer" style="
        position: fixed; top: 0; right: -85%; width: 85%; height: 100%;
        background: #0f172a; z-index: 1002;
        box-shadow: -5px 0 15px rgba(0,0,0,0.5);
        padding: 20px; box-sizing: border-box;
        border-left: 1px solid rgba(255,255,255,0.1);
        overflow-y: auto;
        transition: right 0.3s ease-in-out;
      ">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 10px;">
          <div style="color: #fff; font-size: 18px; font-weight: bold;">🐟 摸鱼日报</div>
          <label for="moyu-drawer-toggle" style="color: #64748b; font-size: 20px; cursor: pointer;">✕</label>
        </div>
        <div style="color: #94a3b8; font-size: 12px; margin-bottom: 8px;">${m.date?.gregorian || ''} · ${m.date?.weekday || ''}</div>
        <div style="color: #64748b; font-size: 11px; margin-bottom: 12px;">农历: ${lunar.yearCN || ''}${lunar.monthCN || ''}${lunar.dayCN || ''} · ${lunar.zodiac || ''}</div>

        ${progressHtml}
        ${countdownHtml}
        ${holidayHtml}

        ${m.moyuQuote ? `<div style="margin-top: 12px; background: rgba(255,255,255,0.05); padding: 12px; border-radius: 8px; color: #e2e8f0; font-size: 13px; line-height: 1.6;">${m.moyuQuote}</div>` : ''}
      </div>
      <style>
        #moyu-drawer-toggle:checked ~ .drawer-overlay { display: block; }
        #moyu-drawer-toggle:checked ~ .moyu-drawer { right: 0 !important; }
      </style>
    `;
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


  // Footer HTML
  html += `
    <div style="text-align: center; margin-top: 40px; padding-top: 20px; border-top: 1px solid rgba(255,255,255,0.05);">
      <div style="display: inline-block; padding: 4px 12px; background: rgba(255,255,255,0.05); border-radius: 20px; font-size: 10px; color: #64748b; letter-spacing: 1px;">
        系统在线 / ${timeInfo.time}
      </div>
      <div style="margin-top: 8px; font-size: 10px; color: #334155;">
        ANTIGRAVITY 驱动
      </div>
    </div>
  `;



  html += `</div></div>`;

  return html;
}

// 主函数
async function main() {
  console.log('========== 开始执行每日消息推送 ==========');
  console.log(`触发方式: ${isScheduled ? '定时任务' : '手动触发'} `);

  try {
    // 1. 获取时间信息
    const timeInfo = getCurrentTimeInfo();
    console.log(`当前时间: ${timeInfo.dateTime} `);
    console.log(`星期几: ${timeInfo.dayOfWeek} `);
    console.log(`是否是星期四: ${timeInfo.isThursday} `);

    // 2. 获取和风天气Token
    const token = await getValidHefengToken();

    // 3. 并行获取数据（提高效率）
    const [
      weatherResult,
      forecastResult,
      precipitationResult,
      alertResult,
      luckResult,
      historyResult,
      rateResult,
      goldResult,
      fuelResult,
      moyuResult,
      aiNewsResult,
      news60sResult,
      bingResult,
      kfcResult,
      hitokotoResult,
      rednoteResult,
      weiboResult,
      toutiaoResult,
      zhihuResult,
      maoyanMovieResult,
      maoyanTvResult,
      maoyanWebResult,
      douyinResult,
      biliResult,
      quarkResult,
      baiduHotResult,
      baiduTeleplayResult,
      baiduTiebaResult,
      dongchediResult
    ] = await Promise.allSettled([
      getCurrentWeather(),
      getWeatherForecast(),
      getMinutePrecipitation(token),
      getWeatherAlerts(token),
      getLuck(),
      getHistoryToday(),
      getExchangeRate(),
      getGoldPrice(),
      getFuelPrice(),
      getMoyuDaily(),
      getAiNews(),
      get60sNews(),
      getBingWallpaper(),
      getKfcContent(timeInfo.isThursday),
      getHitokoto(),
      getRedNoteHot(),
      getWeiboHot(),
      getToutiaoHot(),
      getZhihuHot(),
      getMaoyanMovie(),
      getMaoyanTv(),
      getMaoyanWeb(),
      getDouyinHot(),
      getBiliHot(),
      getQuarkHot(),
      getBaiduHot(),
      getBaiduTeleplay(),
      getBaiduTieba(),
      getDongchediHot()
    ]);

    const weatherData = weatherResult.status === 'fulfilled' ? weatherResult.value : { success: false, error: weatherResult.reason };
    const forecastData = forecastResult.status === 'fulfilled' ? forecastResult.value : { success: false, error: forecastResult.reason };
    const precipitationData = precipitationResult.status === 'fulfilled' ? precipitationResult.value : { success: false, error: precipitationResult.reason };
    const alertData = alertResult.status === 'fulfilled' ? alertResult.value : { success: false, data: { hasAlerts: false } };
    const luckData = luckResult.status === 'fulfilled' ? luckResult.value : { success: false, error: luckResult.reason };
    const historyData = historyResult.status === 'fulfilled' ? historyResult.value : { success: false, error: historyResult.reason };
    const rateData = rateResult.status === 'fulfilled' ? rateResult.value : { success: false, error: rateResult.reason };
    const goldData = goldResult.status === 'fulfilled' ? goldResult.value : { success: false, error: goldResult.reason };
    const fuelData = fuelResult.status === 'fulfilled' ? fuelResult.value : { success: false, error: fuelResult.reason };
    const moyuData = moyuResult.status === 'fulfilled' ? moyuResult.value : { success: false, error: moyuResult.reason };
    const aiNewsData = aiNewsResult.status === 'fulfilled' ? aiNewsResult.value : { success: false, error: aiNewsResult.reason };
    const news60sData = news60sResult.status === 'fulfilled' ? news60sResult.value : { success: false, error: news60sResult.reason };
    const bingData = bingResult.status === 'fulfilled' ? bingResult.value : { success: false, error: bingResult.reason };
    const kfcContent = kfcResult.status === 'fulfilled' ? kfcResult.value : { success: false, content: '' };
    const hitokotoData = hitokotoResult.status === 'fulfilled' ? hitokotoResult.value : null;

    const hotData = {
        rednote: rednoteResult.status === 'fulfilled' ? rednoteResult.value : { success: false },
        weibo: weiboResult.status === 'fulfilled' ? weiboResult.value : { success: false },
        toutiao: toutiaoResult.status === 'fulfilled' ? toutiaoResult.value : { success: false },
        zhihu: zhihuResult.status === 'fulfilled' ? zhihuResult.value : { success: false },
        maoyanMovie: maoyanMovieResult.status === 'fulfilled' ? maoyanMovieResult.value : { success: false },
        maoyanTv: maoyanTvResult.status === 'fulfilled' ? maoyanTvResult.value : { success: false },
        maoyanWeb: maoyanWebResult.status === 'fulfilled' ? maoyanWebResult.value : { success: false },
        douyin: douyinResult.status === 'fulfilled' ? douyinResult.value : { success: false },
        bili: biliResult.status === 'fulfilled' ? biliResult.value : { success: false },
        quark: quarkResult.status === 'fulfilled' ? quarkResult.value : { success: false },
        baiduHot: baiduHotResult.status === 'fulfilled' ? baiduHotResult.value : { success: false },
        baiduTeleplay: baiduTeleplayResult.status === 'fulfilled' ? baiduTeleplayResult.value : { success: false },
        baiduTieba: baiduTiebaResult.status === 'fulfilled' ? baiduTiebaResult.value : { success: false },
        dongchedi: dongchediResult.status === 'fulfilled' ? dongchediResult.value : { success: false }
    };

    // 4. 检查关键数据
    if (!hitokotoData) {
      throw new Error('一言数据获取失败，这是关键数据');
    }

    // 5. 获取UID
    const uidResult = await getLatestUid();
    if (!uidResult.success) {
      throw new Error(`获取UID失败: ${uidResult.error} `);
    }

    // 6. 构建HTML内容
    const htmlContent = buildHtmlContent(timeInfo, hitokotoData, weatherData, forecastData, precipitationData, alertData, luckData, historyData, rateData, goldData, fuelData, moyuData, aiNewsData, news60sData, bingData, kfcContent, hotData);

    // 7. 发送消息
    const sendResult = await sendMessage(htmlContent, timeInfo.dateTime, uidResult.uid);

    console.log('========== 每日消息推送执行完成 ==========');

  } catch (error) {
    console.error('❌ 执行过程中发生错误:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// 执行主函数
main();
