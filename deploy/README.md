# 远程部署

本目录固化当前生产环境的发布流程，避免靠人工记忆登录、目录和重启命令。

## 当前环境

| 项目 | 值 |
| --- | --- |
| SSH | `ops@myblog` |
| 应用目录 | `/opt/mx-pop-pricing` |
| systemd 服务 | `mx-pop-pricing.service` |
| API 端口 | `8010` |
| SQLite 数据库 | `/var/lib/mx-pop-pricing/echotik.db` |
| 插件下载目录 | `/opt/mx-pop-pricing/app/static/plugins` |

数据库不在代码目录中；发布脚本不会同步、删除或覆盖它。上传图片如使用默认配置会保存在应用目录的 `data/collected_images`，脚本同样不会删除该目录。

## 首次部署

在项目根目录执行：

```bash
./deploy/bootstrap.sh
```

脚本会创建远程目录、同步服务端及构建后的插件 ZIP、安装/启用 systemd 服务并验证健康检查。

## 日常更新

```bash
./deploy/update.sh
```

更新前会运行服务端测试和插件类型检查，随后构建插件、同步服务端代码和插件包、重启服务，并检查：

- `GET /healthz`
- `GET /v1/plugin-update`
- 插件 ZIP 下载地址

如果仅需要快速发布（跳过本地测试），使用 `./deploy/update.sh --skip-tests`。

## 可配置项

以下环境变量可覆盖默认值，便于迁移到另一台机器或目录：

```bash
DEPLOY_HOST=ops@myblog REMOTE_DIR=/opt/mx-pop-pricing SERVICE_NAME=mx-pop-pricing ./deploy/update.sh
```

## 回滚

发布前请保留可工作的 Git 提交。回滚方式是切换本地工作区到目标提交后再次运行 `./deploy/update.sh`。数据库不会随代码回滚；若涉及数据库 schema 变更，应先单独备份 `/var/lib/mx-pop-pricing/echotik.db`。
