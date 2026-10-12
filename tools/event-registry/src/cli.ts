#!/usr/bin/env node
import { TOOL_ID } from './index.js';

// 骨架（T08）：子命令 check / generate / export-rules / report-unregistered 由 T22 实现
process.stderr.write(`${TOOL_ID}: 尚未实现，见 docs/tasks/T22.md\n`);
process.exitCode = 1;
