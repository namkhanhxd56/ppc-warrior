import { runAsUser } from './src/db/user-context.js';
const { runBatch } = await import('./src/jobs/run-batch.js');
const mkPage = (id) => ({ id, goto: async () => {}, content: async () => '', waitForSelector: async () => {}, close: async () => {},
  evaluate: async (a) => (typeof a === 'function' && a.name === 'parseSerpPage' ? { slots: [], resultCount: null } : undefined) });

const run = async (nKw, maxPages, threshold) => {
  let renews = 0, msgs = [];
  await new Promise((done) => runAsUser({ name: 'zz-rc', role: 'member' }, async () => {
    await runBatch({ page: mkPage(0), asin: 'B0TESTAAAA',
      keywords: Array.from({ length: nKw }, (_, i) => 'kw' + i),
      opts: { maxPages, dateKey: 'C', adsScan: false, recycleAfterPages: threshold },
      log: (m) => { if (m.includes('♻️')) msgs.push(m.trim()); }, shouldStop: () => false,
      renewPage: async () => { renews++; return mkPage(renews); } });
    done();
  }));
  const total = nKw * maxPages;
  console.log(`  ${nKw} kw × ${maxPages} trang = ${total} trang · ngưỡng ${threshold} → làm mới ${renews} lần (kỳ vọng ${Math.floor((total - maxPages) / threshold)})`);
  msgs.forEach(m => console.log('     ' + m));
};
await run(40, 3, 60);   // 120 trang, ngưỡng 60
await run(10, 3, 400);  // 30 trang — dưới ngưỡng, không được làm mới
await run(200, 3, 400); // giống thực tế: 600 trang, ngưỡng mặc định
