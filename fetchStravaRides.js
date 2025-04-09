const axios    = require('axios');
const fs       = require('fs');
const path     = require('path');
const http     = require('http');
const url      = require('url');
const open     = require('open');
const readline = require('readline');
const https    = require('https');

// 加载环境变量
require('dotenv').config();

// Strava API 认证配置 - 从环境变量加载
const config = {
  STRAVA_CLIENT_ID:     process.env.STRAVA_CLIENT_ID,
  STRAVA_CLIENT_SECRET: process.env.STRAVA_CLIENT_SECRET,
  STRAVA_USER_ID:       process.env.STRAVA_USER_ID,
  STRAVA_BASE_URL:      process.env.STRAVA_BASE_URL,
  STRAVA_REDIRECT_URI:  process.env.STRAVA_REDIRECT_URI,
  STRAVA_SCOPE:         process.env.STRAVA_SCOPE,
  TOKENFILE:            path.join(__dirname, process.env.STRAVA_TOKEN)
};

// 检查必要的环境变量是否已配置
function checkRequiredEnvVars() {
  const required = ['STRAVA_CLIENT_ID', 'STRAVA_CLIENT_SECRET'];
  const missing = required.filter(key => !process.env[key]);
  
  if (missing.length > 0) {
    console.warn(`警告: 以下环境变量未设置: ${missing.join(', ')}`);
  }
}

// 在程序开始时检查环境变量
checkRequiredEnvVars();

// 创建命令行读取界面
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// 获取当前年份
const currentYear = new Date().getFullYear();
const startOfYear = new Date(currentYear, 0, 1).getTime() / 1000; // Unix timestamp (秒)
const endOfYear = new Date(currentYear + 1, 0, 1).getTime() / 1000; // Unix timestamp (秒)

// extractActivityFields 从完整活动数据中提取指定字段
//
// Description:
//   该函数实现了数据精简，只提取需要的字段，降低内存使用
//   通过创建新对象而非修改原对象，避免副作用
//   自动构建活动URL，便于用户访问原始数据
//
// Parameters:
//   - activity: 包含完整字段的活动数据对象
//
// Returns:
//   - Object: 只包含所需字段的简化活动对象
function extractActivityFields(activity) {
  const activityUrl = `https://www.strava.com/activities/${activity.id}`;
  
  return {
    type: activity.type,                                // 活动类型
    name: activity.name,                                // 活动名称
    start_date_local: activity.start_date_local,        // 使用本地时间
    distance: activity.distance,                        // 距离（米）
    moving_time: activity.moving_time,                  // 移动时间（秒）
    total_elevation_gain: activity.total_elevation_gain,// 总爬升高度（米）
    average_speed: activity.average_speed,              // 平均速度（米/秒）
    max_speed: activity.max_speed,                      // 最大速度（米/秒）
    has_heartrate: activity.has_heartrate,              // 是否有心率数据 
    average_heartrate: activity.average_heartrate,      // 平均心率（bpm）
    max_heartrate: activity.max_heartrate,              // 最大心率（bpm）
    calories: activity.calories,                        // 消耗的卡路里
    url: activityUrl                                    // 活动的URL
  };
}

// 尝试从文件加载令牌
function loadTokenFromFile() {
  try {
    if (fs.existsSync(config.TOKENFILE)) {
      const tokenData = JSON.parse(fs.readFileSync(config.TOKENFILE, 'utf8'));
      console.log('找到保存的令牌');
      return tokenData;
    }
  } catch (error) {
    console.error('加载令牌文件失败:', error.message);
  }
  return null;
}

// 保存令牌到文件
function saveTokenToFile(tokenData) {
  try {
    fs.writeFileSync(config.TOKENFILE, JSON.stringify(tokenData, null, 2), 'utf8');
    console.log('令牌已保存，下次运行将自动使用');
  } catch (error) {
    console.error('保存令牌失败:', error.message);
  }
}

// 使用刷新令牌获取新的访问令牌
async function refreshAccessToken(refreshToken) {
  try {
    console.log('使用刷新令牌获取新的访问令牌...');
    const response = await axios.post('https://www.strava.com/oauth/token', {
      client_id: config.STRAVA_CLIENT_ID,
      client_secret: config.STRAVA_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: refreshToken
    });
    
    const tokenData = response.data;
    saveTokenToFile(tokenData);
    return tokenData.access_token;
  } catch (error) {
    console.error('刷新访问令牌失败:', error.response?.data || error.message);
    throw new Error('刷新令牌失败');
  }
}

// 通过命令行手动输入授权码
function getAuthCodeFromConsole() {
  return new Promise((resolve) => {
    const authUrl = `https://www.strava.com/oauth/authorize?client_id=${config.STRAVA_CLIENT_ID}&redirect_uri=${encodeURIComponent(config.STRAVA_REDIRECT_URI)}&response_type=code&scope=${encodeURIComponent(config.STRAVA_SCOPE)}`;
    
    console.log('\n由于自动授权过程可能出现问题，您可以手动获取授权码：');
    console.log('1. 复制并在浏览器中打开以下链接:');
    console.log(`\n${authUrl}\n`);
    console.log('2. 登录您的Strava账号并授权此应用');
    console.log('3. 授权后，您将被重定向到一个无法访问的页面');
    console.log('4. 从浏览器地址栏复制完整URL');
    
    rl.question('\n请粘贴重定向后的完整URL或直接输入授权码: ', (input) => {
      // 尝试从URL中提取授权码
      if (input.includes('code=')) {
        try {
          const parsedUrl = new URL(input);
          const code = parsedUrl.searchParams.get('code');
          if (code) {
            resolve(code);
            return;
          }
        } catch (e) {
          // 如果不是有效URL，尝试直接从字符串中提取
          const match = input.match(/code=([^&]+)/);
          if (match && match[1]) {
            resolve(match[1]);
            return;
          }
        }
      }
      
      // 假设输入的就是授权码本身
      resolve(input.trim());
    });
  });
}

// 获取授权码
async function getAuthorizationCode() {
  return new Promise((resolve, reject) => {
    let codeReceived = false;
    let server;

    try {
      // 创建本地服务器来接收回调
      server = http.createServer(async (req, res) => {
        try {
          const parsedUrl = url.parse(req.url, true);
          if (parsedUrl.pathname === '/callback') {
            const { code, error } = parsedUrl.query;
            
            // 发送成功响应给浏览器
            res.writeHead(200, {'Content-Type': 'text/html'});
            
            if (error) {
              res.end('<h1>授权失败</h1><p>您可以关闭此窗口并检查控制台错误信息</p>');
              codeReceived = true;
              server.close();
              reject(new Error(`授权错误: ${error}`));
            } else if (code) {
              res.end('<h1>授权成功!</h1><p>您可以关闭此窗口并返回命令行查看进度</p>');
              codeReceived = true;
              server.close();
              resolve(code);
            } else {
              res.end('<h1>无效的回调</h1><p>未收到授权码，请重试</p>');
              server.close();
              reject(new Error('未收到授权码'));
            }
          }
        } catch (error) {
          res.writeHead(500, {'Content-Type': 'text/html'});
          res.end('<h1>服务器错误</h1>');
          server.close();
          reject(error);
        }
      });
      
      server.listen(8000, () => {
        const authUrl = `https://www.strava.com/oauth/authorize?client_id=${config.STRAVA_CLIENT_ID}&redirect_uri=${encodeURIComponent(config.STRAVA_REDIRECT_URI)}&response_type=code&scope=${encodeURIComponent(config.STRAVA_SCOPE)}`;
        
        console.log('请在打开的浏览器中授权应用访问您的Strava账户');
        console.log(`如果浏览器没有自动打开，请手动访问: ${authUrl}`);
        
        // 自动打开浏览器
        open(authUrl).catch(error => {
          console.error('无法打开浏览器:', error.message);
          console.log(`请手动访问授权链接: ${authUrl}`);
        });
      });
      
      // 设置超时
      setTimeout(() => {
        if (!codeReceived) {
          console.log('\n自动授权流程超时，切换到手动输入模式...');
          if (server) {
            server.close();
          }
          getAuthCodeFromConsole().then(resolve).catch(reject);
        }
      }, 60 * 1000); // 1分钟后超时
    } catch (error) {
      console.error('设置授权服务器时出错:', error.message);
      console.log('切换到手动授权模式...');
      getAuthCodeFromConsole().then(resolve).catch(reject);
    }
  });
}

// 使用授权码获取访问令牌
async function getAccessTokenFromCode(code) {
  try {
    console.log('正在使用授权码获取访问令牌...');
    console.log(`授权码: ${code.substring(0, 4)}...${code.substring(code.length - 4)}`); // 只显示部分授权码

    const response = await axios.post('https://www.strava.com/oauth/token', {
      client_id: config.STRAVA_CLIENT_ID,
      client_secret: config.STRAVA_CLIENT_SECRET,
      code: code,
      grant_type: 'authorization_code'
    });
    
    const tokenData = response.data;
    console.log('成功获取访问令牌');
    saveTokenToFile(tokenData);
    return tokenData.access_token;
  } catch (error) {
    console.error('获取访问令牌失败:');
    if (error.response) {
      console.error('错误状态码:', error.response.status);
      console.error('错误详情:', JSON.stringify(error.response.data, null, 2));
    } else if (error.request) {
      console.error('未收到响应，请检查网络连接');
    } else {
      console.error('错误信息:', error.message);
    }
    
    // 如果授权码可能有问题，尝试手动输入
    console.log('\n授权码可能无效，尝试手动获取新的授权码...');
    const newCode = await getAuthCodeFromConsole();
    
    // 递归尝试新的授权码
    return getAccessTokenFromCode(newCode);
  }
}

// 获取OAuth访问令牌
async function getAccessToken() {
  try {
    // 尝试从文件加载令牌
    const savedToken = loadTokenFromFile();
    
    if (savedToken) {
      // 检查令牌是否过期
      const now = Math.floor(Date.now() / 1000);
      
      // 如果令牌即将过期（不到一小时）或已经过期，则刷新
      if (now >= savedToken.expires_at - 3600) {
        console.log('令牌已过期或即将过期，尝试刷新...');
        return refreshAccessToken(savedToken.refresh_token);
      } else {
        console.log('使用已保存的有效令牌');
        return savedToken.access_token;
      }
    } else {
      // 没有保存的令牌，走完整授权流程
      console.log('没有找到保存的令牌，开始OAuth授权流程...');
      try {
        const authCode = await getAuthorizationCode();
        return await getAccessTokenFromCode(authCode);
      } catch (error) {
        console.error('自动授权流程失败:', error.message);
        console.log('切换到手动授权模式...');
        const manualCode = await getAuthCodeFromConsole();
        return await getAccessTokenFromCode(manualCode);
      }
    }
  } finally {
    // 确保readline接口在函数完成后关闭
  }
}

// makeGetRequest 使用原生Node.js HTTPS模块发送GET请求，避免第三方库依赖问题
//
// Description:
//   该函数使用Node.js内置HTTPS模块直接发送请求，避免了Axios可能遇到的协议不匹配问题
//   通过直接处理底层HTTP响应，减少中间层处理开销，提高性能
//   包含完整的错误处理和HTTP状态码验证，确保数据的可靠性
//
// Parameters:
//   - url        : 要请求的完整URL地址
//   - accessToken: Strava API的访问令牌，用于授权请求
//
// Returns:
//   - Promise<Object>: 返回解析后的JSON数据对象
//   - 在出错情况下，返回被拒绝的Promise和错误信息
function makeGetRequest(url, accessToken) {
  return new Promise((resolve, reject) => {
    const options = {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`
      }
    };
    
    https.get(url, options, (res) => {
      let data = '';
      
      // 使用事件监听模式收集数据块
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            const parsedData = JSON.parse(data);
            resolve(parsedData);
          } catch (e) {
            reject(new Error('无法解析响应数据'));
          }
        } else {
          reject(new Error(`HTTP错误状态码: ${res.statusCode}, 响应: ${data}`));
        }
      });
    }).on('error', (error) => {
      reject(error);
    });
  });
}

// getActivities 获取用户的骑行活动列表，支持分页处理大量数据
//
// Description:
//   该函数使用分页机制获取Strava API中的活动数据
//   实现了容错机制，当原生HTTPS请求失败时自动切换到Axios作为备选方案
//   通过过滤机制，只保留类型为'Ride'的骑行活动，减少不必要的数据处理
//   使用累加器模式收集多页数据，优化内存使用
//
// Parameters:
//   - accessToken: 有效的Strava API访问令牌
//
// Returns:
//   - Promise<Array>: 包含所有骑行活动的数组
async function getActivities(accessToken) {
  console.log('开始获取活动列表...');
  let page = 1;
  const perPage = 100; // Strava API允许的最大页面大小，减少请求次数
  let allActivities = [];
  let hasMoreActivities = true;

  while (hasMoreActivities) {
    try {
      console.log(`获取第${page}页活动...`);
      
      // 构建请求URL，包含年份范围和分页参数
      const apiUrl = `${config.STRAVA_BASE_URL}/athlete/activities?after=${startOfYear}&before=${endOfYear}&page=${page}&per_page=${perPage}`;
      
      // 使用原生HTTPS模块发送请求
      console.log('使用原生HTTPS模块发送请求...');
      const activities = await makeGetRequest(apiUrl, accessToken);
      
      // 检查是否已获取所有数据
      if (activities.length === 0) {
        hasMoreActivities = false;
      } else {
        // 过滤只保留骑行活动 (type: 'Ride')
        console.log(`本页获取了 ${activities.length} 个活动`);
        const rides = activities.filter(activity => activity.type === 'Ride');
        console.log(`其中 ${rides.length} 个是骑行活动`);

        // 使用concat避免数组嵌套
        allActivities = allActivities.concat(rides);
        page++;
      }
    } catch (error) {
      console.error('获取活动列表失败:', error.message);
      
      // 备选方案：当原生请求失败时使用axios
      try {
        console.log('尝试使用axios作为备选方案...');
        const response = await axios.get(`${config.STRAVA_BASE_URL}/athlete/activities`, {
          headers: { Authorization: `Bearer ${accessToken}` },
          params: {
            after: startOfYear,
            before: endOfYear,
            page: page,
            per_page: perPage
          }
        });
        
        const activities = response.data;
        if (activities.length === 0) {
          hasMoreActivities = false;
        } else {
          const rides = activities.filter(activity => activity.type === 'Ride');
          allActivities = allActivities.concat(rides);
          page++;
        }
      } catch (axiosError) {
        console.error('备选方法也失败:', axiosError.message);
        // 两种方法都失败时终止循环
        hasMoreActivities = false;
      }
    }
  }

  console.log(`共找到${allActivities.length}个骑行活动`);
  return allActivities;
}

// getDetailedActivities 获取每个活动的详细数据
//
// Description:
//   该函数对每个活动ID发起单独请求获取完整详情
//   实现了双重错误处理和备选方案，确保最大程度获取数据
//   添加了请求延迟，避免触发Strava API的速率限制
//   优化了内存使用，只提取需要的字段，减少不必要的数据存储
//
// Parameters:
//   - accessToken: 有效的Strava API访问令牌
//   - activities: 包含基本活动信息的数组，必须包含id和name字段
//
// Returns:
//   - Promise<Array>: 包含每个活动详细数据的数组
async function getDetailedActivities(accessToken, activities) {
  console.log('开始获取每个活动的详细数据...');
  const detailedActivities = [];
  
  // 遍历使用索引，便于进度跟踪
  for (let i = 0; i < activities.length; i++) {
    const activity = activities[i];
    console.log(`获取活动详情 ${i+1}/${activities.length}: ${activity.name}`);
    
    try {
      const apiUrl = `${config.STRAVA_BASE_URL}/activities/${activity.id}?include_all_efforts=true`;
      
      const activityData = await makeGetRequest(apiUrl, accessToken);
      // 提取指定字段
      const simplifiedActivity = extractActivityFields(activityData);
      detailedActivities.push(simplifiedActivity);
      
      await new Promise(resolve => setTimeout(resolve, 100));
    } catch (error) {
      console.error(`获取活动 ${activity.id} 详情失败:`, error.message);
      
      // 备选方案：尝试使用axios重新获取
      try {
        console.log('尝试使用axios作为备选方案...');
        const response = await axios.get(`${config.STRAVA_BASE_URL}/activities/${activity.id}`, {
          headers: { Authorization: `Bearer ${accessToken}` },
          params: {
            include_all_efforts: true
          }
        });
        
        // 提取指定字段
        const simplifiedActivity = extractActivityFields(response.data);
        detailedActivities.push(simplifiedActivity);
      } catch (axiosError) {
        console.error(`备选方法也失败:`, axiosError.message);

        // 即使两种方法都失败，仍尝试保存基本信息
        const simplifiedActivity = extractActivityFields(activity);
        detailedActivities.push(simplifiedActivity);
      }
      
      // 错误情况下添加更长的延迟，避免持续触发错误
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  
  return detailedActivities;
}

// convertActivityData 将活动数据转换为指定格式
//
// Description:
//   该函数实现了高性能的数据转换，预分配数组大小避免动态扩容
//   进行多种单位转换：速度(m/s→km/h)、时间(秒→小时.分钟)、距离(米→公里)
//   日期格式化：从ISO格式到YYYY-MM-DD格式
//   使用原位计算和直接赋值，避免不必要的中间变量，优化内存使用
//
// Parameters:
//   - activities: 原始活动数据数组，包含API返回的完整字段
//
// Returns:
//   - Array: 转换后的指定格式数据数组
function convertActivityData(activities) {
  // 预分配结果数组大小，避免动态扩容带来的性能损失
  const result = new Array(activities.length);
  
  for (let i = 0; i < activities.length; i++) {
    const activity = activities[i];
    
    // 速度转换：从 m/s 到 km/h (乘以3.6)
    // 使用整数乘法(36)后除以10，提高精度和性能
    const averageSpeedKmh = Math.round(activity.average_speed * 36) / 10;
    const maxSpeedKmh = Math.round(activity.max_speed * 36) / 10;
    
    // 时间转换：从秒到 HH:MM 格式，保留两位小数，四舍五入
    const totalHours = activity.moving_time / 3600;
    const hours = Math.floor(totalHours);
    const decimalMinutes = (totalHours - hours) * 60;
    const roundedMinutes = Math.round(decimalMinutes * 100) / 100;
    const formattedTime = `${hours.toString().padStart(2, '0')}.${roundedMinutes.toFixed(0)}`;
    
    // 距离转换：从米到公里 (除以1000并保留2位小数)
    const distanceKm = Math.round(activity.distance / 10) / 100;
    
    // 日期转换：从ISO格式(2025-04-08T13:56:26Z)到YYYY-MM-DD(2025-04-08)
    const formattedDate = activity.start_date_local.substring(0, 10);
    
    // 创建新对象，保留所有原始字段但更新转换后的值
    result[i] = {
      type: activity.type,
      name: activity.name,
      start_date_local: formattedDate,
      distance: distanceKm,
      moving_time: formattedTime,
      total_elevation_gain: activity.total_elevation_gain,
      average_speed: averageSpeedKmh,
      max_speed: maxSpeedKmh,
      has_heartrate: activity.has_heartrate,
      average_heartrate: activity.average_heartrate,
      max_heartrate: activity.max_heartrate,
      calories: activity.calories,
      url: activity.url
    };
  }
  
  return result;
}

// 保存数据到JSON文件
function saveToJson(data) {
  // 在保存前转换数据格式
  const convertedData = convertActivityData(data);
  
  const filename = `strava_data.json`;
  const filePath = path.join(__dirname, filename);
  
  fs.writeFileSync(filePath, JSON.stringify(convertedData, null, 2), 'utf8');
}

// 主函数
async function main() {
  try {
    console.log(`开始获取${currentYear}年的骑行数据...`);
    
    const accessToken = await getAccessToken();
    console.log('访问令牌获取成功');
    
    const activities = await getActivities(accessToken);
    
    const detailedActivities = await getDetailedActivities(accessToken, activities);
    
    saveToJson(detailedActivities);
    
    console.log('数据获取完成!');
  } catch (error) {
    console.error('发生错误:', error);
  } finally {
    // 关闭readline接口
    rl.close();
  }
}

main();