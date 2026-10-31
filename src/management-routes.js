// 白名单与模型设置管理。调用方须先完成 Host、密码、智能体与 CSRF 检查。
// readConfig/writeConfig 和变更回调必须同步：落盘成功后才更新运行配置及协调会话。
// QQ 助手依赖思考，仍只开放现有三个档位；不在本次整理中引入 off。
const REASONING_EFFORT_OPTIONS = ['low', 'high', 'max'];
export const REASONING_EFFORT_DEFAULT = 'max';
export function normalizeReasoningEffort(value) {
  const v = String(value ?? '').trim().toLowerCase();
  if (!REASONING_EFFORT_OPTIONS.includes(v)) {
    throw new Error(`思考强度只能是 ${REASONING_EFFORT_OPTIONS.join(' / ')}`);
  }
  return v;
}

// 空值清除管理员；其余必须是安全正整数 QQ 号。启动读取与控制台写入共用。
export function normalizeOwnerQQ(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (!/^\d+$/.test(s)) throw new Error('ownerQQ 必须是 QQ 号（正整数）');
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error('ownerQQ 必须是 QQ 号（正整数）');
  return n;
}

export function createManagementRoutes({config:cfg,readConfig,writeConfig,onAccessChanged,onModelChanged,getModelCatalog,log}) {
  // 每个处理器实例独享在途查询与错误去重，不把请求状态泄漏到其他实例。
  let modelCatalogInFlight = null;
  const modelCatalogErrorLogged = new Set();
  return async function handle(req,url,sendJson,readBody) {
    const supported = req.method === 'GET' && ['/api/whitelist','/api/dsh/model'].includes(url.pathname)
      || req.method === 'POST' && ['/api/whitelist','/api/dsh/effort'].includes(url.pathname);
    if (!supported) return false;
    // 管理路由的第二道隔离：即使调用方以后调整分发顺序，也不能先读配置或调用模型。
    if (req.headers['x-agent-token'] !== undefined || req.headers['x-agent-call'] !== undefined) {
      sendJson({ok:false,error:'该接口仅控制台可用'},403);
      return true;
    }
    // ── 白名单可视化编辑（写 config.json + 热更新内存） ───────────────────
    if (req.method === 'GET' && url.pathname === '/api/whitelist') {
      sendJson({ allow: cfg.allow ?? { private: [], groups: [] }, deny: cfg.deny ?? { private: [], groups: [] }, ownerQQ: cfg.ownerQQ ?? null });
      return true;
    }
    if (req.method === 'POST' && url.pathname === '/api/whitelist') {
      const body = await readBody();
      const toNum = (arr) => Array.isArray(arr) ? [...new Set(arr.map((x) => Number(String(x).trim())).filter((n) => Number.isFinite(n)))] : undefined;
      // fail-fast：配置文件损坏时直接 500，绝不回写，避免把整个配置清成只剩 allow/deny/ownerQQ
      const file = readConfig();
      const allow = {
        private: toNum(body.allow?.private) ?? (file.allow?.private ?? []),
        groups: toNum(body.allow?.groups) ?? (file.allow?.groups ?? [])
      };
      const deny = {
        private: toNum(body.deny?.private) ?? (file.deny?.private ?? []),
        groups: toNum(body.deny?.groups) ?? (file.deny?.groups ?? [])
      };
      // 管理员 QQ 可在控制台输入；空值=清除管理员（fail-closed），非法值拒绝写入。
      let ownerQQ = cfg.ownerQQ ?? null;
      if (body.ownerQQ !== undefined) {
        try {
          ownerQQ = normalizeOwnerQQ(body.ownerQQ);
        } catch (error) {
          sendJson({ ok: false, error: error?.message ?? 'ownerQQ 无效' }, 400);
          return true;
        }
      }
      file.allow = allow;
      file.deny = deny;
      file.ownerQQ = ownerQQ;
      writeConfig(file);
      cfg.allow = { private: allow.private, groups: allow.groups };
      cfg.deny = { private: deny.private, groups: deny.groups };
      cfg.ownerQQ = ownerQQ;
      onAccessChanged();
      log(`控制台：白名单已更新（群: ${allow.groups.join(',') || '无'}，私聊: ${allow.private.join(',') || '无'}，管理员: ${ownerQQ ?? '未设置'}）`);
      sendJson({ ok: true, allow, deny, ownerQQ });
      return true;
    }

    // ── DSH 模型与思考强度 ───────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/api/dsh/model') {
      const provider = String(cfg.dsh?.provider || 'deepseek-official');
      const model = String(cfg.dsh?.model || 'deepseek-flash');
      // 档位优先取 DSH 实际公布的能力（DSH 换档位词汇或换 provider 时自动跟随），失败退回内置白名单。
      let options = REASONING_EFFORT_OPTIONS.slice();
      let labels = {};
      let providerDefault = null;
      let catalogSource = 'fallback';
      try {
        if (!modelCatalogInFlight) {
          modelCatalogInFlight = getModelCatalog()
            .finally(() => { modelCatalogInFlight = null; });
        }
        const catalog = await modelCatalogInFlight;
        const group = (catalog?.groups ?? []).find((g) => g?.id === provider);
        const entry = (group?.models ?? []).find((m) => m?.id === model);
        const efforts = entry?.reasoning?.efforts ?? [];
        const advertised = efforts.map((e) => String(e?.id ?? '')).filter((id) => REASONING_EFFORT_OPTIONS.includes(id));
        if (advertised.length) {
          options = advertised;
          labels = Object.fromEntries(efforts.map((e) => [String(e.id), { name: e.name ?? '', description: e.description ?? '' }]));
          providerDefault = entry.reasoning.defaultEffort ?? null;
          catalogSource = 'dsh';
        }
      } catch (error) {
        // 同一条失败原因只记一次：控制台每次刷新都会打这条接口，否则日志会被刷爆。
        const reason = String(error?.message ?? error);
        if (!modelCatalogErrorLogged.has(reason)) {
          modelCatalogErrorLogged.add(reason);
          log(`读取 DSH 模型能力失败，思考强度暂用内置清单：${reason}`);
        }
      }
      sendJson({
        provider,
        model,
        reasoningEffort: String(cfg.dsh?.reasoningEffort || REASONING_EFFORT_DEFAULT),
        options,
        labels,
        default: REASONING_EFFORT_DEFAULT,
        providerDefault,
        catalogSource,
        // selectModel 会同时写会话级与 DSH 全局默认（~/.dsh/settings.yaml 的 agent-default-model），
        // 控制台要把这点明确告诉管理员，避免「只想调 QQ 助手却改了 Web GUI 新会话默认」的意外。
        globalSideEffect: true,
      });
      return true;
    }
    if (req.method === 'POST' && url.pathname === '/api/dsh/effort') {
      const body = await readBody();
      let effort;
      try { effort = normalizeReasoningEffort(body.reasoningEffort); }
      catch (error) { sendJson({ ok: false, error: error?.message ?? '思考强度无效' }, 400); return true; }
      // fail-fast：配置损坏时直接 500，绝不回写（与白名单接口同语义）
      const file = readConfig();
      file.dsh = { ...(file.dsh ?? {}), reasoningEffort: effort };
      writeConfig(file);
      cfg.dsh = { ...(cfg.dsh ?? {}), reasoningEffort: effort };
      // 递增代号：已在运行的会话在下一条消息会重新 selectModel（无需重启桥接或 DSH）
      onModelChanged();
      log(`控制台：DSH 思考强度已设为 ${effort}（对已有会话于下一条消息生效）`);
      sendJson({ ok: true, reasoningEffort: effort });
      return true;
    }

    return false;
  };
}
