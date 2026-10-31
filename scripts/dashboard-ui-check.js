// 由playwright-cli run-code --filename执行；仅允许本地合成数据演示。
async page => {
  if (!page.url().startsWith('http://127.0.0.1:4187/')) throw Error('仅允许本地工作台演示，禁止对生产环境运行');
  const checks=[];const errors=[];const external=[];page.on('pageerror',e=>errors.push(e.message));
  page.on('request',r=>{if(!r.url().startsWith('http://127.0.0.1:4187/')&&!r.url().startsWith('data:'))external.push(r.url());});
  const check=(condition,message)=>{if(!condition)throw Error(message);checks.push(message);};
  const title=async value=>page.getByRole('button',{name:value,exact:true}).click();
  const waitApp=()=>page.waitForFunction(()=>!document.getElementById('app').hidden);
  if(await page.getByRole('button',{name:'锁定工作台'}).isVisible())await page.getByRole('button',{name:'锁定工作台'}).click();
  await page.getByRole('textbox',{name:'登录密码'}).fill('invalid-fixture-token');await page.getByRole('button',{name:'登录工作台'}).click();
  await page.waitForFunction(()=>document.getElementById('loginError').textContent.includes('密码'));
  check(await page.locator('#app').isHidden(),'错误令牌不展示私有数据');
  await page.getByRole('textbox',{name:'登录密码'}).fill('fixture-dashboard-token');await page.getByRole('button',{name:'登录工作台'}).click();await waitApp();
  check(await page.locator('#demoBanner').isVisible(),'演示环境明确标注合成数据');
  const views=['总览','会话聊天','长期记忆','Token 用量','最近活动'];
  for(const width of [1440,768,390,320]){
    await page.setViewportSize({width,height:1000});
    for(const name of views){await title(name);check(!(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)),`${width}px · ${name}无横向溢出`);}
  }
  await page.setViewportSize({width:1440,height:1000});await title('会话聊天');await page.waitForFunction(()=>document.querySelectorAll('#chatMessages .chat-message').length>0);
  await page.getByRole('searchbox',{name:'搜索最近聊天'}).fill('不存在的消息001');check(await page.getByText('没有匹配的消息',{exact:true}).isVisible(),'聊天搜索的真实空结果');await page.getByRole('searchbox',{name:'搜索最近聊天'}).fill('');
  await page.route('**/api/conversation?*',async route=>{const response=await route.fetch();const data=await response.json();data.messages[0].text='<img src=x onerror=alert(1)>';await route.fulfill({response,json:data});});
  await title('会话聊天');await page.waitForFunction(()=>document.getElementById('chatMessages').textContent.includes('<img'));
  check(await page.locator('#chatMessages img[onerror]').count()===0 && await page.locator('#chatMessages img[src="x"]').count()===0,'不可信聊天HTML仅显示为文本');await page.unroute('**/api/conversation?*');
  await title('长期记忆');await page.waitForFunction(()=>document.querySelectorAll('#memoryGrid .memory-card').length>0);await title('人物');
  check(await page.locator('#memoryGrid .memory-card').count()===1,'记忆按人物分类');await page.getByRole('searchbox',{name:'搜索长期记忆'}).fill('不会匹配001');check(await page.getByText('没有匹配的记忆',{exact:true}).isVisible(),'记忆搜索保留空状态');await page.getByRole('searchbox',{name:'搜索长期记忆'}).fill('');await title('全部');
  await title('Token 用量');await title('7 天');await page.waitForFunction(()=>document.getElementById('chartSubtitle').textContent.includes('近7天')&&document.querySelectorAll('#usageChart svg path').length===2);check(await page.locator('#usageChart svg path').count()===2,'7天趋势读取并渲染');
  await title('最近活动');await title('系统日志');check((await page.locator('#activityHint').textContent()).includes('不推算日期'),'无日期系统日志不冒充完整时间');
  await page.request.get('http://127.0.0.1:4187/__fixture/mode?value=offline');await page.getByRole('button',{name:'刷新',exact:true}).click();await page.waitForFunction(()=>document.getElementById('heroTitle').textContent.includes('离线'));check((await page.locator('#heroTitle').textContent()).includes('离线'),'真实离线分支不显示在线');
  await page.route('**/api/overview',route=>route.fulfill({status:503,json:{ok:false}}));await page.getByRole('button',{name:'刷新',exact:true}).click();await page.waitForFunction(()=>!document.getElementById('staleBanner').hidden);check((await page.locator('#heroTag').textContent()).includes('过期'),'读取失败保留旧数据并标注过期');await page.unroute('**/api/overview');
  await page.request.get('http://127.0.0.1:4187/__fixture/mode?value=online');await page.getByRole('button',{name:'刷新',exact:true}).click();await page.waitForFunction(()=>document.getElementById('staleBanner').hidden);
  const before=(await(await page.request.get('http://127.0.0.1:4187/__fixture/requests')).json()).length;
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{value:true,configurable:true});document.dispatchEvent(new Event('visibilitychange'));});
  await page.waitForTimeout(11000);
  const after=(await(await page.request.get('http://127.0.0.1:4187/__fixture/requests')).json()).length;check(before===after,'页面隐藏期间不轮询后台');
  await page.evaluate(()=>{delete document.hidden;document.dispatchEvent(new Event('visibilitychange'));});
  const requests=await(await page.request.get('http://127.0.0.1:4187/__fixture/requests')).json();check(requests.every(r=>r.method==='GET'),'全部界面操作均为只读GET');check(errors.length===0,'无JavaScript页面错误');check(external.length===0,'无外部网络请求');
  await title('总览');await page.screenshot({path:'state/dashboard-qa/desktop-verified.png',fullPage:true});await page.setViewportSize({width:390,height:844});await page.screenshot({path:'state/dashboard-qa/mobile-verified.png',fullPage:true});
  return {passed:checks.length,checks};
}
