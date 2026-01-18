import { SignJWT, importPKCS8 } from "jose";

const YourPrivateKey = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIHcLc+UrJC8KREq558id7w5cPLDbBK5bBBswA8tTr6uN
-----END PRIVATE KEY-----`; 
const KEY_ID = 'TDGWMDPP4F';
const PROJECT_ID = '3NKPCUCE3X';

async function generateJWT() {
  try {
    console.log('🔑 开始生成 JWT...');
    
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
    console.log('   Header:', JSON.stringify(customHeader, null, 2).replace(/\n/g, '\n   '));
    console.log('   Payload:', JSON.stringify(customPayload, null, 2).replace(/\n/g, '\n   '));
    
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
    console.log('📋 JWT 结构解析:');
    console.log(`\n1. Header (Base64Url): ${parts[0]}`);
    console.log('   Decoded:', JSON.parse(Buffer.from(parts[0], 'base64').toString()));
    
    console.log(`\n2. Payload (Base64Url): ${parts[1]}`);
    console.log('   Decoded:', JSON.parse(Buffer.from(parts[1], 'base64').toString()));
    
    console.log(`\n3. Signature (Base64Url): ${parts[2].substring(0, 50)}...`);
    console.log(`   签名长度: ${parts[2].length} 字符`);
    
    console.log('\n' + '='.repeat(60));
    
    // 6. 完整的 JWT
    console.log('\n🔗 完整 JWT Token:');
    console.log(token);
    
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
  .then(token => {
    console.log('\n✅ JWT 生成流程完成！');
    console.log('💡 使用提示: 将此 Token 用于 Authorization 请求头:');
    console.log(`   Authorization: Bearer ${token.substring(0, 50)}...`);
  })
  .catch(() => {
    console.log('\n⚠️  JWT 生成失败，请检查错误信息');
  });