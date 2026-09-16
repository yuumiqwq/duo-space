# duo-space

双人在线自习网站，仓库为 [yuumiqwq/duo-space](https://github.com/yuumiqwq/duo-space)。功能交接从[当前功能说明](docs/current-functionality.md)开始阅读，全部资料入口见[文档导航](docs/README.md)。

## 开发与维护

项目要求 Node.js >=22.13.0，当前使用 Next.js。安装依赖后运行本地开发服务：

```sh
npm install
npm run dev
```

`npm run build` 生成生产构建，`npm test` 先构建再执行测试；音频集成检查需要 FFmpeg 与 FFprobe。部署沿用 GitHub Actions 构建镜像后发布到现有服务器的方式，数据目录和回滚操作见[部署说明](deploy/README.md)。

功能规则变化时更新同一份功能说明，并在[功能变更日志](docs/functionality-changelog.md)中追加记录，简短更新描述继续保留在 Git 提交中。当前待办以[剩余需求执行表](docs/remaining-priority-requirements.md)为准，历史方案与早期测试记录通过[归档目录](docs/archive/README.md)查阅。

## 美术与素材

修改遵循 [AGENTS.md](AGENTS.md) 和[教室现行美术参照](docs/classroom-art-reference.md)，以最新已确认的成品页面与正式素材为依据。新增或重绘素材须先展示具体版本并取得同意，待确认素材放在 `codex-generated`，批准后才能接入可部署路径。

生成源图及提示词见[素材记录](docs/classroom-asset-prompts-2026-09-09.md)，字体和纹理的来源见[素材署名](public/classroom/ATTRIBUTION.md)。许可文件随对应素材保留，归档中的候选图不代表正式设计。

仓库保留的可选 Vinext、D1 与 ChatGPT 登录辅助代码源自初始模板，相关旧说明已移至[模板归档](docs/archive/starter-template.md)。它们不作为当前网站的认证或部署配置说明。
