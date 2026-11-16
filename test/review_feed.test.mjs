// file: test/review_feed.test.mjs
// 盯的是「票面」这一段：文件名解析、同批合并视图去重、同人只算最新一票、缺票名单。
// 为什么值得单独测：done 闸门现在要凭它决定「能不能收工」，
// 这里错一次就是「没证据也过」——正是我们刚修掉的那类问题在票面上的翻版。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseReviewName, voteFromText, discoverVotes, VOTE,
} from '../lib/review-feed.mjs';
import { judgeVotes } from '../vm/votes.mjs';

let pass = 0;
let fail = 0;
const ok = (cond, msg) => { if (cond) pass += 1; else { fail += 1; console.log('  \u2717 ' + msg); } };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), msg + ' \u5b9e\u5f97 ' + JSON.stringify(a));

// 1. 文件名解析：subject 自己带点、带扩展名，只能剥两端
eq(parseReviewName('codebuddy-review-bad_subject.js-20261115-141604.md'),
  { reviewer: 'codebuddy', subject: 'bad_subject.js', tsMs: new Date(2026, 10, 15, 14, 16, 4).getTime(), multi: false },
  '\u5e26\u65f6\u95f4\u6233\u7684\u5e38\u89c4\u540d');
eq(parseReviewName('trae-review-trae.mjs.md'),
  { reviewer: 'trae', subject: 'trae.mjs', tsMs: null, multi: false },
  '\u65e0\u65f6\u95f4\u6233\u7684\u65e7\u6837\u672c');
ok(parseReviewName('multi-review-bad_subject.js-20261116-001557.md').multi === true, 'multi \u6807\u8bb0');
ok(parseReviewName('random.md') === null, '\u89e3\u6790\u4e0d\u51fa\u5c31\u7ed9 null\uff0c\u4e0d\u778e\u8ba1\u7968');

// 2. 正文裁决：只认显式标记
eq(voteFromText('...\nVERDICT: REVISE\n'), VOTE.revise, 'VERDICT: REVISE');
eq(voteFromText('- \u88c1\u51b3\uff1a\u901a\u8fc7'), VOTE.accept, '\u88c1\u51b3\uff1a\u901a\u8fc7');
eq(voteFromText('\u6ca1\u6709\u4efb\u4f55\u88c1\u51b3\u5b57\u6837'), VOTE.none, '\u8ba4\u4e0d\u51fa\u5c31\u662f unreviewed');

// 3. 目录级：合并视图去重 + 同人取最新 + 缺票名单
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'revfeed-'));
const w = (name, body) => fs.writeFileSync(path.join(dir, name), body, 'utf8');
w('codebuddy-review-a.js-20261116-001557.md', 'VERDICT: ACCEPT');
w('trae-review-a.js-20261116-001557.md', 'VERDICT: REVISE');
w('multi-review-a.js-20261116-001557.md', 'VERDICT: ACCEPT');          // 同批合并视图，应被丢弃
w('codebuddy-review-a.js-20261116-010000.md', 'VERDICT: REVISE');      // 同人更新，应覆盖 00:15 那票
w('doubao-review-b.js-20261116-001557.md', 'VERDICT: ACCEPT');         // 另一 subject，被 subjects 过滤掉
const feed = discoverVotes({ dir, subjects: ['a.js'], expectedReviewers: ['codebuddy', 'trae', 'doubao'] });
eq(feed.votes.length, 2, 'a.js \u53ea\u5e94\u6709 2 \u5f20\u7968\uff08multi \u4e0d\u53e6\u8ba1\uff09');
eq(feed.votes.map((v) => v.reviewer).sort(), ['codebuddy', 'trae'], '\u4e24\u4e2a\u6765\u6e90');
eq(feed.votes.find((v) => v.reviewer === 'codebuddy').vote, VOTE.revise, '\u540c\u4eba\u53d6\u6700\u65b0\u4e00\u7968');
eq(feed.missing, ['doubao'], '\u7f3a\u7968\u540d\u5355');
eq(feed.counts, { ACCEPT: 0, REVISE: 2, unreviewed: 0 }, '\u7968\u578b\u8ba1\u6570');

// 4. 与 judgeVotes 对接：一致才给 ACCEPT，分歧落 unreviewed
eq(judgeVotes({ votes: ['ACCEPT', 'ACCEPT'], expected: 2 }).state, 'ACCEPT', '\u4e24\u7968\u4e00\u81f4');
eq(judgeVotes({ votes: ['ACCEPT', 'REVISE'], expected: 2 }).state, 'unreviewed', '\u5206\u6b67\u843d unreviewed');
ok(judgeVotes({ votes: [], expected: 2 }).value <= 0, '\u65e0\u7968\u4e0d\u7ed9\u901a\u8fc7');

fs.rmSync(dir, { recursive: true, force: true });
console.log((fail === 0 ? '\u2713 ' : '\u2717 ') + 'review_feed: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
