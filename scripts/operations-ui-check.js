async page=>{
 if(!page.url().startsWith('http://127.0.0.1:4187/'))throw Error('只允许本地合成演示');
 await page.reload();await page.waitForFunction(()=>!document.getElementById('app').hidden&&!document.getElementById('budgetSave').disabled);
 const checks=[],errors=[];page.on('pageerror',e=>errors.push(e.message));
 const check=(ok,label)=>{if(!ok)throw Error(label);checks.push(label);};
 await page.getByRole('button',{name:'Token 用量',exact:true}).click();
 await page.waitForFunction(()=>!document.getElementById('budgetSave').disabled);
 check((await page.locator('#budgetDay').textContent()).includes('35'),'当日已记录请求来自数据');
 await page.locator('#budgetDaily').fill('5');await page.locator('#budgetConversation').selectOption('group:10001');await page.locator('#budgetConversationLimit').fill('2');
  await page.locator('#budgetConversation').selectOption('private:20002');await page.locator('#budgetConversationLimit').fill('3');await page.locator('#budgetConversation').selectOption('group:10001');check(await page.locator('#budgetConversationLimit').inputValue()==='2','切换会话保留各自未保存预算');
 await page.getByRole('button',{name:'刷新',exact:true}).click();
 await page.waitForFunction(()=>!document.getElementById('refresh').disabled);
 check(await page.locator('#budgetDaily').inputValue()==='5'&&await page.locator('#budgetConversationLimit').inputValue()==='2','刷新保留未保存的预算草稿');
 await page.getByRole('button',{name:'保存策略',exact:true}).click();await page.waitForFunction(()=>document.getElementById('budgetSaveStatus').textContent.includes('已保存'));
 let ops=await page.evaluate(async()=>{const t=sessionStorage.getItem('dashboardAccess');return await(await fetch('./api/operations',{headers:{'x-console-token':t}})).json();});
 check(ops.budget.policy.dailyLimit===5&&ops.budget.policy.conversationLimits['group:10001']===2&&ops.budget.policy.conversationLimits['private:20002']===3,'总预算及多个会话预算真实保存');
 await page.reload();await page.waitForFunction(()=>!document.getElementById('app').hidden&&!document.getElementById('budgetSave').disabled);
 await page.getByRole('button',{name:'Token 用量',exact:true}).click();check(await page.locator('#budgetDaily').inputValue()==='5','重新加载恢复服务器策略');
 await page.request.get('http://127.0.0.1:4187/__fixture/mode?value=save-error');
 await page.locator('#budgetDaily').fill('8');await page.getByRole('button',{name:'保存策略',exact:true}).click();await page.waitForFunction(()=>document.getElementById('budgetSaveStatus').textContent.includes('未能保存'));
 await page.request.get('http://127.0.0.1:4187/__fixture/mode?value=online');
 ops=await page.evaluate(async()=>await(await fetch('./api/operations',{headers:{'x-console-token':sessionStorage.getItem('dashboardAccess')}})).json());check(ops.budget.policy.dailyLimit===5,'保存失败保留原策略');
 await page.getByRole('button',{name:'最近活动',exact:true}).click();
 check((await page.locator('#diagnosticTraces').textContent()).includes('网关已接受回复'),'实际诊断阶段可见');
 check((await page.locator('#diagnosticIncidents').textContent()).includes('请求超时')&&(await page.locator('#diagnosticIncidents').textContent()).includes('恢复'),'异常分类与恢复记录可见');
 for(const width of [1440,768,390,320]){await page.setViewportSize({width,height:1000});for(const name of ['总览','Token 用量','最近活动']){await page.getByRole('button',{name,exact:true}).click();check(!(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)),`${width}px ${name}无横向溢出`);}}
 const requests=await(await page.request.get('http://127.0.0.1:4187/__fixture/requests')).json();check(requests.filter(x=>x.method!=='GET').every(x=>x.path==='/dashboard/api/budget-policy'),'写入只发生在明确预算保存');
 check(!errors.length,'预算与诊断无JS错误');
 await page.setViewportSize({width:1440,height:1000});await page.getByRole('button',{name:'Token 用量',exact:true}).click();await page.screenshot({path:'state/operations-qa/budget-desktop.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'最近活动',exact:true}).click();await page.screenshot({path:'state/operations-qa/diagnostics-mobile.png',fullPage:true});
 return {passed:checks.length,checks};
}
