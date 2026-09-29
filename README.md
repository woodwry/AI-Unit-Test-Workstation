# AI Unit Test Workstation

AI Unit Test Workstation 是一个面向 Java 工程的桌面客户端，用来导入本地 Maven 项目、配置 JDK/Maven 与大模型接口，并通过线上服务生成、修复、验证单元测试。

## 开发者预览

AI Unit Test Workstation 目前处于开发者预览阶段，正在快速迭代。后续版本的功能入口、配置项、接口行为和数据结构都可能继续调整，也可能出现不兼容变更。

运行本项目之前，请先阅读下面的安全说明，并在可控的本地项目副本中试用。

## 安全

### 实验性状态

AI Unit Test Workstation 是实验性的开发者预览软件，尚未经过完整安全审计，不应视为可直接用于生产环境的软件。

本项目会读取本地 Java 工程、写入生成的测试文件、执行 Maven/JaCoCo 命令，并连接线上后端服务和你配置的大模型接口。错误的模型输出、配置错误、项目依赖问题或不可信输入，都可能导致测试执行失败、敏感信息暴露或其他非预期影响。

### 负责任地使用

- 优先在一次性项目副本、独立分支、虚拟机或专用环境中运行。
- 运行前备份重要代码和配置文件。
- 不要把包含密钥、凭据、生产数据或其他敏感信息的项目直接交给本项目处理。
- 接受生成结果前，先检查生成的测试文件。

### 不提供保证，不承担责任

请在充分了解相关风险的前提下使用本项目。本项目不会更改导入项目的原始内容，但不保证生成结果、执行过程或外部服务始终正确可用。因使用本项目造成的信息泄露或其他损失，需要由使用者自行承担风险。

## 快速开始

先安装 Node.js 22 或更高版本，然后运行：

```sh
npx @woodwry/ai-unit-test-workstation
```

这个入口会启动 Electron 客户端，并把客户端后端地址指向线上服务。

## 从源码运行

```sh
git clone https://github.com/woodwry/AI-Unit-Test-Workstation.git
cd AI-Unit-Test-Workstation
npm install
npm run dev:remote
```
## 说明

后端服务部署在线上服务器，客户端负责本地项目选择、配置、进度展示、生成测试文件和 Maven/JaCoCo 验证编排。

客户端本地配置和登录状态保存在：

- Windows：`%APPDATA%\AI Unit Test Workstation`
- macOS：`~/Library/Application Support/AI Unit Test Workstation`
- Linux：`~/.config/AI Unit Test Workstation`

如需清理客户端本地数据，删除对应目录即可。
