import { SignJWT, importPKCS8 } from "jose";

const YourPrivateKey = process.env.HEFENG_PRIVATE_KEY;
const KEY_ID = process.env.HEFENG_KEY_ID;
const PROJECT_ID = process.env.HEFENG_PROJECT_ID;
function maskSensitiveValue(value, visiblePrefix = 4, visibleSuffix = 4) {
  if (!value || typeof value !== 'string') return '';
  if (value.length <= visiblePrefix + visibleSuffix) return `${value.slice(0, visiblePrefix)}***`;
  return `${value.slice(0, visiblePrefix)}...${value.slice(-visibleSuffix)}`;
}

function maskJwtPart(value) {
  return `${value.substring(0, 12)}...`;
}

async function generateJWT() {
  try {
    console.log('🔑 开始生成 JWT...');

    if (!YourPrivateKey || !KEY_ID || !PROJECT_ID) {
      throw new Error('请设置 HEFENG_PRIVATE_KEY、HEFENG_KEY_ID、HEFENG_PROJECT_ID 环境变量');
    }

    // 1. 导入私钥
    console.log('📥 导入私钥...');
    const privateKey = await importPKCS8(YourPrivateKey, 'EdDSA');
    console.log('✅ 私钥导入成功\n');
    
    // 2. 设置 Header 和 Payload
    const iat = Math.floor(Date.now() / 1000) - 30;
    const exp = iat + 900;
    
    const customHeader = {
      alg: 'EdDSA',
      kid: KEY_ID
    };
    
    const customPayload = {
      sub: PROJECT_ID,
      iat: iat,
      exp: exp
    };
    
    // 3. 显示配置信息
    console.log('⚙️  JWT 配置信息:');
    console.log('   Header:', JSON.stringify({ ...customHeader, kid: maskSensitiveValue(customHeader.kid) }, null, 2).replace(/\n/g, '\n   '));
    console.log('   Payload:', JSON.stringify({ ...customPayload, sub: maskSensitiveValue(customPayload.sub) }, null, 2).replace(/\n/g, '\n   '));
    
    const issuedAt = new Date(iat * 1000).toISOString();
    const expiresAt = new Date(exp * 1000).toISOString();
    console.log(`\n   ⏰ 时间信息:`);
    console.log(`     签发时间 (iat): ${iat} (${issuedAt})`);
    console.log(`     过期时间 (exp): ${exp} (${expiresAt})`);
    console.log(`     有效期: ${(exp - iat) / 60} 分钟\n`);
    
    // 4. 生成 JWT
    console.log('🔐 生成签名...');
    const token = await new SignJWT(customPayload)
      .setProtectedHeader(customHeader)
      .sign(privateKey);
    
    // 5. 格式化输出 JWT
    console.log('🎉 JWT 生成成功!\n');
    console.log('='.repeat(60));
    
    // 解码并显示 JWT 各部分
    const parts = token.split('.');
    const decodedHeader = JSON.parse(Buffer.from(parts[0], 'base64').toString());
    const decodedPayload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
    console.log('📋 JWT 结构解析:');
    console.log(`\n1. Header (Base64Url): ${maskJwtPart(parts[0])}`);
    console.log('   Decoded:', { ...decodedHeader, kid: maskSensitiveValue(decodedHeader.kid) });

    console.log(`\n2. Payload (Base64Url): ${maskJwtPart(parts[1])}`);
    console.log('   Decoded:', { ...decodedPayload, sub: maskSensitiveValue(decodedPayload.sub) });

    console.log(`\n3. Signature (Base64Url): ${maskJwtPart(parts[2])}`);
    console.log(`   签名长度: ${parts[2].length} 字符`);
    
    console.log('\n' + '='.repeat(60));
    
    // 6. JWT 输出（默认不打印 bearer token，避免日志泄露）
    console.log('\n🔗 JWT Token:');
    console.log('   已生成，但不会输出 Token 内容，避免日志泄露');
    console.log('   主脚本会自动把生成的 Token 用于和风天气请求');
    
    // 7. 验证信息
    console.log('\n📊 验证信息:');
    console.log(`   Token 总长度: ${token.length} 字符`);
    console.log(`   是否已过期: ${Date.now() / 1000 > exp ? '是' : '否'}`);
    console.log(`   剩余有效时间: ${Math.max(0, exp - Math.floor(Date.now() / 1000))} 秒`);
    
    // 返回 token 以便后续使用
    return token;
    
  } catch (error) {
    console.error('\n❌ 生成 JWT 时出错:');
    console.error('   错误信息:', error.message);
    console.error('   错误堆栈:', error.stack);
    throw error;
  }
}

// 使用示例
generateJWT()
  .then(() => {
    console.log('\n✅ JWT 生成流程完成！');
    console.log('💡 使用提示: 主脚本会自动把生成的 Token 用于和风天气请求');
  })
  .catch(() => {
    console.log('\n⚠️  JWT 生成失败，请检查错误信息');
    process.exitCode = 1;
  });