import { writeFileSync } from 'node:fs';

writeFileSync('samples/erase.log', 'working...\r\x1b[Kdone\n');
writeFileSync('samples/colors.log', '\x1b[31m红色\x1b[0m 普通 \x1b[1;32m绿色\x1b[0m\r\n');
console.log('samples/erase.log 与 samples/colors.log 已生成');
