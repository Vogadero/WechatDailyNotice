// send-message.js
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// 从命令行参数判断是否是定时触发
const isScheduled = process.argv[2] === 'true';

// 配置
const CONFIG = {
  // 和风天气配置
  HEFENG_API_HOST: process.env.HEFENG_API_HOST,
  HEFENG_PRIVATE_KEY: process.env.HEFENG_PRIVATE_KEY,
  HEFENG_KEY_ID: process.env.HEFENG_KEY_ID,
  HEFENG_PROJECT_ID: process.env.HEFENG_PROJECT_ID,

  // 其他配置
  WXPUSHER_APP_TOKEN: process.env.WXPUSHER_APP_TOKEN,
  LOCATION: '余杭区',
  WEATHER_API_BASE: 'https://60s.viki.moe/v2',
  KFC_API: 'https://60s.viki.moe/v2/kfc',
  UID_API: 'https://eob7gu4tu9r7a8s.m.pipedream.net',
  HITOKOTO_API: 'https://v1.hitokoto.cn',
  WXPUSHER_API: 'https://wxpusher.zjiecode.com/api/send/message',
  LOCATION_LON: '119.97874',
  LOCATION_LAT: '30.27371',

  // Token缓存文件
  TOKEN_CACHE_FILE: path.join(__dirname, '../data/hefeng_token.json'),

  // Token提前刷新时间（秒）
  TOKEN_REFRESH_BEFORE_EXPIRE: 300, // 提前5分钟刷新
};

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
  const now = new Date();
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
    dateTime: `${year}/${month}/${day} ${dayOfWeek} ${hour}:${minute}`,
    dayOfWeek: dayOfWeek,
    dayOfWeekNum: dayOfWeekNum,
    isThursday: dayOfWeekNum === 4,
    hour: parseInt(hour),
    timestamp: Math.floor(now.getTime() / 1000),
    simpleDate: `${month}月${day}日`,
    time: `${hour}:${minute}`
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

      let lifeIndices = '';
      if (data.life_indices && data.life_indices.length > 0) {
        const importantIndices = data.life_indices.filter(index =>
          ['comfort', 'car_wash', 'dressing', 'uv', 'sports', 'airconditioner', 'umbrella', 'traffic'].includes(index.key)
        );

        if (importantIndices.length > 0) {
          lifeIndices = '<div style="margin-top: 15px;">';
          lifeIndices += '<div style="font-size: 13px; color: #666; margin-bottom: 8px; font-weight: 500;">生活指数</div>';
          lifeIndices += '<div style="display: flex; flex-wrap: wrap; gap: 6px;">';
          importantIndices.forEach(index => {
            const iconMap = {
              'comfort': '😌',
              'car_wash': '🚗',
              'dressing': '👕',
              'uv': '☀️',
              'sports': '🏃',
              'airconditioner': '❄️',
              'umbrella': '☔',
              'traffic': '🚦'
            };
            const icon = iconMap[index.key] || '📊';
            lifeIndices += `<div style="color: #555; font-size: 11px; padding: 4px 8px; background-color: rgba(255,255,255,0.7); border-radius: 12px; border: 1px solid rgba(0,0,0,0.05);">
                              ${icon} ${index.level}
                            </div>`;
          });
          lifeIndices += '</div></div>';
        }
      }

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
          lifeIndices: lifeIndices,
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
        days: 3
      },
      timeout: 10000
    });

    if (response.data.code === 200) {
      const data = response.data.data;

      // 构建3天预报数据
      const forecastDays = data.daily_forecast.slice(0, 3).map((day, index) => {
        const dayNames = ['今天', '明天', '后天'];
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
          dayName: dayNames[index],
          dayIcon: dayIcon,
          nightIcon: nightIcon,
          maxTemp: day.max_temperature,
          minTemp: day.min_temperature,
          dayCondition: day.day_condition,
          nightCondition: day.night_condition,
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

      const kfcContent = `<div style="background: linear-gradient(135deg, #f5f5f5 0%, #fff 100%); border: 1px solid #e0e0e0; border-radius: 8px; padding: 14px; margin: 15px 0;">
                            <div style="display: flex; align-items: center; margin-bottom: 8px;">
                              <span style="font-size: 20px; margin-right: 8px;">🍗</span>
                              <h3 style="margin: 0; color: #d32f2f; font-size: 16px; font-weight: 600;">疯狂星期四</h3>
                            </div>
                            <div style="padding: 10px; border-radius: 6px; background-color: #fff;">
                              <p style="margin: 0; color: #555; line-height: 1.5; font-size: 14px;">${kfcText}</p>
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

// 构建天气轮播图的HTML内容
function buildWeatherCarousel(weatherData, forecastData, timeInfo) {
  const w = weatherData.data;
  const forecastDays = forecastData.data;

  // 科技感轮播图HTML
  let html = `
    <style>
      .weather-carousel {
        position: relative;
        width: 100%;
        overflow: hidden;
        border-radius: 12px;
        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        box-shadow: 0 8px 32px rgba(102, 126, 234, 0.3);
      }
      
      .carousel-inner {
        display: flex;
        transition: transform 0.5s cubic-bezier(0.4, 0, 0.2, 1);
        width: 200%;
      }
      
      .carousel-slide {
        min-width: 50%;
        padding: 20px;
        box-sizing: border-box;
      }
      
      .carousel-nav {
        display: flex;
        justify-content: center;
        gap: 12px;
        margin-top: 16px;
      }
      
      .carousel-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: rgba(255, 255, 255, 0.3);
        cursor: pointer;
        transition: all 0.3s ease;
      }
      
      .carousel-dot.active {
        background: #fff;
        transform: scale(1.2);
        box-shadow: 0 0 8px rgba(255, 255, 255, 0.5);
      }
      
      .carousel-arrow {
        position: absolute;
        top: 50%;
        transform: translateY(-50%);
        width: 32px;
        height: 32px;
        background: rgba(255, 255, 255, 0.9);
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        opacity: 0;
        transition: opacity 0.3s ease;
        z-index: 10;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
      }
      
      .weather-carousel:hover .carousel-arrow {
        opacity: 1;
      }
      
      .carousel-arrow-left {
        left: 12px;
      }
      
      .carousel-arrow-right {
        right: 12px;
      }
      
      .weather-header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        margin-bottom: 20px;
      }
      
      .location-info {
        color: white;
      }
      
      .location-name {
        font-size: 18px;
        font-weight: 600;
        margin-bottom: 4px;
      }
      
      .location-detail {
        font-size: 12px;
        opacity: 0.8;
      }
      
      .current-temp {
        font-size: 48px;
        font-weight: 300;
        color: white;
        text-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
      }
      
      .weather-stats {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 12px;
        margin-top: 20px;
      }
      
      .stat-item {
        background: rgba(255, 255, 255, 0.1);
        backdrop-filter: blur(10px);
        border-radius: 8px;
        padding: 12px;
        text-align: center;
        border: 1px solid rgba(255, 255, 255, 0.1);
      }
      
      .stat-label {
        font-size: 11px;
        color: rgba(255, 255, 255, 0.8);
        margin-bottom: 4px;
      }
      
      .stat-value {
        font-size: 14px;
        font-weight: 600;
        color: white;
      }
      
      .weather-details {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: 12px;
        margin-top: 16px;
      }
      
      .detail-item {
        background: rgba(255, 255, 255, 0.05);
        border-radius: 8px;
        padding: 10px;
      }
      
      .detail-label {
        font-size: 11px;
        color: rgba(255, 255, 255, 0.7);
        margin-bottom: 2px;
      }
      
      .detail-value {
        font-size: 13px;
        font-weight: 500;
        color: white;
      }
      
      .forecast-slide {
        padding: 20px;
      }
      
      .forecast-title {
        font-size: 16px;
        font-weight: 600;
        color: white;
        margin-bottom: 16px;
      }
      
      .forecast-grid {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 12px;
      }
      
      .forecast-day {
        background: rgba(255, 255, 255, 0.1);
        backdrop-filter: blur(10px);
        border-radius: 12px;
        padding: 16px;
        text-align: center;
        border: 1px solid rgba(255, 255, 255, 0.1);
        transition: transform 0.3s ease;
      }
      
      .forecast-day:hover {
        transform: translateY(-2px);
        background: rgba(255, 255, 255, 0.15);
      }
      
      .day-name {
        font-size: 14px;
        font-weight: 600;
        color: white;
        margin-bottom: 8px;
      }
      
      .day-icon {
        font-size: 32px;
        margin: 8px 0;
      }
      
      .day-temp {
        font-size: 16px;
        font-weight: 600;
        color: #ffd700;
        margin-bottom: 4px;
      }
      
      .day-condition {
        font-size: 12px;
        color: rgba(255, 255, 255, 0.9);
      }
      
      .bad-weather {
        background: rgba(255, 87, 87, 0.15);
        border: 1px solid rgba(255, 87, 87, 0.3);
      }
    </style>
    
    <div class="weather-carousel">
      <!-- 左右箭头 -->
      <div class="carousel-arrow carousel-arrow-left" onclick="switchSlide(0)">←</div>
      <div class="carousel-arrow carousel-arrow-right" onclick="switchSlide(1)">→</div>
      
      <div class="carousel-inner" id="carouselInner">
        <!-- 实时天气 -->
        <div class="carousel-slide">
          <div class="weather-header">
            <div class="location-info">
              <div class="location-name">${w.location}</div>
              <div class="location-detail">${timeInfo.dayOfWeek} ${timeInfo.time} · ${isScheduled ? '每日推送' : '手动推送'}</div>
            </div>
            <div class="current-temp">${w.temperature}°</div>
          </div>
          
          <div style="color: white; font-size: 16px; font-weight: 500; margin-bottom: 8px;">${w.condition}</div>
          
          <div class="weather-stats">
            <div class="stat-item">
              <div class="stat-label">湿度</div>
              <div class="stat-value">${w.humidity}%</div>
            </div>
            <div class="stat-item">
              <div class="stat-label">气压</div>
              <div class="stat-value">${w.pressure}hPa</div>
            </div>
            <div class="stat-item">
              <div class="stat-label">降水</div>
              <div class="stat-value">${w.precipitation}mm</div>
            </div>
            <div class="stat-item">
              <div class="stat-label">风速</div>
              <div class="stat-value">${w.wind_power}</div>
            </div>
          </div>
          
          <div class="weather-details">
            <div class="detail-item">
              <div class="detail-label">空气质量</div>
              <div class="detail-value">${w.airQuality} (AQI ${w.aqi})</div>
            </div>
            <div class="detail-item">
              <div class="detail-label">PM2.5</div>
              <div class="detail-value">${w.pm25}μg/m³</div>
            </div>
            <div class="detail-item">
              <div class="detail-label">日出</div>
              <div class="detail-value">${w.sunrise}</div>
            </div>
            <div class="detail-item">
              <div class="detail-label">日落</div>
              <div class="detail-value">${w.sunset}</div>
            </div>
          </div>
          
          ${w.lifeIndices}
        </div>
        
        <!-- 天气预报 -->
        <div class="carousel-slide forecast-slide">
          <div class="forecast-title">未来3天预报</div>
          
          <div class="forecast-grid">
  `;

  // 添加3天预报卡片
  forecastDays.forEach(day => {
    html += `
            <div class="forecast-day ${day.isBadWeather ? 'bad-weather' : ''}">
              <div class="day-name">${day.dayName}</div>
              <div class="day-icon">${day.dayIcon}</div>
              <div class="day-temp">${day.maxTemp}°/${day.minTemp}°</div>
              <div class="day-condition">${day.dayCondition}</div>
              <div style="font-size: 11px; color: rgba(255,255,255,0.7); margin-top: 4px;">
                ${day.nightIcon} ${day.nightCondition}
              </div>
            </div>
    `;
  });

  html += `
          </div>
          
          <div style="margin-top: 20px; padding: 12px; background: rgba(255,255,255,0.05); border-radius: 8px;">
            <div style="font-size: 12px; color: rgba(255,255,255,0.7); margin-bottom: 4px;">
              数据更新时间: ${w.updated || '实时更新'}
            </div>
            <div style="font-size: 11px; color: rgba(255,255,255,0.5);">
              数据来源: 腾讯天气 · 和风天气
            </div>
          </div>
        </div>
      </div>
      
      <div class="carousel-nav">
        <div class="carousel-dot active" onclick="switchSlide(0)"></div>
        <div class="carousel-dot" onclick="switchSlide(1)"></div>
      </div>
    </div>
    
    <script>
      let currentSlide = 0;
      const totalSlides = 2;
      
      function switchSlide(slideIndex) {
        currentSlide = slideIndex;
        const carouselInner = document.getElementById('carouselInner');
        const dots = document.querySelectorAll('.carousel-dot');
        
        // 移动轮播图
        carouselInner.style.transform = \`translateX(-\${slideIndex * 50}%)\`;
        
        // 更新指示点
        dots.forEach((dot, index) => {
          dot.classList.toggle('active', index === slideIndex);
        });
      }
    </script>
  `;

  return html;
}

// 构建HTML内容（现代化简约风格）
function buildHtmlContent(timeInfo, hitokotoData, weatherData, forecastData, precipitationData, alertData, kfcContent) {
  const { dateTime, dayOfWeek, isThursday, simpleDate, time } = timeInfo;

  let html = `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif; max-width: 100%; margin: 0; background-color: #ffffff; color: #333; line-height: 1.5;">`;

  // 头部 - 一言卡片
  html += `<div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 20px 16px; margin-bottom: 16px; border-radius: 0 0 12px 12px; box-shadow: 0 2px 10px rgba(102, 126, 234, 0.2);">
             <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px;">
               <div style="font-size: 12px; opacity: 0.8; background: rgba(255,255,255,0.15); padding: 3px 8px; border-radius: 10px;">${hitokotoData.type}</div>
               <div style="font-size: 12px; opacity: 0.8;">${simpleDate} ${dayOfWeek}</div>
             </div>
             <div style="font-size: 16px; font-weight: 500; line-height: 1.4; margin-bottom: 10px;">${hitokotoData.hitokoto}</div>
             <div style="font-size: 12px; opacity: 0.8; text-align: right;">—— ${hitokotoData.from}</div>
           </div>`;

  // 主体内容容器
  html += `<div style="padding: 0 16px;">`;

  // 天气预警（如果有）
  if (alertData.success && alertData.data.hasAlerts) {
    const alertLevelColors = {
      '红色': '#f5222d',
      '橙色': '#fa541c',
      '黄色': '#faad14',
      '蓝色': '#1890ff',
      '绿色': '#52c41a',
      '黑色': '#262626'
    };

    alertData.data.alerts.forEach(alert => {
      const color = alertLevelColors[alert.level] || '#f5222d';
      html += `<div style="background: linear-gradient(to right, ${color}15, ${color}08); border-left: 3px solid ${color}; border-radius: 8px; padding: 12px; margin-bottom: 16px;">
                 <div style="display: flex; align-items: center; margin-bottom: 6px;">
                   <div style="width: 6px; height: 6px; background: ${color}; border-radius: 50%; margin-right: 8px;"></div>
                   <div style="font-size: 14px; font-weight: 600; color: ${color};">${alert.level}${alert.type}预警</div>
                 </div>
                 <div style="font-size: 13px; color: #666; margin-bottom: 8px; line-height: 1.4;">${alert.description}</div>
                 <div style="display: flex; flex-wrap: wrap; gap: 6px; font-size: 11px; color: #888;">
                   <span>生效: ${alert.effectiveTime.split(' ')[1] || alert.effectiveTime}</span>
                   <span>|</span>
                   <span>结束: ${alert.expireTime.split(' ')[1] || alert.expireTime}</span>
                 </div>
               </div>`;
    });
  }

  // 分钟级降水预报
  if (precipitationData.success && precipitationData.data.hasPrecipitation) {
    const isSevere = precipitationData.isSevere;
    const icon = precipitationData.data.precipitationType === '雪' ? '❄️' : '🌧️';

    html += `<div style="background: ${isSevere ? '#fff2f0' : '#f0f9ff'}; border-radius: 8px; padding: 14px; margin-bottom: 16px; border: 1px solid ${isSevere ? '#ffccc7' : '#d1e9ff'}">
               <div style="display: flex; align-items: center; margin-bottom: 8px;">
                 <div style="font-size: 20px; margin-right: 10px;">${icon}</div>
                 <div style="flex: 1;">
                   <div style="font-size: 14px; font-weight: 600; color: ${isSevere ? '#d4380d' : '#096dd9'};">降水预报</div>
                   <div style="font-size: 12px; color: #666;">${precipitationData.data.intensity}</div>
                 </div>
               </div>
               <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; font-size: 12px;">
                 <div><span style="color: #888;">开始:</span> ${precipitationData.data.startTime}</div>
                 <div><span style="color: #888;">结束:</span> ${precipitationData.data.endTime}</div>
                 <div><span style="color: #888;">最大:</span> ${precipitationData.data.maxPrecip}mm</div>
                 <div><span style="color: #888;">类型:</span> ${precipitationData.data.precipitationType}</div>
               </div>
             </div>`;
  }

  // 天气轮播图（整合实时天气和3天预报）
  if (weatherData.success && forecastData.success) {
    html += buildWeatherCarousel(weatherData, forecastData, timeInfo);
  }

  // KFC文案（仅星期四）
  if (isThursday && kfcContent.success && kfcContent.content) {
    html += kfcContent.content;
  }

  // 底部信息
  html += `<div style="margin-top: 24px; padding-top: 16px; border-top: 1px solid #f0f0f0; text-align: center;">
             <div style="font-size: 11px; color: #999; margin-bottom: 4px;">
               每日推送 · ${isScheduled ? '定时任务' : '手动触发'}
             </div>
             <div style="font-size: 10px; color: #ccc;">
               数据源: 一言 · 腾讯天气 · 和风天气 · KFC文案
             </div>
           </div>`;

  html += `</div></div>`;

  return html;
}

// 主函数
async function main() {
  console.log('========== 开始执行每日消息推送 ==========');
  console.log(`触发方式: ${isScheduled ? '定时任务' : '手动触发'}`);

  try {
    // 1. 获取时间信息
    const timeInfo = getCurrentTimeInfo();
    console.log(`当前时间: ${timeInfo.dateTime}`);
    console.log(`星期几: ${timeInfo.dayOfWeek}`);
    console.log(`是否是星期四: ${timeInfo.isThursday}`);

    // 2. 获取和风天气Token
    const token = await getValidHefengToken();

    // 3. 并行获取数据（提高效率）
    const [
      weatherResult,
      forecastResult,
      precipitationResult,
      alertResult,
      kfcResult,
      hitokotoResult
    ] = await Promise.allSettled([
      getCurrentWeather(),
      getWeatherForecast(),
      getMinutePrecipitation(token),
      getWeatherAlerts(token),
      getKfcContent(timeInfo.isThursday),
      getHitokoto()
    ]);

    const weatherData = weatherResult.status === 'fulfilled' ? weatherResult.value : { success: false, error: weatherResult.reason };
    const forecastData = forecastResult.status === 'fulfilled' ? forecastResult.value : { success: false, error: forecastResult.reason };
    const precipitationData = precipitationResult.status === 'fulfilled' ? precipitationResult.value : { success: false, error: precipitationResult.reason };
    const alertData = alertResult.status === 'fulfilled' ? alertResult.value : { success: false, data: { hasAlerts: false } };
    const kfcContent = kfcResult.status === 'fulfilled' ? kfcResult.value : { success: false, content: '' };
    const hitokotoData = hitokotoResult.status === 'fulfilled' ? hitokotoResult.value : null;

    // 4. 检查关键数据
    if (!hitokotoData) {
      throw new Error('一言数据获取失败，这是关键数据');
    }

    // 5. 获取UID
    const uidResult = await getLatestUid();
    if (!uidResult.success) {
      throw new Error(`获取UID失败: ${uidResult.error}`);
    }

    // 6. 构建HTML内容
    const htmlContent = buildHtmlContent(timeInfo, hitokotoData, weatherData, forecastData, precipitationData, alertData, kfcContent);

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