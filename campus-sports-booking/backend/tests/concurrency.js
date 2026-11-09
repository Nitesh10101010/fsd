const base = process.env.API_URL || 'http://localhost:5000';
const token1 = process.env.USER1_TOKEN;
const token2 = process.env.USER2_TOKEN;
const slotId = Number(process.env.SLOT_ID);
if (!token1 || !token2 || !slotId) {
  console.error('Set USER1_TOKEN, USER2_TOKEN and SLOT_ID.');
  process.exit(1);
}
const send = token => fetch(`${base}/api/bookings`, {
  method:'POST',
  headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},
  body:JSON.stringify({slotId,purpose:'Concurrency acceptance test'})
});
const results = await Promise.all([send(token1),send(token2)]);
const bodies = await Promise.all(results.map(r=>r.json()));
console.log(results.map((r,i)=>({request:i+1,status:r.status,body:bodies[i]})));
const success = results.filter(r=>r.status===201).length;
const conflict = results.filter(r=>r.status===409).length;
if (success !== 1 || conflict !== 1) {
  console.error('FAIL: expected exactly one 201 and one 409.');
  process.exit(1);
}
console.log('PASS: exactly one request succeeded and one was rejected.');
