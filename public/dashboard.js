'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const q = selector => [...document.querySelectorAll(selector)];
  const titles = {overview:['总览','连接、对话与记忆，一眼看见。'],chats:['会话聊天','看看它和谁聊了天，又说了些什么。'],memories:['长期记忆','留下来的，不只有聊天记录。'],usage:['Token 用量','了解每一段对话的输入、输出与缓存。'],activity:['最近活动','它的一举一动，都有真实记录。']};
  const state = {token:'',connected:false,overview:null,detail:null,series:null,view:'overview',selectedKey:null,hours:24,category:'all',activity:'messages',poll:null,refreshing:false,usageAt:0,usageId:0,detailId:0,epoch:0,chatSignature:'',stale:false};
  const storage = {get(key){try{return sessionStorage.getItem(key)||localStorage.getItem(key)||'';}catch{return'';}},set(key,value,persist){try{(persist?localStorage:sessionStorage).setItem(key,value);}catch{}},remove(key){try{localStorage.removeItem(key);sessionStorage.removeItem(key);}catch{}}};
  function el(tag,className,value){const n=document.createElement(tag);if(className)n.className=className;if(value!==undefined)n.textContent=String(value);return n;}
  function icon(name){const n=document.createElementNS('http://www.w3.org/2000/svg','svg');const use=document.createElementNS(n.namespaceURI,'use');use.setAttribute('href',`#i-${name}`);n.append(use);n.setAttribute('aria-hidden','true');return n;}
  const good = v => typeof v==='number'&&Number.isFinite(v)&&v>=0;
  const exact = v => good(v)?new Intl.NumberFormat('zh-CN').format(v):'—';
  function compact(v){if(!good(v))return'—';if(v>=1e8)return`${(v/1e8).toFixed(2)} 亿`;if(v>=1e4)return`${(v/1e4).toFixed(v>=1e6?1:2)} 万`;return exact(v);}
  function money(v){return good(v)?`${state.overview?.tokens?.symbol||''}${v.toFixed(v>100?2:4)}`:'—';}
  function when(at,full=false){if(!good(at)||at===0)return'未记录时间';return new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',...(full?{month:'2-digit',day:'2-digit'}:{}),hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(at));}
  function ago(at){if(!good(at)||at===0)return'时间未知';const delta=Date.now()-at;if(delta<0)return when(at,true);if(delta<60000)return'刚刚';if(delta<3600000)return`${Math.floor(delta/60000)}分钟前`;if(delta<86400000)return`${Math.floor(delta/3600000)}小时前`;return when(at,true);}
  const label = key => state.overview?.conversations.find(x=>x.key===key)?.label || String(key||'未归属会话').replace(/^group:/,'群聊 ').replace(/^private:/,'私聊 ');
  function empty(parent,title,description,kind='chat'){const box=el('div','empty');box.append(icon(kind),el('strong','',title));if(description)box.append(el('small','',description));parent.replaceChildren(box);}
  function toast(message){$('toast').textContent=message;$('toast').hidden=false;clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('toast').hidden=true,4500);}
  function setText(id,value){$(id).textContent=value;}
  async function request(route,init={}){
    const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),8000);
    try{
      const response=await fetch(new URL(`api/${route}`,location.href),{...init,headers:{...(init.body?{'content-type':'application/json'}:{}),'x-console-token':state.token},signal:controller.signal,cache:'no-store',credentials:'same-origin'});
      if(response.status===401||response.status===403)throw Object.assign(new Error('密码不正确或已更改，请重新登录。'),{auth:true});
      if(!response.ok)throw new Error(init.body?'策略未保存，请检查输入或稍后重试':'暂时无法读取数据');
      const data=await response.json();if(data.ok===false)throw new Error('暂时无法读取数据');return data;
    }finally{clearTimeout(timeout);}
  }
  function stopPolling(){clearInterval(state.poll);state.poll=null;}
  function startPolling(){stopPolling();if(state.connected&&!document.hidden)state.poll=setInterval(refresh,10000);}
  function lock(message=''){
    stopPolling();state.epoch++;state.token='';state.connected=false;state.overview=null;state.detail=null;state.series=null;state.operations=null;state.budgetDirty=false;state.budgetSaving=false;state.budgetDrafts={};state.chatSignature='';state.refreshing=false;
    for(const key of ['consoleToken','dashboardAccess'])storage.remove(key);
    for(const id of ['conversationList','chatMessages','memoryGrid','usageRows','activityList','recentChats','recentActivity','overviewChart','usageChart','botMeta','serviceList','budgetAlerts','todayConversationCosts','diagnosticTraces','diagnosticIncidents'])$(id).replaceChildren();
    $('budgetSave').disabled=true;$('budgetDaily').value='';$('budgetConversationLimit').value='';
    $('app').hidden=true;$('login').hidden=false;$('loginError').textContent=message;$('accessToken').value='';$('refresh').disabled=false;$('loginSubmit').disabled=false;document.title='大肥鱼 · 工作台';
  }
  function markStale(){
    state.stale=true;$('app').dataset.stale='true';$('staleBanner').hidden=false;
    $('staleBanner').textContent='暂时无法同步。下方保留上次成功读取的数据，连接状态已过期；请稍后刷新。';
    $('syncBadge').classList.add('stale');$('syncBadge').lastChild.textContent='状态已过期';setText('heroTag','状态已过期');
  }
  function setView(view){
    if(!titles[view])view='overview';state.view=view;
    q('[data-view]').forEach(x=>x.hidden=x.dataset.view!==view);
    q('[data-page]').forEach(x=>{const active=x.dataset.page===view;x.classList.toggle('active',active);if(active)x.setAttribute('aria-current','page');else x.removeAttribute('aria-current');});
    setText('pageTitle',titles[view][0]);setText('breadcrumb',titles[view][0]);setText('pageDescription',titles[view][1]);
    document.title=`${titles[view][0]} · 大肥鱼工作台`;history.replaceState(null,'',`#${view}`);
    if(state.connected&&['chats','memories'].includes(view))loadDetail().catch(handleError);
    if(view==='usage')renderUsage();if(view==='activity')renderActivity();
  }
  function handleError(error){if(error.auth)lock(error.message);else toast('数据暂不可用，请稍后刷新。');}
  function pill(value){return el('span','',value);}
  function avatarView(self,name,type=''){
    const node=el('span',`avatar ${self?'self':type}`);
    if(self){const image=el('img');image.src='./dashboard-avatar.jpg';image.alt='大肥鱼头像';node.append(image);}else node.textContent=name.slice(0,1);
    return node;
  }
  function renderOverview(){
    const d=state.overview;if(!d)return;const b=d.bot;const t=d.tokens;
    state.stale=false;$('app').dataset.stale='false';$('staleBanner').hidden=true;$('demoBanner').hidden=d.demo!==true;
    $('syncBadge').classList.remove('stale');$('syncBadge').replaceChildren(el('i'),document.createTextNode('已同步'));
    setText('dateLabel',new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'long',day:'numeric',weekday:'long'}).format(new Date(d.generatedAt)));
    const online=b.connection==='online';
    setText('heroTag',b.paused?'已暂停自动回复':online?(d.counts.busy?'正在参与聊天':'在线 · 等待新的故事'):b.connection==='offline'?'连接已断开':'正在确认连接');
    setText('heroTitle',b.paused?'大肥鱼，休息一下。':online?(d.counts.busy?'大肥鱼正在接话。':'大肥鱼正在潜水。'):b.connection==='offline'?'大肥鱼暂时离线。':'正在了解大肥鱼的状态。');
    setText('heroDescription',!online&&b.recovery?.message?b.recovery.message:online?'群里的热闹，和那些记住的小事。':'状态来自网关与桥接，不根据页面是否打开推断。');
    document.querySelector('.hero').dataset.connection=b.connection;
    setText('botAccount',b.accountId?`QQ ${b.accountId}`:'账号信息未提供');
    $('botMeta').replaceChildren(pill(b.model||'模型未提供'),pill(b.reasoningEffort?`${b.reasoningEffort} 推理`:'推理档位未提供'),pill(b.voiceEnabled?'语音已开启':'语音未开启'));
    setText('statTokens',t?.available?compact(t.totalTokens):'—');setText('statCost',t?.available?money(t.estimatedCost):'—');
    setText('statTokensHint',t?.available?`输入 ${compact(t.inputTokens)} / 输出 ${compact(t.outputTokens)}${t.stale?' · 统计已过期':''}`:'用量数据暂不可用');
    setText('statConversations',exact(d.counts.conversations));setText('statConversationsHint',`${d.conversations.filter(x=>x.type==='group').length} 个群聊 · ${d.conversations.filter(x=>x.type==='private').length} 个私聊`);setText('statMemories',exact(d.counts.memories));
    setText('cachePill',t?.available&&good(t.cacheHitRate)?`缓存命中 ${(t.cacheHitRate*100).toFixed(1)}%`:'缓存数据不可用');
    const services=[['QQ','QQ 网关',online?'已在线':b.connection==='offline'?'已断开':b.connection==='degraded'?'连接异常':'待确认',online?'':b.connection==='unknown'?'unknown':'offline'],['AI','聊天服务',b.dshReady===true?'已就绪':b.dshReady===false?'未就绪':'待确认',b.dshReady===true?'':b.dshReady===false?'offline':'unknown'],['鱼','机器人状态',b.paused?'已暂停':d.counts.busy?`${d.counts.busy} 个会话处理中`:online?'潜水观察中':'状态待确认',b.paused?'warning':online?'':'unknown'],['↻','自动恢复',b.recovery?.requiresAction?'需要处理':b.recovery?.stale?'状态已过期':b.recovery?.phase==='online'?'已就绪':b.recovery?'恢复中':'未提供',b.recovery?.requiresAction?'warning':b.recovery?.stale||!b.recovery?'unknown':'']];
    $('serviceList').replaceChildren(...services.map(([mark,name,value,cls])=>{const row=el('div','service-row');const left=el('div');left.append(el('span','service-icon',mark),el('span','',name));const right=el('span',`service-value ${cls}`);right.append(el('i','small-dot'),document.createTextNode(value));row.append(left,right);return row;}));
    setText('healthHint',b.recovery?.message||'未提供自动恢复状态。');setText('updatedAt',`同步于 ${when(d.generatedAt)} · 北京时间`);
    renderRecentChats();renderConversations();renderMemorySelector();renderActivity(true);renderUsage();
  }
  function renderRecentChats(){
    const data=state.overview?.recentMessages||[];
    if(!data.length){empty($('recentChats'),'还没有保留的聊天','有新的对话时，会在这里出现。');return;}
    $('recentChats').replaceChildren(...data.slice(0,5).map(m=>{
      const row=el('button','preview-row');row.type='button';row.append(avatarView(m.isSelf,m.sender,m.key.startsWith('private:')?'private':''));
      const content=el('div','preview-content');const top=el('div','preview-top');top.append(el('strong','',label(m.key)),el('time','',ago(m.time)));
      content.append(top,el('p','',`${m.sender}：${m.text||'[附件消息]'}`));row.append(content);row.addEventListener('click',()=>selectConversation(m.key,'chats'));return row;
    }));
  }
  function renderConversations(){
    const needle=$('conversationSearch').value.trim().toLowerCase();const list=(state.overview?.conversations||[]).filter(c=>`${c.key} ${c.label}`.toLowerCase().includes(needle));setText('chatCount',exact(state.overview?.conversations.length));
    if(!list.length){empty($('conversationList'),needle?'没有匹配的会话':'尚无会话记录','');return;}
    $('conversationList').replaceChildren(...list.map(c=>{
      const button=el('button',`conversation-option ${c.key===state.selectedKey?'active':''}`);button.type='button';if(c.key===state.selectedKey)button.setAttribute('aria-pressed','true');
      button.append(el('span',`avatar ${c.type==='private'?'private':''}`,c.type==='group'?'群':'友'));
      const copy=el('div','preview-content');const title=el('div','preview-top');title.append(el('strong','',c.label));if(c.unreadCount)title.append(el('i','unread'));
      copy.append(title,el('p','',c.preview||'暂无消息预览'),el('small','',`${c.enabled?'已启用':'保留记录'} · ${ago(c.lastActivityAt)}`));button.append(copy);button.addEventListener('click',()=>selectConversation(c.key,'chats'));return button;
    }));
  }
  function renderMemorySelector(){
    const select=$('memoryConversation');const list=state.overview?.conversations||[];const signature=list.map(c=>`${c.key}:${c.label}`).join('|');
    if(select.dataset.signature!==signature){select.replaceChildren(...list.map(c=>{const option=el('option','',c.label);option.value=c.key;return option;}));select.dataset.signature=signature;}
    if(state.selectedKey)select.value=state.selectedKey;
  }
  async function selectConversation(key,view=state.view){
    if(key!==state.selectedKey){state.selectedKey=key;state.detail=null;state.chatSignature='';empty($('chatMessages'),'正在读取会话…','');empty($('memoryGrid'),'正在读取记忆…','','memory');}
    renderConversations();renderMemorySelector();if(state.view!==view)setView(view);else await loadDetail().catch(handleError);
  }
  async function loadDetail(){
    const key=state.selectedKey;if(!key){empty($('chatMessages'),'还没有会话','机器人保留的聊天会显示在这里。');empty($('memoryGrid'),'还没有可查看的记忆','先选择一个有记录的会话。','memory');return;}
    const epoch=state.epoch;const id=++state.detailId;
    try{
      const data=await request(`conversation?key=${encodeURIComponent(key)}`);
      if(epoch!==state.epoch||id!==state.detailId||key!==state.selectedKey||!state.connected)return;
      state.detail=data;renderChat();renderMemories();
    }catch(error){if(epoch!==state.epoch||id!==state.detailId||key!==state.selectedKey)return;throw error;}
  }
  function renderChat(){
    const d=state.detail;if(!d)return;setText('chatTitle',label(d.key));setText('chatHint',`保留 ${exact(d.retainedCount)} 条最近消息 · ${d.key.startsWith('group:')?'群聊':'私聊'}`);
    const needle=$('messageSearch').value.trim().toLowerCase();const messages=d.messages.filter(m=>`${m.sender} ${m.text} ${m.tail||''}`.toLowerCase().includes(needle));
    const signature=JSON.stringify([d.key,needle,messages]);if(signature===state.chatSignature)return;state.chatSignature=signature;
    const parent=$('chatMessages');const previousTop=parent.scrollTop;const nearBottom=parent.scrollHeight-parent.clientHeight-parent.scrollTop<90;
    if(!messages.length){empty(parent,needle?'没有匹配的消息':'暂时没有消息','这里只显示已保留的最近聊天预览。');return;}
    parent.replaceChildren(...messages.map(m=>{
      const message=el('article',`chat-message ${m.isSelf?'self':''}`);const avatar=avatarView(m.isSelf,m.sender);const body=el('div','chat-message-body');
      const head=el('div','chat-message-head');head.append(el('span','',m.userId&&!m.isSelf?`${m.sender} · ${m.userId}`:m.sender),el('time','',when(m.time)));body.append(head);
      if(m.replyTo&&(m.replyTo.text||m.replyTo.sender))body.append(el('div','quote',`${m.replyTo.sender||'引用消息'}：${m.replyTo.text||''}`));
      body.append(el('p','',m.text||'[附件消息]'));if(m.tail)body.append(el('div','quote',`长消息末尾预览：${m.tail}`));
      if(m.mediaKinds.length){const tags=el('div','media-tags');const types={image:'图片',record:'语音',face:'表情',video:'视频',file:'文件',forward:'合并转发',attachment:'附件'};tags.append(...m.mediaKinds.map(x=>el('span','',types[x]||'附件')));body.append(tags);}
      message.append(avatar,body);return message;
    }));parent.scrollTop=nearBottom?parent.scrollHeight:previousTop;
  }
  function renderMemories(){
    const d=state.detail;if(!d)return;const memories=d.memories;const types={people:['人物印象','person'],topics:['当前话题','topic'],thoughts:['待办与想法','thought']};const needle=$('memorySearch').value.trim().toLowerCase();const cards=[];
    for(const [type,list] of Object.entries(memories)){
      if(state.category!=='all'&&state.category!==type)continue;
      for(const item of list){if(needle&&!JSON.stringify(item).toLowerCase().includes(needle))continue;
        const card=el('article',`card memory-card ${types[type][1]}`);card.append(el('span','memory-type',types[type][0]));
        if(type==='people'){
          card.append(el('h3','',item.name));if(item.id)card.append(el('p','',`QQ ${item.id}`));const traits=el('div','traits');traits.append(...item.traits.map(x=>el('span','',x)));card.append(traits,el('small','',good(item.interactionCount)?`${exact(item.interactionCount)} 次已记录互动`:'互动次数未记录'));
        }else{
          card.append(el('h3','',item.text));if(item.pendingQuestion)card.append(el('p','',`待跟进：${item.pendingQuestion}`));if(item.motivation)card.append(el('p','',item.motivation));
          card.append(el('small','',type==='topics'?(item.lastMentionAt?`最后提及 ${when(item.lastMentionAt,true)}`:'提及时间未记录'):(item.expiresAt?`有效至 ${when(item.expiresAt,true)}`:'未设置过期时间')));
        }
        cards.push(card);
      }
    }
    setText('memoryHint',`${label(d.key)} · ${cards.length} 条当前可见记忆。人物、话题和待办按会话隔离。`);
    if(!cards.length)empty($('memoryGrid'),needle?'没有匹配的记忆':'这里还没有长期记忆','对话中留下的人物印象、话题和待办会显示在这里。','memory');else $('memoryGrid').replaceChildren(...cards);
  }
  function svgNode(tag,attrs={},value){const node=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const [k,v] of Object.entries(attrs))node.setAttribute(k,String(v));if(value!==undefined)node.textContent=String(value);return node;}
  function renderChart(container){
    const data=state.series;
    if(!data?.available){empty(container,'趋势数据暂不可用','稍后刷新，不以零值代替缺失数据。','chart');return;}
    if(!data.buckets?.length||data.requests===0){empty(container,'这个时段还没有逐轮记录','累计用量可能包含更早的历史。','chart');return;}
    if(data.buckets.some(x=>!good(x.tokens)||!good(x.t))){empty(container,'趋势数据不完整','缺失记录不会补成虚构的用量。','chart');return;}
    const buckets=data.buckets;const max=Math.max(...buckets.map(x=>x.tokens),1);const width=760,height=190,left=43,right=12,top=14,bottom=30;const chartWidth=width-left-right,chartHeight=height-top-bottom;
    const svg=svgNode('svg',{viewBox:`0 0 ${width} ${height}`,role:'img','aria-label':`近${state.hours===24?'24小时':'7天'}已记录Token趋势，共${exact(data.totalTokens)} Token`});
    const gradientId=`gradient-${container.id}`;const defs=svgNode('defs');const gradient=svgNode('linearGradient',{id:gradientId,x1:'0',y1:'0',x2:'0',y2:'1'});gradient.append(svgNode('stop',{offset:'0%','stop-color':'#6d86ff','stop-opacity':'.28'}),svgNode('stop',{offset:'100%','stop-color':'#dce4ff','stop-opacity':'.06'}));defs.append(gradient);svg.append(defs);
    for(let i=0;i<4;i++){const y=top+chartHeight*i/3;svg.append(svgNode('line',{x1:left,x2:width-right,y1:y,y2:y,stroke:'#edf0f7','stroke-width':1,'stroke-dasharray':'3 5'}),svgNode('text',{x:left-9,y:y+3,'text-anchor':'end'},compact(max*(1-i/3))));}
    const points=buckets.map((b,i)=>[left+chartWidth*i/Math.max(1,buckets.length-1),top+chartHeight*(1-b.tokens/max)]);const line=points.map(([x,y],i)=>`${i?'L':'M'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
    svg.append(svgNode('path',{d:`${line} L${width-right},${top+chartHeight} L${left},${top+chartHeight} Z`,fill:`url(#${gradientId})`,stroke:'none'}),svgNode('path',{d:line,fill:'none',stroke:'#4d6bfe','stroke-width':2}));
    for(let i=0;i<5;i++){const index=Math.round((buckets.length-1)*i/4);const b=buckets[index];svg.append(svgNode('text',{x:points[index][0],y:height-6,'text-anchor':i===0?'start':i===4?'end':'middle'},state.hours===24?when(b.t):when(b.t,true).split(' ')[0]));}
    const marker=svgNode('circle',{r:4,cx:points[0][0],cy:points[0][1],fill:'#4d6bfe',stroke:'white','stroke-width':2,visibility:'hidden'});svg.append(marker);const tooltip=el('div','chart-tooltip');tooltip.hidden=true;
    svg.addEventListener('mousemove',event=>{const rect=svg.getBoundingClientRect();if(!rect.width)return;const x=(event.clientX-rect.left)/rect.width*width;const index=Math.max(0,Math.min(buckets.length-1,Math.round((x-left)/chartWidth*(buckets.length-1))));const b=buckets[index];marker.setAttribute('cx',points[index][0]);marker.setAttribute('cy',points[index][1]);marker.setAttribute('visibility','visible');tooltip.textContent=`${when(b.t,true)}\n${exact(b.tokens)} Token · ${exact(b.requests)} 次请求`;tooltip.hidden=false;tooltip.style.left=`${Math.min(Math.max(0,event.clientX-rect.left+8),Math.max(0,rect.width-165))}px`;tooltip.style.top='5px';});
    svg.addEventListener('mouseleave',()=>{tooltip.hidden=true;marker.setAttribute('visibility','hidden');});container.replaceChildren(svg,tooltip);
  }
  function renderUsage(){
    const t=state.overview?.tokens;setText('usageTotal',t?.available?compact(t.totalTokens):'—');setText('usageCost',t?.available?money(t.estimatedCost):'—');
    const parts=[['未缓存输入',t?.cacheMissTokens,'每次请求新增的输入'],['缓存命中输入',t?.cacheHitTokens,'重复前缀命中缓存'],['输出 Token',t?.outputTokens,'模型返回的内容'],['已记录请求',t?.requests,'包含实际计费重试']];
    $('usageBreakdown').replaceChildren(...parts.map(([name,value,hint])=>{const card=el('article','card breakdown');card.append(el('span','',name),el('strong','',t?.available?compact(value):'—'),el('small','',hint));return card;}));
    const conversations=t?.available?t.conversations:[];const max=Math.max(...conversations.map(x=>x.tokens||0),1);
    $('usageRows').replaceChildren(...conversations.map(c=>{const row=el('tr');const name=el('td','',label(c.key));const bar=el('div','usage-bar');bar.style.width=`${Math.max(1,(c.tokens||0)/max*100)}%`;name.append(bar);row.append(name,...[exact(c.tokens),exact(c.turns),exact(c.requests),money(c.cost)].map(value=>el('td','',value)));return row;}));
    if(!conversations.length)empty($('usageEmpty'),t?.available?'暂无会话用量':'用量数据不可用','账本尚无记录或暂时不可读。','chart');else $('usageEmpty').replaceChildren();
    setText('chartTotal',state.series?.available?compact(state.series.totalTokens):'—');setText('chartSubtitle',`${state.hours===24?'近24小时':'近7天'} · 已记录请求${state.series?.stale?' · 数据已过期':''}`);
    q('[data-hours]').forEach(button=>{const active=Number(button.dataset.hours)===state.hours;button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active));});
    renderChart($('overviewChart'));renderChart($('usageChart'));
  }
  function renderEvents(parent,events,compactView){
    if(!events.length){empty(parent,'暂时没有活动记录','这里只展示已经发生并被保留的活动。','activity');return;}
    parent.replaceChildren(...events.map(e=>{
      const row=el('article',`event ${e.type}`);const header=el('div','event-head');header.append(el('strong','',e.type==='system'?'系统日志':e.type==='reply'?`大肥鱼回复 · ${label(e.key)}`:`收到消息 · ${label(e.key)}`));
      header.append(el('time','',e.time?(compactView?ago(e.time):when(e.time,true)):(e.clock?`${e.clock} · ${e.timeZone||'原始时钟'}`:'日期未记录')));row.append(header,el('p','',e.text));return row;
    }));
  }
  function renderActivity(previewOnly=false){
    const d=state.overview;if(!d)return;renderEvents($('recentActivity'),d.activity.slice(0,4),true);if(previewOnly&&state.view!=='activity')return;
    const system=state.activity==='system';setText('activityHint',system?'旧日志只保留时分秒，以下展示服务端原始时钟与时区，不推算日期。':'按真实消息时间排序，北京时间显示。');renderEvents($('activityList'),system?d.systemActivity:d.activity,false);
  }
  function renderOperations(){
    const data=state.operations,b=data?.budget;
    if(!b){setText('budgetHeadline','费用与诊断暂不可用');setText('budgetStatus','数据不可用');$('budgetSave').disabled=true;return;}
    const fmt=v=>good(v)?`${b.today.symbol||b.today.currency||''}${v.toFixed(4)}`:'—';
    setText('budgetHeadline',`今日已记录 ${fmt(b.today.cost)}`);
    setText('budgetSummary',`${b.day} · 北京时间 · ${b.policy.dailyLimit!==null?`总预算 ${fmt(b.policy.dailyLimit)}`:'未设置金额上限'}${data.stale?' · 数据已过期':''}`);
    setText('budgetDay',`${b.day} · 已记录 ${b.today.steps??'—'} 次计费请求`);
    setText('budgetCurrency',b.today.currency||'');
    setText('budgetStatus',data.stale?'数据已过期':b.alerts.some(x=>x.level==='error')?'自动聊天受限':b.cooldowns.length?'部分会话冷却中':'保护已就绪');
    $('budgetAlerts').replaceChildren(...b.alerts.map(a=>el('p',`operation-alert ${a.level==='error'?'error':'warning'}`,a.message)));
    setText('budgetCoverage',b.today.note||b.note);
    $('todayConversationCosts').replaceChildren(...b.today.conversations.map(c=>{const row=el('div','today-cost-row');row.append(el('strong','',label(c.key)||'未归属'),el('span','',`${c.steps} 次 · ${fmt(c.cost)}`));return row;}));
    if(!b.today.available)empty($('todayConversationCosts'),'费用暂不可核对','缺失记录不会显示为零。','chart');
    else if(!b.today.conversations.length)empty($('todayConversationCosts'),'今天暂无逐请求记录','历史累计仍可在下方查看。','chart');
    if(!state.budgetDirty&&!state.budgetSaving){
      $('budgetDaily').value=b.policy.dailyLimit??'';$('budgetAnomaly').checked=b.policy.anomalyEnabled;
      const chosen=$('budgetConversation').value;
      const blank=el('option','','选择会话（可选）');blank.value='';
      $('budgetConversation').replaceChildren(blank,...state.overview.conversations.map(c=>{const option=el('option','',c.label);option.value=c.key;return option;}));
      $('budgetConversation').value=state.overview.conversations.some(c=>c.key===chosen)?chosen:'';
      setConversationLimit();
    }
    $('budgetSave').disabled=!!data.stale||!!state.budgetSaving;
    const d=data.diagnostics;setText('diagnosticNote',d.note);
    const names={received:'已收到，尚未触发回复',queued:'正在排队',dispatching:'正在投递模型',model:'模型与工具处理中',replied:'网关已接受回复',observed:'已处理，本轮未发言',error:'处理失败',blocked:'自动聊天被保护策略暂缓',interrupted:'处理被中断'};
    const ms=v=>good(v)?(v<1000?`${Math.round(v)}ms`:`${(v/1000).toFixed(1)}s`):'—';
    $('diagnosticTraces').replaceChildren(...d.traces.slice(0,30).map(t=>{const row=el('article','trace-row');const head=el('div','trace-head');head.append(el('strong','',label(t.key)),el('time','',when(t.receivedAt||t.dispatchedAt||t.endedAt,true)));row.append(head,el('p','trace-status',names[t.status]||'状态未知'));
      row.append(el('small','',`${t.messageId?`消息 ${t.messageId}`:'自动唤醒'}${t.reason?` · ${t.reason}`:''}`));
      const metrics=el('div','trace-metrics');for(const [title,value] of [['排队',t.queueMs],['模型/工具',t.modelMs],['发送',t.sendMs],['总耗时',t.totalMs]]){const cell=el('span');cell.append(el('small','',title),el('b','',ms(value)));metrics.append(cell);}row.append(metrics);if(t.error)row.append(el('p','trace-error',t.error.message));return row;}));
    if(!d.traces.length)empty($('diagnosticTraces'),'暂时没有处理轨迹','新消息到来后，记录实际处理阶段。');
    const scopes={qq:'QQ网关',dsh_rpc:'聊天接口',dsh_events:'聊天事件通道',bridge:'桥接'};
    $('diagnosticIncidents').replaceChildren(...d.incidents.slice(0,20).map(i=>{const row=el('div','incident-row');row.append(el('time','',when(i.time,true)),el('strong','',scopes[i.scope]||'服务'),el('span','',i.message));return row;}));
    if(!d.incidents.length)empty($('diagnosticIncidents'),'暂无已记录异常','这里只展示本次更新后实际捕获的服务事件。');
  }
  function setConversationLimit(){const key=$('budgetConversation').value;$('budgetConversationLimit').disabled=!key;$('budgetConversationLimit').value=state.budgetDrafts?.[key]??state.operations?.budget?.policy?.conversationLimits?.[key]??'';}
  async function loadOperations(){
    const id=state.operationsId=(state.operationsId||0)+1,epoch=state.epoch;
    try{const data=await request('operations');if(id!==state.operationsId||epoch!==state.epoch)return;
      if(!data.budget?.policy||!Array.isArray(data.diagnostics?.traces))throw Error('invalid operations');state.operations=data;renderOperations();
    }catch(error){if(id!==state.operationsId||epoch!==state.epoch)return;if(error.auth)throw error;state.operations=state.operations?{...state.operations,stale:true}:null;renderOperations();}
  }
  async function saveBudget(event){
    event.preventDefault();if(!state.operations?.budget||state.budgetSaving)return;const epoch=state.epoch;state.budgetSaving=true;$('budgetSave').disabled=true;setText('budgetSaveStatus','正在保存…');
    const value=id=>$(id).value.trim()===''?null:Number($(id).value);
    const policy=state.operations.budget.policy,limits={...policy.conversationLimits},key=$('budgetConversation').value;
    for(const [draftKey,draft] of Object.entries(state.budgetDrafts||{})){if(draft==='')delete limits[draftKey];else limits[draftKey]=Number(draft);}
    if(key){const limit=value('budgetConversationLimit');if(limit===null)delete limits[key];else limits[key]=limit;}
    try{await request('budget-policy',{method:'POST',body:JSON.stringify({dailyLimit:value('budgetDaily'),conversationLimits:limits,anomalyEnabled:$('budgetAnomaly').checked})});
      if(epoch!==state.epoch)return;state.budgetDirty=false;state.budgetDrafts={};setText('budgetSaveStatus','策略已保存，立即生效。');state.budgetSaving=false;await loadOperations();
    }catch(error){if(epoch===state.epoch){if(error.auth)lock(error.message);else setText('budgetSaveStatus','未能保存，请检查金额或稍后重试；原策略保持不变。');}}
    finally{if(epoch===state.epoch){state.budgetSaving=false;$('budgetSave').disabled=false;}}
  }
  async function loadUsage(){
    const hours=state.hours;const id=++state.usageId;const epoch=state.epoch;
    try{const data=await request(`usage?hours=${hours}`);if(id!==state.usageId||epoch!==state.epoch)return;state.series=data;state.usageAt=Date.now();renderUsage();}
    catch(error){if(id!==state.usageId||epoch!==state.epoch)return;if(error.auth)throw error;state.series=state.series?.available?{...state.series,stale:true}:{available:false};renderUsage();}
  }
  async function refresh(){
    if(!state.connected||state.refreshing||document.hidden)return;const epoch=state.epoch;state.refreshing=true;$('refresh').disabled=true;
    try{
      const data=await request('overview');if(epoch!==state.epoch)return;if(data.ok!==true||!data.bot||!Array.isArray(data.conversations))throw new Error('Invalid dashboard');state.overview=data;
      if(!state.selectedKey||!data.conversations.some(c=>c.key===state.selectedKey)){state.selectedKey=data.conversations[0]?.key||null;state.detail=null;}
      renderOverview();await loadOperations();if(Date.now()-state.usageAt>=30000)await loadUsage();if(['chats','memories'].includes(state.view))await loadDetail();
    }catch(error){if(epoch!==state.epoch)return;if(error.auth)lock(error.message);else markStale();}
    finally{if(epoch===state.epoch){state.refreshing=false;$('refresh').disabled=false;}}
  }
  async function connect(token,persist){
    state.token=token;const epoch=++state.epoch;$('loginSubmit').disabled=true;setText('loginError','正在连接…');
    try{
      const data=await request('overview');if(epoch!==state.epoch)return;if(!data.bot||!Array.isArray(data.conversations))throw Error('invalid');
      state.overview=data;state.connected=true;storage.set(persist?'consoleToken':'dashboardAccess',token,persist);state.selectedKey=data.conversations[0]?.key||null;
      $('login').hidden=true;$('app').hidden=false;$('accessToken').value='';setText('loginError','');renderOverview();setView(titles[location.hash.slice(1)]?location.hash.slice(1):'overview');await loadOperations();await loadUsage();startPolling();
    }catch(error){if(epoch===state.epoch){if(state.connected)handleError(error);else{state.token='';setText('loginError',error.auth?error.message:'暂时连接不上工作台，请确认网络后重试。');}}}
    finally{if(epoch===state.epoch)$('loginSubmit').disabled=false;}
  }
  $('loginForm').addEventListener('submit',event=>{event.preventDefault();connect($('accessToken').value.trim(),$('remember').checked);});
  $('budgetForm').addEventListener('submit',saveBudget);
  for(const id of ['budgetDaily','budgetConversationLimit','budgetAnomaly'])$(id).addEventListener('input',()=>{state.budgetDirty=true;});
  $('budgetConversationLimit').addEventListener('input',()=>{const key=$('budgetConversation').value;if(key){state.budgetDrafts??={};state.budgetDrafts[key]=$('budgetConversationLimit').value;}});
  $('budgetConversation').addEventListener('change',setConversationLimit);
  $('refresh').addEventListener('click',()=>{state.usageAt=0;refresh();});$('lock').addEventListener('click',()=>lock('工作台已锁定。'));
  q('[data-page]').forEach(button=>button.addEventListener('click',()=>setView(button.dataset.page)));q('[data-go]').forEach(button=>button.addEventListener('click',()=>setView(button.dataset.go)));
  q('[data-hours]').forEach(button=>button.addEventListener('click',()=>{const hours=Number(button.dataset.hours);if(hours===state.hours)return;state.hours=hours;state.series=null;renderUsage();loadUsage().catch(handleError);}));
  $('conversationSearch').addEventListener('input',renderConversations);$('messageSearch').addEventListener('input',renderChat);$('memorySearch').addEventListener('input',renderMemories);
  $('memoryConversation').addEventListener('change',()=>selectConversation($('memoryConversation').value,'memories'));
  q('[data-category]').forEach(button=>button.addEventListener('click',()=>{state.category=button.dataset.category;q('[data-category]').forEach(x=>x.classList.toggle('active',x===button));renderMemories();}));
  q('[data-activity]').forEach(button=>button.addEventListener('click',()=>{state.activity=button.dataset.activity;q('[data-activity]').forEach(x=>x.classList.toggle('active',x===button));renderActivity();}));
  $('legacy').addEventListener('click',()=>{if(['localhost','127.0.0.1','[::1]'].includes(location.hostname)){const target=new URL('../',location.href);target.searchParams.set('token',state.token);location.href=target.href;}else toast('完整配置请在电脑上通过“打开控制台”入口访问；本工作台提供只读信息。');});
  document.addEventListener('visibilitychange',()=>{if(document.hidden)stopPolling();else if(state.connected){refresh();startPolling();}});
  window.addEventListener('hashchange',()=>{const view=location.hash.slice(1);if(titles[view]&&view!==state.view)setView(view);});
  const url=new URL(location.href);const hash=new URLSearchParams(url.hash.slice(1));const supplied=url.searchParams.get('token')||hash.get('token');
  if(supplied){url.searchParams.delete('token');url.hash='overview';history.replaceState(null,'',url.pathname+url.search+url.hash);}
  const remembered=supplied||storage.get('dashboardAccess')||storage.get('consoleToken');if(remembered)connect(remembered,false);
})();
