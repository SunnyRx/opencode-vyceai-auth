// Vyce AI provider plugin for magpie / OpenCode.
//
// Sign-in asks for the account's API key (inference + model list) and, optionally,
// the console session cookie (balance + daily reward). Without the cookie the
// provider still works for chat; only the usage card and check-in are unavailable.

const PROVIDER = "vyceai";
const SITE = "https://vyceai.com";
const BASE = `${SITE}/v1`;

const DEFAULT_MODELS = {
  "glm-5.3-flash": {
    name: "GLM 5.3 Flash",
    limit: { context: 1000000, output: 64000 },
    tool_call: true,
  },
  "nemotron-3.5-super-vl": {
    name: "Nemotron 3.5 Super VL",
    limit: { context: 1048576, output: 32000 },
    tool_call: true,
  },
};

function clean(value) {
  const v = String(value ?? "").trim().replace(/^bearer\s+/i, "");
  return v === "-" ? "" : v;
}

function credentialOf(auth) {
  const md = auth?.metadata ?? {};
  const key = clean(auth?.key);
  let cookie = clean(md.cookie ?? md.session_cookie ?? md.sessionCookie);
  if (!cookie) return { key, cookie: "" };
  // Accept a whole Cookie header ("a=1; b=2") or a bare value.
  if (!cookie.includes("=")) cookie = `vyceai_session=${cookie}`;
  return { key, cookie };
}

async function readJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function cookieHeaders(cred) {
  return cred.cookie ? { cookie: cred.cookie } : {};
}

export const VyceAIAuthPlugin = async () => ({
  config: async (cfg) => {
    cfg.provider ??= {};
    cfg.provider[PROVIDER] ??= {
      name: "Vyce AI",
      npm: "@ai-sdk/openai-compatible",
      api: BASE,
      models: DEFAULT_MODELS,
    };
  },

  auth: {
    provider: PROVIDER,
    methods: [
      {
        type: "api",
        label: "Vyce AI API key（可选填控制台 Cookie 以显示余额与签到）",
        placeholder: "sk-…",
        prompts: [
          {
            type: "password",
            key: "cookie",
            message:
              "控制台 Cookie（可选：用于查余额和领每日奖励；没有就填 -。浏览器开发者工具 › Application › Cookies 里复制 vyceai.com 的整条 Cookie）",
            placeholder: "粘贴整条 Cookie，或直接回车跳过",
          },
        ],
      },
    ],

    async loader(getAuth) {
      const auth = await getAuth();
      if (auth?.type !== "api") return {};
      const cred = credentialOf(auth);
      if (!cred.key) return {};
      return {
        baseURL: BASE,
        async fetch(input, init) {
          const headers = new Headers(init?.headers);
          headers.set("authorization", `Bearer ${cred.key}`);
          return fetch(input, { ...init, headers });
        },
      };
    },

    // Balance and the check-in streak. Needs the console cookie.
    async usage(getAuth) {
      const auth = await getAuth();
      const cred = credentialOf(auth);
      if (!cred.key) return { error: "没有可用的 API 密钥", windows: [] };
      if (!cred.cookie) {
        return {
          windows: [{ name: "余额", display: "未填控制台 Cookie，无法查询" }],
        };
      }

      const [balRes, dayRes] = await Promise.all([
        fetch(`${SITE}/user/balance`, { headers: cookieHeaders(cred) }).catch(() => null),
        fetch(`${SITE}/user/daily-reward`, { headers: cookieHeaders(cred) }).catch(() => null),
      ]);

      if (!balRes || balRes.status === 401 || balRes.status === 403) {
        return {
          error: "控制台 Cookie 已失效：重新登录 vyceai 后，在 magpie 里更新 Cookie。",
          windows: [],
          signIn: "kept",
        };
      }
      if (!balRes.ok) {
        return { error: `Vyce 余额接口返回 ${balRes.status}`, windows: [], signIn: "kept" };
      }

      const bal = (await readJson(balRes)) || {};
      const windows = [];
      if (typeof bal.totalBalance === "number") {
        windows.push({ name: "余额", balance: bal.totalBalance, unit: "USD" });
      }

      if (dayRes && dayRes.ok) {
        const day = (await readJson(dayRes)) || {};
        const streak = typeof day.streak === "number" ? day.streak : 0;
        const today = day.canClaim === false ? "已领" : "可领";
        const reward =
          typeof day.rewardAmount === "number" ? `（$${day.rewardAmount}）` : "";
        windows.push({ name: "连续签到", display: `${streak} 天 · 今日${today}${reward}` });
      }

      return {
        plan: typeof bal.tier === "string" ? bal.tier : undefined,
        balance:
          typeof bal.totalBalance === "number" ? `$${bal.totalBalance.toFixed(2)}` : undefined,
        windows,
      };
    },

    // Daily reward. Reads the state first so a second press is a no-op.
    async checkin(getAuth) {
      const auth = await getAuth();
      const cred = credentialOf(auth);
      if (!cred.cookie) {
        return {
          outcome: "ineligible",
          message: "未填写控制台 Cookie，无法签到。在 magpie 里重新登录并填入 Cookie 即可。",
        };
      }

      const stateRes = await fetch(`${SITE}/user/daily-reward`, {
        headers: cookieHeaders(cred),
      }).catch(() => null);
      if (stateRes && (stateRes.status === 401 || stateRes.status === 403)) {
        return {
          outcome: "failed",
          message: "控制台 Cookie 已失效，请重新登录 vyceai 并更新 Cookie。",
        };
      }
      if (stateRes && stateRes.ok) {
        const state = (await readJson(stateRes)) || {};
        if (state.canClaim === false) {
          return {
            outcome: "done",
            streak: typeof state.streak === "number" ? state.streak : undefined,
            message: "今天已领过",
          };
        }
      }

      const claimRes = await fetch(`${SITE}/user/daily-reward/claim`, {
        method: "POST",
        headers: { ...cookieHeaders(cred), "content-type": "application/json" },
        body: "{}",
      }).catch(() => null);

      if (!claimRes) return { outcome: "failed", message: "签到请求失败（网络错误）" };

      const claim = (await readJson(claimRes)) || {};
      const msg = claim?.error?.message || "";

      if (claimRes.ok && claim.success) {
        return {
          outcome: "claimed",
          credit: typeof claim.amount === "number" ? claim.amount : undefined,
          streak: typeof claim.streak === "number" ? claim.streak : undefined,
          message:
            typeof claim.newBalance === "number" ? `余额 $${claim.newBalance}` : undefined,
        };
      }
      if (/already claimed/i.test(msg)) return { outcome: "done", message: "今天已领过" };
      if (claimRes.status === 401 || claimRes.status === 403) {
        return { outcome: "failed", message: "控制台 Cookie 已失效，请重新登录 vyceai。" };
      }
      return { outcome: "failed", message: msg || `Vyce 返回 ${claimRes.status}` };
    },
  },

  // The models this key may actually call.
  provider: {
    id: PROVIDER,
    async models(_provider, ctx) {
      const auth = ctx?.auth;
      const cred = credentialOf(auth);
      if (!cred.key) return [];
      const res = await fetch(`${BASE}/models`, {
        headers: { authorization: `Bearer ${cred.key}` },
      }).catch(() => null);
      if (!res || !res.ok) return [];
      const body = (await readJson(res)) || {};
      const list = Array.isArray(body.data) ? body.data : [];
      // magpie keeps models as a record keyed by model id, not as an array.
      return Object.fromEntries(
        list
          .filter((m) => m && typeof m.id === "string")
          .map((m) => [
            m.id,
            {
              id: m.id,
              name: m.id,
              tool_call: true,
              limit: {
                context: typeof m.context_window === "number" ? m.context_window : 128000,
              },
            },
          ]),
      );
    },
  },
});
