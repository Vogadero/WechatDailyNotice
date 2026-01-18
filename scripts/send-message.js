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
  
  const weekdays = ['星期天', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
  const dayOfWeek = weekdays[now.getDay()];
  const dayOfWeekNum = now.getDay();
  
  return {
    dateTime: `${year}年${month}月${day}日${dayOfWeek} ${hour}:${minute}:${second}`,
    dayOfWeek: dayOfWeek,
    dayOfWeekNum: dayOfWeekNum,
    isThursday: dayOfWeekNum === 4,
    hour: parseInt(hour),
    timestamp: Math.floor(now.getTime() / 1000)
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

// 获取最新的UID（现在无论定时还是手动都存储）
async function getLatestUid() {
  try {
    // 无论是否定时触发，都尝试获取最新UID
    console.log('正在获取最新的UID...');
    const response = await axios.get(CONFIG.UID_API, {
      timeout: 10000
    });
    
    if (response.data.code === 200 && response.data.data && response.data.data.length > 0) {
      const latestUid = response.data.data[0].uid;
      console.log(`获取到的UID: ${latestUid}`);
      
      // 存储到文件（现在无论定时还是手动都存储）
      try {
        const dataDir = path.join(__dirname, '../data');
        if (!fs.existsSync(dataDir)) {
          fs.mkdirSync(dataDir, { recursive: true });
        }
        const uidData = {
          uid: latestUid,
          updated: new Date().toISOString(),
          trigger: isScheduled ? 'scheduled' : 'manual'
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
      throw new Error('UID API返回数据格式异常');
    }
  } catch (error) {
    console.error('获取最新UID失败:', error.message);
    
    // 尝试从存储获取
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
          ['comfort', 'car_wash', 'dressing', 'uv'].includes(index.key)
        );
        
        if (importantIndices.length > 0) {
          lifeIndices = '<div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; margin-top: 10px;">';
          importantIndices.forEach(index => {
            const iconMap = {
              'comfort': '😌',
              'car_wash': '🚗',
              'dressing': '👕',
              'uv': '☀️'
            };
            const icon = iconMap[index.key] || '📊';
            lifeIndices += `<div style="color: #666; font-size: 12px; padding: 4px 8px; background-color: #f8f9fa; border-radius: 4px;">
                              <strong>${icon} ${index.name}:</strong> ${index.level}
                            </div>`;
          });
          lifeIndices += '</div>';
        }
      }
      
      return {
        success: true,
        data: {
          location: data.location.name || CONFIG.LOCATION,
          temperature: data.weather.temperature,
          condition: data.weather.condition,
          humidity: data.weather.humidity,
          wind: `${data.weather.wind_direction} ${data.weather.wind_power}`,
          airQuality: data.air_quality.quality,
          aqi: data.air_quality.aqi,
          sunrise: data.sunrise.sunrise,
          sunset: data.sunrise.sunset,
          lifeIndices: lifeIndices,
          alerts: data.alerts || [],
          hasAlerts: data.alerts && data.alerts.length > 0
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
      
      let forecastHTML = '<div style="display: flex; justify-content: space-between; gap: 8px; margin-top: 10px;">';
      
      const dayNames = ['今天', '明天', '后天'];
      
      data.daily_forecast.slice(0, 3).forEach((day, index) => {
        const weatherIcons = {
          '晴': '☀️',
          '多云': '⛅',
          '阴': '☁️',
          '雨': '🌧️',
          '雪': '❄️',
          '雷': '⛈️',
          '雾': '🌫️'
        };
        
        const dayIcon = weatherIcons[day.day_condition] || '🌤️';
        const nightIcon = weatherIcons[day.night_condition] || '🌙';
        
        const isBadWeather = day.day_condition.includes('雨') || 
                            day.day_condition.includes('雪') || 
                            day.day_condition.includes('雷') ||
                            day.day_condition.includes('暴雨') ||
                            day.day_condition.includes('大雪');
        
        const bgColor = isBadWeather ? '#fff0f0' : '#f8f9fa';
        const borderColor = isBadWeather ? '#ffcccc' : '#e9ecef';
        
        forecastHTML += `<div style="flex: 1; background-color: ${bgColor}; border: 1px solid ${borderColor}; border-radius: 6px; padding: 10px; text-align: center; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
                          <div style="font-weight: bold; color: #333; font-size: 14px; margin-bottom: 5px;">${dayNames[index]}</div>
                          <div style="font-size: 24px; margin: 5px 0;">${dayIcon}</div>
                          <div style="color: #ff6b35; font-weight: bold; font-size: 16px; margin-bottom: 3px;">
                            ${day.max_temperature}°/${day.min_temperature}°
                          </div>
                          <div style="color: #666; font-size: 12px; margin-bottom: 2px;">${day.day_condition}</div>
                          <div style="color: #999; font-size: 11px;">夜间: ${nightIcon} ${day.night_condition}</div>
                        </div>`;
      });
      
      forecastHTML += '</div>';
      
      return {
        success: true,
        data: forecastHTML
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
    console.log('正在获取分钟级降水预报...');
    // 再次确保 HEFENG_API_HOST 没有换行符
    const baseUrl = CONFIG.HEFENG_API_HOST.trim().replace(/[\r\n]/g, '');
    const apiPath = '/v7/minutely/5m';
    const url = `${baseUrl}${apiPath}`;
    
    console.log('请求URL:', url);
    
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
    console.log('正在获取天气预警信息...');
    const baseUrl = sanitizeApiHost(CONFIG.HEFENG_API_HOST);
    const apiPath = `/weatheralert/v1/current/${CONFIG.LOCATION_LAT}/${CONFIG.LOCATION_LON}`;
    const finalUrl = `${baseUrl}${apiPath}`;
    
    console.log('最终请求 URL:', finalUrl);
    
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
    console.log('34343434',response)
    
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
      
      const kfcContent = `<div style="background: linear-gradient(135deg, #ffcc00 0%, #ff6600 100%); border-radius: 8px; padding: 15px; margin: 15px 0; box-shadow: 0 2px 8px rgba(255, 102, 0, 0.3);">
                            <div style="display: flex; align-items: center; margin-bottom: 10px;">
                              <span style="font-size: 24px; margin-right: 10px;">🍗</span>
                              <h3 style="margin: 0; color: #fff; text-shadow: 1px 1px 2px rgba(0,0,0,0.2);">疯狂星期四</h3>
                            </div>
                            <div style="background-color: rgba(255, 255, 255, 0.9); padding: 12px; border-radius: 6px; border-left: 4px solid #ff3300;">
                              <p style="margin: 0; color: #333; line-height: 1.5; font-style: italic;">${kfcText}</p>
                            </div>
                            <div style="color: rgba(255, 255, 255, 0.8); font-size: 12px; text-align: right; margin-top: 8px;">
                              #疯狂星期四 #KFC文案
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
      content: '<div style="color: #999; font-style: italic; margin: 10px 0;">今天周四，但KFC文案获取失败...</div>'
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
      'f': '来自网络',
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

// 构建HTML内容
function buildHtmlContent(timeInfo, hitokotoData, weatherData, forecastData, precipitationData, alertData, kfcContent) {
  const { dateTime, dayOfWeek, isThursday } = timeInfo;
  
  let html = `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 10px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.1);">`;
  
  // 头部 - 一言
  html += `<div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 25px 20px; position: relative; overflow: hidden;">
             <div style="position: absolute; top: -50px; right: -50px; width: 150px; height: 150px; background: rgba(255, 255, 255, 0.1); border-radius: 50%;"></div>
             <div style="position: absolute; bottom: -30px; left: -30px; width: 100px; height: 100px; background: rgba(255, 255, 255, 0.08); border-radius: 50%;"></div>
             <h1 style="margin: 0 0 15px 0; font-size: 26px; line-height: 1.4; position: relative; z-index: 1;">${hitokotoData.hitokoto}</h1>
             <div style="display: flex; justify-content: space-between; font-size: 14px; opacity: 0.9; position: relative; z-index: 1;">
               <div>
                 <span style="margin-right: 15px;">📚 ${hitokotoData.type}</span>
                 <span>📖 ${hitokotoData.from}</span>
               </div>
             </div>
           </div>`;
  
  // 主体内容
  html += `<div style="padding: 20px;">`;
  
  // 日期时间
  html += `<div style="text-align: center; margin-bottom: 20px; padding: 12px; background-color: #f8f9fa; border-radius: 8px; border: 1px solid #e9ecef;">
             <div style="font-size: 18px; color: #333; font-weight: 500; margin-bottom: 5px;">${dateTime}</div>
             <div style="font-size: 14px; color: #6c757d;">${isScheduled ? '每日定时推送' : '手动触发推送'}</div>
           </div>`;
  
  // 天气预警（如果有）
  if (alertData.success && alertData.data.hasAlerts) {
    const alertLevelColors = {
      '红色': '#ff4d4f',
      '橙色': '#ff7a45',
      '黄色': '#ffa940',
      '蓝色': '#1890ff',
      '绿色': '#52c41a',
      '黑色': '#262626'
    };
    
    alertData.data.alerts.forEach(alert => {
      const color = alertLevelColors[alert.level] || '#ff4d4f';
      html += `<div style="background-color: ${color}15; border-left: 4px solid ${color}; border-radius: 6px; padding: 12px; margin-bottom: 15px;">
                 <div style="display: flex; align-items: center; margin-bottom: 8px;">
                   <span style="font-size: 20px; margin-right: 8px;">⚠️</span>
                   <h3 style="margin: 0; color: ${color}; font-size: 16px;">${alert.level}${alert.type}预警</h3>
                 </div>
                 <p style="margin: 0; color: #666; font-size: 14px; line-height: 1.4;">${alert.description}</p>
                 <div style="color: #999; font-size: 12px; margin-top: 8px;">
                   <div><strong>生效时间:</strong> ${alert.effectiveTime}</div>
                   <div><strong>结束时间:</strong> ${alert.expireTime}</div>
                   <div><strong>严重程度:</strong> ${alert.severity}</div>
                 </div>
                 ${alert.instruction ? `<div style="margin-top: 8px; padding: 8px; background-color: #fff; border-radius: 4px; border: 1px solid #f0f0f0;">
                                         <div style="color: #333; font-size: 13px;"><strong>防御指南:</strong> ${alert.instruction}</div>
                                       </div>` : ''}
               </div>`;
    });
  }
  
  // 分钟级降水预报（如果有降水）
  if (precipitationData.success && precipitationData.data.hasPrecipitation) {
    const isSevere = precipitationData.isSevere;
    const bgColor = isSevere ? '#fff2f0' : '#f0f7ff';
    const borderColor = isSevere ? '#ffccc7' : '#91d5ff';
    const icon = precipitationData.data.precipitationType === '雪' ? '❄️' : '🌧️';
    
    html += `<div style="background-color: ${bgColor}; border: 1px solid ${borderColor}; border-radius: 8px; padding: 15px; margin-bottom: 20px;">
               <div style="display: flex; align-items: center; margin-bottom: 10px;">
                 <span style="font-size: 24px; margin-right: 10px;">${icon}</span>
                 <h3 style="margin: 0; color: ${isSevere ? '#cf1322' : '#096dd9'}; font-size: 18px;">
                   未来2小时降水预报
                 </h3>
               </div>
               <div style="color: #666; font-size: 14px; margin-bottom: 5px;">
                 <strong>降水类型:</strong> ${precipitationData.data.precipitationType}
               </div>
               <div style="color: #666; font-size: 14px; margin-bottom: 5px;">
                 <strong>降水强度:</strong> ${precipitationData.data.intensity} (最大: ${precipitationData.data.maxPrecip}mm)
               </div>
               <div style="color: #666; font-size: 14px; margin-bottom: 5px;">
                 <strong>开始时间:</strong> ${precipitationData.data.startTime}
               </div>
               <div style="color: #666; font-size: 14px; margin-bottom: 5px;">
                 <strong>结束时间:</strong> ${precipitationData.data.endTime}
               </div>
               <div style="color: #666; font-size: 14px;">
                 <strong>预报摘要:</strong> ${precipitationData.data.summary}
               </div>
               <div style="color: #999; font-size: 12px; margin-top: 5px;">
                 数据更新时间: ${new Date(precipitationData.data.updateTime).toLocaleString('zh-CN')}
               </div>
               ${isSevere ? '<div style="color: #cf1322; font-size: 13px; margin-top: 8px; font-weight: bold;">⚠️ 恶劣天气，请注意防范！</div>' : ''}
             </div>`;
  }
  
  // 实时天气
  if (weatherData.success) {
    const w = weatherData.data;
    html += `<div style="background-color: #f0f7ff; border-radius: 8px; padding: 18px; margin-bottom: 20px; border: 1px solid #d1e3ff;">
               <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
                 <h2 style="margin: 0; color: #0066cc; font-size: 18px;">🌤️ ${w.location} 天气</h2>
                 <div style="font-size: 32px; font-weight: bold; color: #ff6b35;">${w.temperature}°C</div>
               </div>
               <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; margin-bottom: 15px;">
                 <div style="color: #333;"><strong>天气:</strong> ${w.condition}</div>
                 <div style="color: #333;"><strong>空气质量:</strong> ${w.airQuality} (AQI: ${w.aqi})</div>
                 <div style="color: #333;"><strong>湿度:</strong> ${w.humidity}%</div>
                 <div style="color: #333;"><strong>风力:</strong> ${w.wind}</div>
                 <div style="color: #333;"><strong>日出:</strong> ${w.sunrise}</div>
                 <div style="color: #333;"><strong>日落:</strong> ${w.sunset}</div>
               </div>
               ${w.lifeIndices || ''}
             </div>`;
  }
  
  // 天气预报
  if (forecastData.success) {
    html += `<div style="background-color: #fff8f0; border-radius: 8px; padding: 18px; margin-bottom: 20px; border: 1px solid #ffe8cc;">
               <h2 style="margin: 0 0 15px 0; color: #e67e22; font-size: 18px;">📅 未来3天天气预报</h2>
               ${forecastData.data}
               <div style="text-align: center; margin-top: 12px; color: #999; font-size: 12px;">数据来源: 腾讯天气</div>
             </div>`;
  }
  
  // KFC文案（仅星期四）
  if (isThursday && kfcContent.success && kfcContent.content) {
    html += kfcContent.content;
  }
  
  // 底部信息
  html += `<div style="text-align: center; margin-top: 25px; padding-top: 20px; border-top: 1px solid #e9ecef;">
             <div style="color: #6c757d; font-size: 12px; margin-bottom: 5px;">
               每日消息推送系统 | ${isScheduled ? '定时任务' : '手动触发'}
             </div>
             <div style="color: #adb5bd; font-size: 11px;">
               数据来源: 一言 • 腾讯天气 • 和风天气 • KFC文案
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