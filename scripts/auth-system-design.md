# 用户权限管理系统 — 设计方案

> 创建时间：2026-05-07
> 状态：已审核待实施

## 一、现状

服务器 4 个子系统，分属 3 个后端服务：

| 系统 | 路径 | 端口 | 当前认证 |
|------|------|------|---------|
| 🤖 AI合约自动交易 | `/contract/` | 3000 | 双密码 (admin/readonly) |
| 💱 AI现货自动交易(BSC) | `/cex/` | 3000 | 同上 |
| 🌐 全链自动交易(Web3/BAW) | `/web3/` | 3001 | 双密码 (admin/readonly) |
| 🔄 全自动做市(MMS) | `/mms/` | 3002 | **无认证** |

当前是硬编码双密码模式，无法细粒度控制权限。

## 二、权限模型

### 三个角色层级

**角色 1：超级管理员 `super_admin`**
- 内置 1 个账户，不可删除
- 所有系统完全访问（读写 + 参数设置）
- 可以创建/编辑/禁用/删除普通用户
- 可以查看操作日志追溯

**角色 2：高级用户 `advanced`**
- 由超级管理员创建，可创建多个
- 每个系统可独立设置：`read_write` / `read_only` / `none`
- 示例：A用户可操作合约（读写）+ Web3（仅读）

**角色 3：只读用户 `readonly`**
- 由超级管理员创建，可创建多个
- 每个系统：`read_only` / `none`
- 不能执行任何写操作（开仓/平仓/改参数/启停策略）

## 三、数据模型 (users.json)

```json
{
  "version": 1,
  "users": [
    {
      "id": "super_admin",
      "username": "admin",
      "passwordHash": "bcrypt_hash...",
      "role": "super_admin",
      "createdAt": "2026-05-07T00:00:00Z",
      "lastLogin": null,
      "permissions": {
        "contract": { "access": "read_write" },
        "spot":     { "access": "read_write" },
        "web3":     { "access": "read_write" },
        "mms":      { "access": "read_write" }
      }
    },
    {
      "id": "u_xxxx1",
      "username": "partner_a",
      "passwordHash": "bcrypt_hash...",
      "role": "advanced",
      "createdBy": "super_admin",
      "createdAt": "2026-05-07T00:00:00Z",
      "lastLogin": null,
      "permissions": {
        "contract": { "access": "read_write" },
        "spot":     { "access": "read_only" },
        "web3":     { "access": "none" },
        "mms":      { "access": "none" }
      }
    },
    {
      "id": "u_xxxx2",
      "username": "viewer_b",
      "passwordHash": "bcrypt_hash...",
      "role": "readonly",
      "createdBy": "super_admin",
      "createdAt": "2026-05-07T00:00:00Z",
      "lastLogin": null,
      "permissions": {
        "contract": { "access": "read_only" },
        "spot":     { "access": "none" },
        "web3":     { "access": "read_only" },
        "mms":      { "access": "none" }
      }
    }
  ]
}
```

## 四、认证架构

方案 A（推荐）— 统一认证网关：
- 新起 auth 服务（Port 3003），不直接暴露到 Nginx
- 所有后端服务在 Nginx 层之后先通过 auth 中间件检查 JWT
- 每个后端服务植入轻量 auth 验证中间件，从 JWT 读取权限

## 五、权限校验点

| 系统 | 只读限制的操作 |
|------|---------------|
| 合约 | 开仓、平仓、改杠杆、启停策略、切换风格、重置熔断、修改参数 |
| 现货 | 买入、卖出、批量操作、启停扫描、修改策略参数 |
| Web3 | 兑换/Swap、跨链、转账、修改钱包设置 |
| MMS | 启动/停止做市、修改策略、调参 |

**前端层面：** 登录后菜单根据权限动态渲染，只显示有权限的系统卡片

## 六、管理界面

超级管理员登录后，菜单出现 **「⚙️ 用户管理」** 入口：
1. 用户列表 — 搜索/筛选/排序
2. 创建用户 — 用户名 + 密码 + 角色 + 逐系统权限勾选
3. 编辑用户 — 修改权限、重置密码、启用/禁用
4. 删除用户
5. 操作日志 — 谁在什么时间做了什么操作

## 七、实施路径

| 阶段 | 内容 | 类型 |
|------|------|------|
| P1 | users.json 数据层 + bcrypt密码 + JWT签发/验证核心库 | 核心 |
| P2 | auth 服务统一登录端点，3 个后端植入 auth 中间件 | 核心 |
| P3 | 管理页面（用户CRUD + 权限勾选界面） | 界面 |
| P4 | 菜单页动态渲染、各系统前端操作级拦截 | 界面 |
| P5 | 操作审计日志 | 增强 |
