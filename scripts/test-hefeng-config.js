// scripts/test-hefeng-config.js
const axios = require('axios');

console.log('=== 和风天气 API 配置测试 ===\n');

// 从环境变量读取
const HEFENG_API_HOST = process.env.HEFENG_API_HOST;
const HEFENG_PRIVATE_KEY = process.env.HEFENG_PRIVATE_KEY;
const HEFENG_KEY_ID = process.env.HEFENG_KEY_ID;
const HEFENG_PROJECT_ID = process.env.HEFENG_PROJECT_ID;

// 验证函数
function validateAndFixUrl(url) {
  console.log('1. 验证 HEFENG_API_HOST:');
  console.log('   原始值:', JSON.stringify(url));
  
  if (!url) {
    console.log('   ❌ 未设置');
    return null;
  }
  
  // 去除空白
  let fixed = url.trim();
  
  // 检查是否有换行符等
  const hasNewline = fixed.includes('\n') || fixed.includes('\r');
  if (hasNewline) {
    console.log('   ⚠️ 包含换行符，移除');
    fixed = fixed.replace(/[\r\n]/g, '');
  }
  
  // 确保有协议
  if (!fixed.startsWith('http://') && !fixed.startsWith('https://')) {
    console.log('   ⚠️ 缺少协议，添加 https://');
    fixed = 'https://' + fixed;
  }
  
  // 移除末尾斜杠
  fixed = fixed.replace(/\/+$/, '');
  
  console.log('   修复后:', fixed);
  
  try {
    const urlObj = new URL(fixed);
    console.log('   ✅ 解析成功');
    console.log('      协议:', urlObj.protocol);
    console.log('      主机:', urlObj.host);
    console.log('      主机名:', urlObj.hostname);
    return fixed;
  } catch (error) {
    console.log('   ❌ 解析失败:', error.message);
    return null;
  }
}

// 测试 URL
console.log('\n2. 测试 URL 解析和构建:');
const fixedHost = validateAndFixUrl(HEFENG_API_HOST);

if (fixedHost) {
  const testUrls = [
    `${fixedHost}/v7/minutely/5m`,
    `${fixedHost}/weatheralert/v1/current/30.27371/119.97874`
  ];
  
  console.log('\n构建的测试 URL:');
  testUrls.forEach((url, i) => {
    console.log(`   ${i + 1}. ${url}`);
    try {
      new URL(url);
      console.log('      ✅ 有效');
    } catch (error) {
      console.log(`      ❌ 无效: ${error.message}`);
    }
  });
}

// 检查其他环境变量
console.log('\n3. 检查其他环境变量:');
const vars = [
  { name: 'HEFENG_PRIVATE_KEY', value: HEFENG_PRIVATE_KEY },
  { name: 'HEFENG_KEY_ID', value: HEFENG_KEY_ID },
  { name: 'HEFENG_PROJECT_ID', value: HEFENG_PROJECT_ID }
];

vars.forEach(v => {
  if (v.value) {
    console.log(`   ✅ ${v.name}: 已设置`);
    if (v.name === 'HEFENG_PRIVATE_KEY') {
      console.log(`      长度: ${v.value.length}`);
      console.log(`      前50字符: ${v.value.substring(0, 50)}...`);
    }
  } else {
    console.log(`   ❌ ${v.name}: 未设置`);
  }
});

// 简单的网络测试
console.log('\n4. 简单的网络测试:');
if (fixedHost) {
  const testUrl = `${fixedHost}`;
  console.log(`   测试连接到: ${testUrl}`);
  
  axios.get(testUrl, { timeout: 5000 })
    .then(response => {
      console.log(`   ✅ 连接成功: ${response.status}`);
    })
    .catch(error => {
      console.log(`   ❌ 连接失败: ${error.message}`);
      if (error.code) {
        console.log(`      错误代码: ${error.code}`);
      }
    });
} else {
  console.log('   无法测试，HEFENG_API_HOST 无效');
}

console.log('\n=== 测试完成 ===');