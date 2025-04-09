const axios       = require('axios');
const fs          = require('fs');
const path        = require('path');
const readline    = require('readline');
const https       = require('https');
const querystring = require('querystring');

// 加载环境变量
require('dotenv').config();

// 创建命令行读取界面
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Strava API 认证配置 - 从环境变量加载
const config = {
  STRAVA_CLIENT_ID:     process.env.STRAVA_CLIENT_ID,
  STRAVA_CLIENT_SECRET: process.env.STRAVA_CLIENT_SECRET,
  TOKENFILE:            path.join(__dirname, process.env.STRAVA_TOKEN)
};

// 保存令牌到文件
function saveTokenToFile(tokenData) {
  try {
    fs.writeFileSync(config.TOKENFILE, JSON.stringify(tokenData, null, 2), 'utf8');
    console.log('令牌已保存，下次运行将自动使用');
    return true;
  } catch (error) {
    console.error('保存令牌失败:', error.message);
    return false;
  }
}

// 使用Node.js原生HTTPS模块处理请求，避免axios可能的问题
function makeTokenRequest(code) {
  return new Promise((resolve, reject) => {
    const data = querystring.stringify({
      client_id: config.STRAVA_CLIENT_ID,
      client_secret: config.STRAVA_CLIENT_SECRET,
      code: code,
      grant_type: 'authorization_code'
    });
    
    const options = {
      hostname: 'www.strava.com',
      port: 443,
      path: '/oauth/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(data)
      }
    };
    
    const req = https.request(options, (res) => {
      let responseData = '';
      
      res.on('data', (chunk) => {
        responseData += chunk;
      });
      
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            const parsedData = JSON.parse(responseData);
            resolve(parsedData);
          } catch (e) {
            reject(new Error('无法解析响应数据'));
          }
        } else {
          reject(new Error(`HTTP错误状态码: ${res.statusCode}, 响应: ${responseData}`));
        }
      });
    });
    
    req.on('error', (error) => {
      reject(error);
    });
    
    req.write(data);
    req.end();
  });
}

// 使用授权码获取访问令牌
async function getAccessTokenFromCode(code) {
  try {
    console.log('正在使用授权码获取访问令牌...');
    console.log(`授权码: ${code.substring(0, 4)}...${code.substring(code.length - 4)}`); // 只显示部分授权码
    
    console.log('使用Node.js原生HTTPS模块发送请求...');
    const tokenData = await makeTokenRequest(code);
    
    console.log('成功获取访问令牌!');
    console.log('令牌详情:');
    console.log(`- 访问令牌: ${tokenData.access_token.substring(0, 5)}...`);
    console.log(`- 刷新令牌: ${tokenData.refresh_token.substring(0, 5)}...`);
    console.log(`- 过期时间: ${new Date(tokenData.expires_at * 1000).toLocaleString()}`);
    
    if (saveTokenToFile(tokenData)) {
      console.log('\n您现在可以运行主脚本 fetchStravaRides.js 获取骑行数据了');
      console.log('运行命令: yarn start');
    }
    
    return tokenData;
  } catch (error) {
    console.error('获取访问令牌失败:');
    console.error('错误详情:', error.message);
    
    // 提供更多调试信息
    console.log('\n尝试查看是否为redirect_uri问题，正在重新尝试...');
    
    try {
      // 尝试使用curl命令格式打印请求信息，方便用户手动尝试
      const curlCommand = `curl -X POST https://www.strava.com/oauth/token \
-d client_id=${config.STRAVA_CLIENT_ID} \
-d client_secret=${config.STRAVA_CLIENT_SECRET} \
-d code=${code} \
-d grant_type=authorization_code`;
      
      console.log('\n您可以尝试使用以下命令手动获取令牌:');
      console.log(curlCommand);
      
      // 再尝试一种不同的请求方式
      console.log('\n尝试使用axios的另一种配置...');
      
      const response = await axios({
        method: 'post',
        url: 'https://www.strava.com/oauth/token',
        data: querystring.stringify({
          client_id: config.STRAVA_CLIENT_ID,
          client_secret: config.STRAVA_CLIENT_SECRET,
          code: code,
          grant_type: 'authorization_code'
        }),
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      });
      
      const alternativeTokenData = response.data;
      console.log('成功获取访问令牌!');
      
      if (saveTokenToFile(alternativeTokenData)) {
        console.log('\n您现在可以运行主脚本 fetchStravaRides.js 获取骑行数据了');
        console.log('运行命令: yarn start');
      }
      
      return alternativeTokenData;
    } catch (secondError) {
      console.error('二次尝试也失败了:', secondError.message);
      console.log('\n=== 解决方案 ===');
      console.log('1. 请访问 https://www.strava.com/settings/api 确认您的应用设置');
      console.log('2. 请确保"授权回调域"设置为 http://localhost:8000');
      console.log('3. 如果问题仍然存在，您可能需要:');
      console.log('   - 删除app注册并重新创建');
      console.log('   - 或者尝试使用Strava的官方API测试工具');
      console.log('\n如果您熟悉命令行，可以尝试使用上述curl命令手动获取令牌');
      throw new Error('无法获取Strava访问令牌');
    }
  }
}

// 从URL或字符串中提取授权码
function extractCode(input) {
  let authCode = input.trim();
  
  // 尝试从URL中提取授权码
  if (authCode.includes('code=')) {
    try {
      const parsedUrl = new URL(authCode);
      const code = parsedUrl.searchParams.get('code');
      if (code) {
        return code;
      }
    } catch (e) {
      // 如果不是有效URL，尝试直接从字符串中提取
      const match = authCode.match(/code=([^&]+)/);
      if (match && match[1]) {
        return match[1];
      }
    }
  }
  
  // 假设输入的就是授权码本身
  return authCode;
}

// 主函数
async function main() {
  // 检查是否通过命令行参数提供了授权码
  const providedCode = process.argv[2];
  
  if (providedCode) {
    console.log('使用命令行提供的授权码');
    const code = extractCode(providedCode);
    try {
      await getAccessTokenFromCode(code);
    } catch (error) {
      console.error('处理授权码时出错:', error.message);
    } finally {
      rl.close();
    }
    return;
  }
  
  console.log('====== Strava 授权码处理工具 ======');
  console.log('这个工具帮助您使用现有的授权码获取访问令牌\n');
  
  // 提供授权链接以便用户获取新的授权码
  console.log('如果您需要获取新的授权码，请访问以下链接:');
  console.log(`https://www.strava.com/oauth/authorize?client_id=${config.STRAVA_CLIENT_ID}&redirect_uri=http%3A%2F%2Flocalhost%3A8000%2Fcallback&response_type=code&scope=read%2Cactivity%3Aread_all\n`);
  
  rl.question('请输入您的Strava授权码或包含授权码的完整URL: ', async (input) => {
    try {
      const code = extractCode(input);
      await getAccessTokenFromCode(code);
    } catch (error) {
      console.error('处理授权码时出错:', error.message);
    } finally {
      rl.close();
    }
  });
}

// 运行主函数
main();
