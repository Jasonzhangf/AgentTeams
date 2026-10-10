<!-- project-memory:v1 {"category":"lesson","created_at":"2026-10-10T07:34:55.693753+00:00","id":"node-spawnsync-pipe-truncation-20261009","importance":0,"memory_level":2,"review_evidence":["commit ac0766f; review round 1 FAIL two P2 cleanup findings then targeted re-check PASS; measured byte counts 66061/65536/1200000/1200525 recorded in note.md round-29/30 section"],"review_status":"reviewed","source_refs":[],"tags":["agentteams","ai-reviewed","debugging","evidence","human-unreviewed","node"],"updated_at":"2026-10-10T07:34:56.099726+00:00"} -->

# Node spawnSync 管道在子进程异常退出时截断捕获输出

用 spawnSync 的默认管道捕获子进程输出时，若子进程先写入超过管道容量（约 64 KiB）再异常退出，父进程只拿到约 65504 字节，其余静默丢失；子进程自然退出时则完整。实测：write(1200000)+throw 得到 66061 字节，write(1200000)+exit(1) 得到 65536 字节，自然退出得到完整 1200000 字节，改用文件 fd 得到 1200525 字节。后果是本项目的 BB13 失败证据 failure.json 只有 65504 字节，776 个用例里失败的套件名不可恢复，连续两轮无法归因。修法是把捕获改成临时文件：mkdtempSync + openSync(path, w) + spawnSync(stdio: [ignore, outFd, errFd])，读取后按原顺序拼接，并让 fd 获取、spawn、读取、日志写入与失败路径同处一个 try，finally 关闭已获取的 fd 并删除捕获目录。修复见 scripts/blackbox-user-mvp.mjs 与 scripts/lifecycle-adapter.mjs 的 run()，提交 ac0766f。
<!-- project-memory:end -->
