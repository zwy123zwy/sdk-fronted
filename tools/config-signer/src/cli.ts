#!/usr/bin/env node
import { TOOL_ID } from './index.js';

// 骨架（T08）：子命令 validate / sign / verify / keygen 由 T25 实现
process.stderr.write(`${TOOL_ID}: 尚未实现，见 docs/tasks/T25.md\n`);
process.exitCode = 1;
