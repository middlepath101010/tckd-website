// TC EXPRESS · Cloudflare Worker
// 纯静态站点：所有请求直接交给 ASSETS 绑定处理，无后端接口。
// 站点已从「静态页 + 运单查询接口」改为纯展示型静态站。

export default {
  async fetch(request, env) {
    return env.ASSETS.fetch(request);
  },
};
