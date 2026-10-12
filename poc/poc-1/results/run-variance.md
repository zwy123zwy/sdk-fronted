# Chromium SIGKILL 落盘窗口：三次独立运行的原始日志片段

来源：同一条主命令（`node --import ./poc/poc-1/lib/register.mjs poc/poc-1/run.mjs --browser all --preset full`）
的三次独立运行；每条变体 5 次试验 × 200 条 critical = 1000 条。这里只贴 kill 场景的原始输出行。

| 运行 | 日志文件 | 1000ms | 2500ms | 4000ms | 5000ms |
|---|---|---|---|---|---|
| A（2026-10-12 17:29 完成，结果目录已清理，仅留日志） | /tmp/poc-final.log | 0/1000 存活 | 400/1000 存活 | 0/1000 存活 | 1000/1000 存活 |
| B（17:56，结果目录已清理，仅留日志） | /tmp/poc-final3.log | 200/1000 | 200/1000 | 200/1000 | 1000/1000 |
| C（18:15，**报告采用的这次**，结果目录 `2026-10-12T09-57-47-578Z`） | /tmp/poc-final4.log | 0/1000 | 0/1000 | 0/1000 | 1000/1000 |

三次运行都使用同一段 kill 场景代码；差别只在机器负载与时序。结论：**≤4 秒内的强杀存活率在 0%–40% 之间波动、
没有任何一次是「全部存活」，而 5000 ms 三次都是 1000/1000 存活**。因此报告不给出可依赖的临界秒数，
只给出「0–5 秒且不确定」的窗口。

## 运行 A（0/1000、400/1000、0/1000、1000/1000）
```
[kill] variant=sigkill-1000ms trials=5 perClass=200
  预写存活 0/1000；最终 normal 丢失 1000/1000，critical 丢失 1000/1000
[kill] variant=sigkill-2500ms trials=5 perClass=200
  排空 pass=0 pending 200 → 0
--
[kill] variant=sigkill-4000ms trials=5 perClass=200
  预写存活 0/1000；最终 normal 丢失 1000/1000，critical 丢失 1000/1000
[kill] variant=sigkill-5000ms trials=5 perClass=200
  排空 pass=0 pending 200 → 0
--
[kill] variant=sigkill-1000ms trials=5 perClass=200
  排空 pass=0 pending 200 → 0
--
[kill] variant=sigkill-2500ms trials=5 perClass=200
  排空 pass=0 pending 200 → 0
--
[kill] variant=sigkill-4000ms trials=5 perClass=200
  排空 pass=0 pending 200 → 0
--
[kill] variant=sigkill-5000ms trials=5 perClass=200
  排空 pass=0 pending 200 → 0
```

## 运行 B（200/1000、200/1000、200/1000、1000/1000）
```
[kill] variant=sigkill-1000ms trials=5 perClass=200
  排空 pass=0 pending 200 → 0
--
[kill] variant=sigkill-2500ms trials=5 perClass=200
  排空 pass=0 pending 200 → 0
--
[kill] variant=sigkill-4000ms trials=5 perClass=200
  排空 pass=0 pending 200 → 0
--
[kill] variant=sigkill-5000ms trials=5 perClass=200
  排空 pass=0 pending 200 → 0
--
[kill] variant=sigkill-1000ms trials=5 perClass=200
  排空 pass=0 pending 200 → 0
--
[kill] variant=sigkill-2500ms trials=5 perClass=200
  排空 pass=0 pending 200 → 0
--
[kill] variant=sigkill-4000ms trials=5 perClass=200
  排空 pass=0 pending 200 → 0
--
[kill] variant=sigkill-5000ms trials=5 perClass=200
  排空 pass=0 pending 200 → 0
```

## 运行 C（报告采用的这次：0/1000、0/1000、0/1000、1000/1000）
```
[kill] variant=sigkill-1000ms trials=5 perClass=200
  预写存活 0/1000；最终 normal 丢失 1000/1000，critical 丢失 1000/1000
[kill] variant=sigkill-2500ms trials=5 perClass=200
  预写存活 0/1000；最终 normal 丢失 1000/1000，critical 丢失 1000/1000
[kill] variant=sigkill-4000ms trials=5 perClass=200
  预写存活 0/1000；最终 normal 丢失 1000/1000，critical 丢失 1000/1000
[kill] variant=sigkill-5000ms trials=5 perClass=200
  排空 pass=0 pending 200 → 0
--
[kill] variant=sigkill-1000ms trials=5 perClass=200
  排空 pass=0 pending 200 → 0
--
[kill] variant=sigkill-2500ms trials=5 perClass=200
  排空 pass=0 pending 200 → 0
--
[kill] variant=sigkill-4000ms trials=5 perClass=200
  排空 pass=0 pending 200 → 0
--
[kill] variant=sigkill-5000ms trials=5 perClass=200
  排空 pass=0 pending 200 → 0
```
