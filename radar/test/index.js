// Node 26 的 `node --test <dir>` 会把目录当模块加载（不再递归发现测试文件）。
// 这个 shim 让规定命令 `node --test tools/github-radar/test/` 能跑真实的测试文件。
// 也可以直接跑：node --test tools/github-radar/test/radar.test.mjs
require('./radar.test.mjs');
